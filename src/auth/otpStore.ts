import type { DatabaseClient } from '../db/client';
import { isUniqueViolationError } from '../core/errors';

/**
 * One phone number's login state: the live code (if any) plus the two counters that
 * throttle it — when a code was last sent (resend cooldown) and how many wrong guesses
 * have been made since (lockout).
 *
 * Timestamps are epoch milliseconds.
 */
export interface OtpChallengeRecord {
  phone: string;
  /** HMAC of the live code. `null` once it was consumed, invalidated, or locked out. */
  otpHash: string | null;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
}

export interface ResendClaim {
  phone: string;
  otpHash: string;
  expiresAt: number;
  lastSentAt: number;
  /** A resend is allowed only when the stored `lastSentAt` is at or before this instant. */
  cooldownCutoff: number;
}

/**
 * Persistence boundary for phone-login state.
 *
 * The contract is written for a real SQL driver: `claimResend`, `registerFailedAttempt`
 * and `consumeCode` are single statements whose conditional `WHERE` clause is what makes
 * them safe when several server processes share one database. The in-memory
 * implementation exists for unit tests of the surrounding service and keeps the same
 * shape, but it cannot express those conditional updates.
 */
export interface OtpStore {
  /** The challenge for a phone, or null when no code was ever requested for it. */
  get(phone: string): Promise<OtpChallengeRecord | null>;
  /**
   * Atomically claims the right to send a new code, resetting the attempt counter.
   * Returns false when the cooldown is still running, which is how two processes racing
   * the same number cannot both issue a code.
   */
  claimResend(claim: ResendClaim): Promise<boolean>;
  /**
   * Clears the resend cooldown without touching the code the row holds: `lastSentAt` is
   * moved to `releasedTo`, which is far enough in the past that the next claim's cutoff
   * has elapsed. False when no row exists, which is the ordinary case for a number whose
   * code was never requested.
   *
   * Deliberately not a delete: the live code stays usable, and the row stays as the record
   * that this number asked for one. A help desk lifting a stuck cooldown must not invalidate
   * the code the customer already has in hand.
   */
  releaseCooldown(phone: string, releasedTo: number): Promise<boolean>;
  /** Records one wrong guess and returns the new attempt count. */
  registerFailedAttempt(phone: string): Promise<number>;
  /**
   * Retires the live code only when its hash still matches, so a code is usable exactly
   * once even if two processes verify it at the same moment. False means another caller
   * got there first.
   */
  consumeCode(phone: string, expectedHash: string): Promise<boolean>;
  /** Retires the live code unconditionally (expiry, lockout). */
  invalidateCode(phone: string): Promise<void>;
  /** Deletes challenge rows whose last activity predates the cutoff. Returns rows removed. */
  prune(cutoffMs: number): Promise<number>;
  /** Drops all state. Test helper. */
  clear(): Promise<void>;
}

/** Process-local store, kept for tests and for any single-process embedder. */
export class MemoryOtpStore implements OtpStore {
  private readonly challenges = new Map<string, OtpChallengeRecord>();

  async get(phone: string): Promise<OtpChallengeRecord | null> {
    const record = this.challenges.get(phone);
    return record ? { ...record } : null;
  }

  async claimResend(claim: ResendClaim): Promise<boolean> {
    const current = this.challenges.get(claim.phone);
    if (current && current.lastSentAt > claim.cooldownCutoff) {
      return false;
    }

    this.challenges.set(claim.phone, {
      phone: claim.phone,
      otpHash: claim.otpHash,
      expiresAt: claim.expiresAt,
      attempts: 0,
      lastSentAt: claim.lastSentAt
    });
    return true;
  }

  async releaseCooldown(phone: string, releasedTo: number): Promise<boolean> {
    const current = this.challenges.get(phone);
    if (!current) return false;
    current.lastSentAt = releasedTo;
    return true;
  }

