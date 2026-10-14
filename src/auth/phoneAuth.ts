import * as crypto from 'crypto';
import { env } from '../config/env';
import { RateLimitError, ValidationError } from '../core/errors';
import { logger } from '../core/logger';
import { MemoryOtpStore, type OtpChallengeRecord, type OtpStore } from './otpStore';

/**
 * One number's login state, as an operator sees it: what is throttling it and whether a code
 * is live. No code and no hash — the hash is a credential's fingerprint, keyed with a server
 * secret, and it is not an operator's business.
 */
export interface OtpChallengeStatus {
  phone: string;
  /** False for a number that has never asked for a code, which is not an error. */
  hasChallenge: boolean;
  attempts: number;
  maxAttempts: number;
  /** The wrong guesses have retired the live code, which is what a lockout means here. */
  lockedOut: boolean;
  /** A code is on file, unexpired and unretired, so it can still be typed in. */
  codeLive: boolean;
  /** When the live code stops working; `null` when there is none. */
  expiresAt: string | null;
  lastSentAt: string | null;
  /** When a resend becomes possible again; `null` when one is allowed now. */
  resendAllowedAt: string | null;
  secondsUntilResend: number;
}

export interface PhoneAuthOptions {
  otpLength?: number;
  otpValiditySeconds?: number;
  cooldownSeconds?: number;
  maxAttempts?: number;
  /** Challenge persistence. Defaults to process memory; the server injects a database store. */
  store?: OtpStore;
  /**
   * Server-side key for stored code hashes. Defaults to the configured encryption key,
   * which production refuses to boot without (see `assertSecureProductionConfig`).
   */
  hashSecret?: string;
}

/**
 * How long a challenge row is kept after its last activity. The cooldown only needs
 * seconds, but a row is also the record that a number asked for a code, so it is kept
 * long enough to be useful in an investigation and then pruned opportunistically.
 */
export const CHALLENGE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Formats and normalizes Bangladeshi phone numbers into E.164 standard (+8801XXXXXXXXX).
 *
 * Only Bangladeshi numbers are accepted. An earlier revision also took any plausible
 * international number, which meant an unauthenticated caller could choose the number the
 * platform paid to text; the API reference has always said Bangladeshi, and every account
 * on the platform is one. Widening this again is a deliberate act, not a side effect.
 */
export function normalizePhoneNumber(phone: string): string {
  if (!phone || typeof phone !== 'string') {
    throw new ValidationError('Phone number is required');
  }

  const cleaned = phone.replace(/[\s\-\(\)]/g, '');

  if (/^\+8801[3-9]\d{8}$/.test(cleaned)) {
    return cleaned;
  }
  if (/^8801[3-9]\d{8}$/.test(cleaned)) {
    return `+${cleaned}`;
  }
  if (/^01[3-9]\d{8}$/.test(cleaned)) {
    return `+88${cleaned}`;
  }

  throw new ValidationError(`Invalid phone number format: ${phone}`);
}

export class PhoneAuthService {
  private readonly store: OtpStore;
  private readonly otpLength: number;
  private readonly otpValiditySeconds: number;
  private readonly cooldownSeconds: number;
  private readonly maxAttempts: number;
  private readonly hashSecret: string;

  constructor(options: PhoneAuthOptions = {}) {
    this.store = options.store ?? new MemoryOtpStore();
    this.otpLength = options.otpLength || 6;
    this.otpValiditySeconds = options.otpValiditySeconds || 300; // 5 mins
    this.cooldownSeconds = options.cooldownSeconds || 60; // 1 min
    this.maxAttempts = options.maxAttempts || 3;
    this.hashSecret = options.hashSecret ?? env.ENCRYPTION_KEY;
  }

  /**
   * Keyed with a server secret *and* the phone number. The number alone is public, so a
   * hash keyed by it can be matched against a live six-digit code in milliseconds by
   * anyone holding the row — a database file, a backup, a replica. With the secret in the
   * key, that offline search is out of reach without also holding the configuration.
   */
  private hashOtp(otp: string, phone: string): string {
    return crypto.createHmac('sha256', `${this.hashSecret}:${phone}`).update(otp).digest('hex');
  }

  /**
   * Generates a numeric OTP string.
   */
  public generateNumericOtp(): string {
    const digits = '0123456789';
    let otp = '';
    const randomBytes = crypto.randomBytes(this.otpLength);
    for (let i = 0; i < this.otpLength; i++) {
      otp += digits[randomBytes[i] % 10];
    }
    return otp;
  }

  /**
   * Requests an OTP dispatch with rate limiting.
   * Returns the generated OTP (for SMS provider integration / testing).
   *
   * The cooldown is claimed in the store rather than read into this process, so a second
   * server process — or the same one after a restart — sees the same limit, and two
   * processes cannot both issue a code for one number.
   */
  public async requestOtp(rawPhone: string): Promise<{ phone: string; otp: string; expiresInSeconds: number }> {
    const phone = normalizePhoneNumber(rawPhone);
    const now = Date.now();
    const otp = this.generateNumericOtp();

    const claimed = await this.store.claimResend({
      phone,
      otpHash: this.hashOtp(otp, phone),
      expiresAt: now + this.otpValiditySeconds * 1000,
      lastSentAt: now,
      cooldownCutoff: now - this.cooldownSeconds * 1000
    });

    if (!claimed) {
      const record = await this.store.get(phone);
      const waitSeconds = record
        ? Math.max(1, Math.ceil((record.lastSentAt + this.cooldownSeconds * 1000 - now) / 1000))
        : this.cooldownSeconds;
      // The wait is data, not just prose: the response also carries it as
      // `details.retryAfterSeconds` (and the `Retry-After` header), so a mobile client
      // can arm its resend timer without parsing the message.
      throw new RateLimitError(`Please wait ${waitSeconds}s before requesting a new OTP`, {
        retryAfterSeconds: waitSeconds
      });
    }

    await this.store.prune(now - CHALLENGE_RETENTION_MS);

    logger.info('Phone OTP generated', { phone, expiresAt: now + this.otpValiditySeconds * 1000 });
    return { phone, otp, expiresInSeconds: this.otpValiditySeconds };
  }