  async registerFailedAttempt(phone: string): Promise<number> {
    const current = this.challenges.get(phone);
    if (!current) return 0;
    current.attempts += 1;
    return current.attempts;
  }

  async consumeCode(phone: string, expectedHash: string): Promise<boolean> {
    const current = this.challenges.get(phone);
    if (!current || current.otpHash !== expectedHash) return false;
    current.otpHash = null;
    return true;
  }

  async invalidateCode(phone: string): Promise<void> {
    const current = this.challenges.get(phone);
    if (current) current.otpHash = null;
  }

  async prune(cutoffMs: number): Promise<number> {
    let removed = 0;
    for (const [phone, record] of this.challenges) {
      if (record.lastSentAt < cutoffMs) {
        this.challenges.delete(phone);
        removed += 1;
      }
    }
    return removed;
  }

  async clear(): Promise<void> {
    this.challenges.clear();
  }
}

/**
 * Database-backed store: one row per phone number, shared by every server process.
 *
 * A resend is claimed by inserting the row for a number never seen before — the primary
 * key makes exactly one concurrent insert win — and otherwise by an update that only
 * matches while the cooldown has elapsed.
 */
export class DatabaseOtpStore implements OtpStore {
  constructor(private readonly client: DatabaseClient) {}

  async get(phone: string): Promise<OtpChallengeRecord | null> {
    const result = await this.client.query<OtpChallengeRecord>(
      `SELECT phone, otpHash, expiresAt, attempts, lastSentAt FROM otp_challenges WHERE phone = ?`,
      [phone]
    );
    return result.rows[0] ?? null;
  }

  async claimResend(claim: ResendClaim): Promise<boolean> {
    try {
      const inserted = await this.client.query(
        `INSERT INTO otp_challenges (phone, otpHash, expiresAt, attempts, lastSentAt) VALUES (?, ?, ?, ?, ?)`,
        [claim.phone, claim.otpHash, claim.expiresAt, 0, claim.lastSentAt]
      );
      return inserted.rowCount > 0;
    } catch (error) {
      // The row already exists, which is the ordinary case. Anything else is a real fault.
      if (!isUniqueViolation(error)) throw error;
    }

    const updated = await this.client.query(
      `UPDATE otp_challenges SET otpHash = ?, expiresAt = ?, attempts = ?, lastSentAt = ? WHERE phone = ? AND lastSentAt <= ?`,
      [claim.otpHash, claim.expiresAt, 0, claim.lastSentAt, claim.phone, claim.cooldownCutoff]
    );
    return updated.rowCount > 0;
  }

  async releaseCooldown(phone: string, releasedTo: number): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE otp_challenges SET lastSentAt = ? WHERE phone = ?`,
      [releasedTo, phone]
    );
    return result.rowCount > 0;
  }

  async registerFailedAttempt(phone: string): Promise<number> {
    await this.client.query(`UPDATE otp_challenges SET attempts = attempts + 1 WHERE phone = ?`, [phone]);
    const result = await this.client.query<{ attempts: number }>(
      `SELECT attempts FROM otp_challenges WHERE phone = ?`,
      [phone]
    );
    return result.rows[0]?.attempts ?? 0;
  }

  async consumeCode(phone: string, expectedHash: string): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE otp_challenges SET otpHash = ? WHERE phone = ? AND otpHash = ?`,
      [null, phone, expectedHash]
    );
    return result.rowCount > 0;
  }

  async invalidateCode(phone: string): Promise<void> {
    await this.client.query(`UPDATE otp_challenges SET otpHash = ? WHERE phone = ?`, [null, phone]);
  }

  async prune(cutoffMs: number): Promise<number> {
    const result = await this.client.query(`DELETE FROM otp_challenges WHERE lastSentAt < ?`, [cutoffMs]);
    return result.rowCount;
  }

  async clear(): Promise<void> {
    await this.client.query(`DELETE FROM otp_challenges`);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return isUniqueViolationError(error);
}