  /**
   * Verifies an OTP code against the stored challenge.
   *
   * `consume: false` validates the code without retiring it, which lets the login flow
   * tell an unregistered phone "the code is right, now register" and lets that same code
   * authorise one registration attempt. Logins consume the code, so it stays single-use —
   * and the consumption is a conditional update, so it holds across processes too.
   */
  public async verifyOtp(
    rawPhone: string,
    inputOtp: string,
    options: { consume?: boolean } = {}
  ): Promise<boolean> {
    const consume = options.consume ?? true;
    const phone = normalizePhoneNumber(rawPhone);
    const now = Date.now();
    const record = await this.store.get(phone);

    if (!record || record.otpHash === null) {
      throw new ValidationError('No active OTP request found for this phone number');
    }

    if (now > record.expiresAt) {
      await this.store.invalidateCode(phone);
      throw new ValidationError('OTP has expired. Please request a new one');
    }

    const inputHash = this.hashOtp(inputOtp, phone);
    const isValid = crypto.timingSafeEqual(
      Buffer.from(inputHash, 'hex'),
      Buffer.from(record.otpHash, 'hex')
    );

    if (isValid) {
      if (consume) {
        await this.store.consumeCode(phone, record.otpHash);
      }
      return true;
    }

    // Only wrong guesses count towards the lockout. A caller who proved the code and then
    // failed form validation in a later step must not be locked out for it.
    const attempts = await this.store.registerFailedAttempt(phone);
    if (attempts > this.maxAttempts) {
      await this.store.invalidateCode(phone);
      throw new RateLimitError('Too many failed attempts. OTP has been invalidated');
    }

    return false;
  }

  /** Reads one number's login state, for a caller that is not trying to sign in. */
  public async describeChallenge(rawPhone: string): Promise<OtpChallengeStatus> {
    const phone = normalizePhoneNumber(rawPhone);
    return this.toStatus(phone, await this.store.get(phone), Date.now());
  }

  /**
   * Lifts the resend cooldown on a number, so the next request may issue a code at once.
   *
   * This is the help-desk lever for a stuck login: the cooldown is the only thing standing
   * between a customer who is on the phone and a fresh code, and it cannot be waited out on
   * somebody else's behalf. Nothing else about the challenge moves — the code already in the
   * customer's hand stays valid, and their wrong guesses stay counted until a new code
   * starts — so lifting the wait cannot quietly sign anybody in.
   *
   * Returns the state as it was found, because what was actually cleared is the answer an
   * operator has to give: a number with no cooldown running did not need this.
   */
  public async releaseCooldown(
    rawPhone: string
  ): Promise<{ before: OtpChallengeStatus; released: boolean }> {
    const phone = normalizePhoneNumber(rawPhone);
    const now = Date.now();
    const before = this.toStatus(phone, await this.store.get(phone), now);
    const released = await this.store.releaseCooldown(
      phone,
      now - this.cooldownSeconds * 1000
    );
    return { before, released };
  }

  /** Derives the operator-facing state from the stored record. */
  private toStatus(
    phone: string,
    record: OtpChallengeRecord | null,
    now: number
  ): OtpChallengeStatus {
    if (!record) {
      return {
        phone,
        hasChallenge: false,
        attempts: 0,
        maxAttempts: this.maxAttempts,
        lockedOut: false,
        codeLive: false,
        expiresAt: null,
        lastSentAt: null,
        resendAllowedAt: null,
        secondsUntilResend: 0
      };
    }

    const cooldownEndsAt = record.lastSentAt + this.cooldownSeconds * 1000;
    const remainingMs = cooldownEndsAt - now;
    const codeOnFile = record.otpHash !== null && now <= record.expiresAt;

    return {
      phone,
      hasChallenge: true,
      attempts: record.attempts,
      maxAttempts: this.maxAttempts,
      lockedOut: record.attempts > this.maxAttempts,
      codeLive: codeOnFile,
      // Only a code that can still be typed has an expiry worth reporting; a retired one is
      // gone, whatever time its row still carries.
      expiresAt: codeOnFile ? new Date(record.expiresAt).toISOString() : null,
      lastSentAt: new Date(record.lastSentAt).toISOString(),
      resendAllowedAt: remainingMs > 0 ? new Date(cooldownEndsAt).toISOString() : null,
      secondsUntilResend: remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0
    };
  }

  public async clear(): Promise<void> {
    await this.store.clear();
  }
}

/** The default service, keyed with the configured secret. */
export const phoneAuth = new PhoneAuthService();
