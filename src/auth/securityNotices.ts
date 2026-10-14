import * as crypto from 'node:crypto';
import { logger } from '../core/logger';
import type { DatabaseClient } from '../db/client';
import { AuditLogRepository, NotificationRepository } from '../db/repositories';
import { getOtpDeliveryStatus, type OtpDeliveryStatus } from './otpDelivery';
import { createSmsClientFromEnv, maskPhone, type SmsProviderClient } from './smsProviders';

/**
 * Security notices sent to the account holder.
 *
 * A notice is raised whenever something happens to an account that its owner would want to
 * know about and might not have done themselves: a session family burned by a replayed
 * token, a registration an administrator refused, an account suspended, a phone number that
 * has just had an account created on it. Each one travels on two channels. The durable one
 * is a row in the account's own notice list (`SecurityNoticeInbox`), written before the
 * response that caused it leaves the process, so the warning survives a handset that cannot
 * be reached, a provider that is not configured, and a gateway that is simply down. The
 * out-of-band one is an SMS through the same provider and credential as login codes, because
 * the phone number is the only contact detail the platform really has: every account signs in
 * by OTP, and accounts with no email of their own are stored with a placeholder address that
 * delivers nothing (see `placeholderEmail`). A notice that nobody can receive is worse than
 * no notice, so each channel's outcome is reported and recorded rather than assumed.
 */
export interface SecurityNoticeResult {
  /** True only when the provider accepted the message for delivery. */
  delivered: boolean;
  provider: string;
  reason?: string;
  code?: string;
  providerStatus?: string;
  messageId?: string;
  attempts?: number;
  latencyMs?: number;
}

/**
 * The vocabulary of notices. Each value is a distinct thing that happened to an account, and
 * a client renders the list from `title` and `body` rather than parsing either.
 */
export type SecurityNoticeType =
  | 'SESSION_REVOKED'
  | 'REGISTRATION_REJECTED'
  | 'ACCOUNT_SUSPENDED'
  | 'PHONE_CLAIMED';

/**
 * What the owner is told when a spent refresh token is presented again. Kept short enough
 * to travel as a single SMS segment, and deliberately free of codes, links and names: it
 * should read as a warning that needs no action beyond signing in again.
 */
export const SESSION_REVOKED_MESSAGE =
  "Your Cox's Bazar Door2Door session was ended: a sign-in token was used twice. If this wasn't you, someone has your token. Sign in again.";

export function formatSessionRevokedMessage(): string {
  return SESSION_REVOKED_MESSAGE;
}

/**
 * The in-app headline for the same incident: what happened, without repeating the body's
 * instruction. The list renders the two together.
 */
export const SESSION_REVOKED_TITLE = 'Your session was ended for your protection';

/**
 * The wording of every notice, in one place, because the two channels must not be able to
 * drift into telling the owner different things. Bodies stay within a single SMS segment
 * (tests/securityNoticeEvents.test.ts holds them to it); the reason an administrator gave
 * is never part of the wording, only of the record beside it.
 */
export const SECURITY_NOTICE_COPY: Record<SecurityNoticeType, { title: string; body: string }> = {
  SESSION_REVOKED: {
    title: SESSION_REVOKED_TITLE,
    body: SESSION_REVOKED_MESSAGE
  },
  REGISTRATION_REJECTED: {
    title: 'Your registration was not approved',
    body: "Your Cox's Bazar Door2Door registration was not approved. If you did not apply, contact support."
  },
  ACCOUNT_SUSPENDED: {
    title: 'Your account was suspended',
    body: "Your Cox's Bazar Door2Door account was suspended. Contact support if you think this is a mistake."
  },
  PHONE_CLAIMED: {
    title: 'An account was created for your number',
    body: "An account was created for this phone number on Cox's Bazar Door2Door. If this wasn't you, contact support."
  }
};

/**
 * One notice: what happened, to whom, and the facts an investigation would want.
 *
 * `context` is recorded beside the notice and never rendered: the list has to stay readable
 * without session ids, and an administrator's rejection reason is not something to put in a
 * text message.
 */
export interface SecurityNotice {
  type: SecurityNoticeType;
  userId: string;
  phone: string;
  /** JSON-serializable facts about the incident, or null when there are none worth keeping. */
  context?: Record<string, unknown> | null;
  /**
   * The stored notice this attempt belongs to, filled in by `SecurityNoticeService` once the
   * durable write has succeeded. It is what lets the outcome be written back onto that
   * notice, so an operator reading the list can see whether the owner was ever reached
   * without reconstructing it from the audit trail.
   */
  noticeId?: string;
}

/**
 * The out-of-band channel. Today the only implementation is SMS; a new channel is a new
 * implementation, and nothing about the durable half or the operator view changes with it.
 */
export interface SecurityNoticeSender {
  deliver(notice: SecurityNotice): Promise<SecurityNoticeResult>;
}

export interface SmsSecurityNoticeSenderOptions {
  /** Overridable for tests; defaults to building a client from the environment. */
  createClient?: () => SmsProviderClient | null;
  /** Overridable for tests; defaults to the validated environment configuration. */
  status?: () => OtpDeliveryStatus;
}

/**
 * Sends a notice by SMS, and records what the gateway said.
 *
 * Delivery is best effort by construction: by the time this runs the incident has already
 * happened and the durable copy is already written, so a notice that cannot be sent is
 * reported, not thrown — losing the warning must never turn into a failing request or a
 * rollback.
 */
export class SmsSecurityNoticeSender implements SecurityNoticeSender {
  private readonly auditRepo: AuditLogRepository;
  private readonly noticeRepo: NotificationRepository;
  private readonly createClient: () => SmsProviderClient | null;
  private readonly getStatus: () => OtpDeliveryStatus;

  constructor(client: DatabaseClient, options: SmsSecurityNoticeSenderOptions = {}) {
    this.auditRepo = new AuditLogRepository(client);
    this.noticeRepo = new NotificationRepository(client);
    this.createClient = options.createClient ?? createSmsClientFromEnv;
    this.getStatus = options.status ?? getOtpDeliveryStatus;
  }

  public async deliver(notice: SecurityNotice): Promise<SecurityNoticeResult> {
    let result: SecurityNoticeResult;

    try {
      result = await this.send(notice);
    } catch (error) {
      // The sender is not supposed to throw; if it does, the incident still stands and the
      // account holder simply was not reached.
      logger.error('Security notice could not be sent', error, {
        userId: notice.userId,
        type: notice.type,
        phone: maskPhone(notice.phone)
      });
      result = {
        delivered: false,
        provider: this.getStatus().provider || 'none',
        reason: error instanceof Error ? error.message : 'Security notice failed',
        code: 'NOTICE_SEND_ERROR'
      };
    }

    await this.record(notice, result);
    await this.recordOutcome(notice, result);
    return result;
  }

  /**
   * Stamps the attempt onto the notice it belongs to, which is what the operator list reads.
   *
   * Nothing here may fail the incident: the notice exists either way, and one without an
   * outcome is reported as `UNKNOWN` — which is the truth, rather than a delivery or a
   * failure that was never observed. A notice written before the link existed simply carries
   * no outcome either.
   */
  private async recordOutcome(notice: SecurityNotice, result: SecurityNoticeResult): Promise<void> {
    if (!notice.noticeId) return;

    try {
      await this.noticeRepo.recordOutOfBandOutcome(notice.noticeId, {
        state: result.delivered ? 'DELIVERED' : 'FAILED',
        detail: {
          channel: 'SMS',
          provider: result.provider,
          delivered: result.delivered,
          code: result.code ?? null,
          reason: result.reason ?? null,
          providerStatus: result.providerStatus ?? null,
          messageId: result.messageId ?? null,
          attempts: result.attempts ?? null,
          latencyMs: result.latencyMs ?? null,
          attemptedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      logger.error('Could not record the outcome of a security notice', error, {
        userId: notice.userId,
        type: notice.type,
        noticeId: notice.noticeId
      });
    }
  }

  private async send(notice: SecurityNotice): Promise<SecurityNoticeResult> {
    const status = this.getStatus();

    // Nothing is configured (or delivery is simulated): say so plainly rather than building
    // a client that cannot work and reporting a send that never happened.
    if (status.mockMode || status.provider === '' || status.provider === 'none') {
      const reason = status.reason ?? 'SMS_MOCK_MODE is enabled';
      logger.warn('Security notice generated but not sent', {
        userId: notice.userId,
        type: notice.type,
        provider: status.provider || 'none',
        phone: maskPhone(notice.phone),
        reason
      });
      return {
        delivered: false,
        provider: status.provider || 'none',
        reason,
        code: 'SMS_NOT_SENT',
        attempts: 0
      };
    }

    const client = this.createClient();
    if (!client) {
      const reason = status.reason ?? 'No SMS client could be built';
      logger.error('Security notice not sent: no usable SMS client', undefined, {
        userId: notice.userId,
        type: notice.type,
        provider: status.provider,
        phone: maskPhone(notice.phone),
        reason
      });
      return {
        delivered: false,
        provider: status.provider,
        reason,
        code: 'SMS_CLIENT_UNAVAILABLE',
        attempts: 0
      };
    }

    const sent = await client.send(notice.phone, SECURITY_NOTICE_COPY[notice.type].body);

    if (sent.delivered) {
      logger.info('Security notice dispatched', {
        userId: notice.userId,
        type: notice.type,
        provider: sent.provider,
        phone: maskPhone(notice.phone),
        messageId: sent.messageId,
        providerStatus: sent.providerStatus,
        attempts: sent.attempts,
        latencyMs: sent.latencyMs
      });
    } else {
      logger.error('Security notice delivery failed', undefined, {
        userId: notice.userId,
        type: notice.type,
        provider: sent.provider,
        phone: maskPhone(notice.phone),
        code: sent.code,
        reason: sent.reason,
        attempts: sent.attempts,
        latencyMs: sent.latencyMs
      });
    }

    return {
      delivered: sent.delivered,
      provider: sent.provider,
      reason: sent.reason,
      code: sent.code,
      providerStatus: sent.providerStatus,
      messageId: sent.messageId,
      attempts: sent.attempts,
      latencyMs: sent.latencyMs
    };
  }

  /**
   * A notice is a fact about an incident, so it gets its own audit row instead of being
   * folded into the incident itself: whether the owner was reached is answerable later,
   * and a missing row says the notice never even got as far as an attempt.
   */
  private async record(notice: SecurityNotice, result: SecurityNoticeResult): Promise<void> {
    try {
      await this.auditRepo.log({
        id: `aud_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
        userId: notice.userId,
        action: result.delivered ? 'SECURITY_NOTICE_SENT' : 'SECURITY_NOTICE_FAILED',
        entityType: 'USER',
        entityId: notice.userId,
        oldValues: JSON.stringify({ type: notice.type, ...(notice.context ?? {}) }),
        newValues: JSON.stringify({
          type: notice.type,
          channel: 'SMS',
          provider: result.provider,
          delivered: result.delivered,
          code: result.code ?? null,
          reason: result.reason ?? null,
          providerStatus: result.providerStatus ?? null,
          messageId: result.messageId ?? null
        }),
        ipAddress: null,
        userAgent: null
      });
    } catch (error) {
      logger.error('Failed to record a security notice', error, { userId: notice.userId });
    }
  }
}

/**
 * The durable half of a security notice: a row in the account's own list, which the owner
 * reads after signing in.
 *
 * This is the channel that depends on nothing outside the platform — no handset, no text
 * message budget, no gateway that has to be up — so it is the one that still delivers the
 * warning when the SMS could not be sent at all. It is written from the incident path
 * rather than from the background send: the notice is on record before the response leaves
 * the process, so a process killed mid-send loses only the SMS. It is still best effort in
 * the sense that matters for the incident: a row that cannot be written is logged and
 * reported as `null`, and the SMS attempt goes ahead regardless.
 */
export class SecurityNoticeInbox {
  private readonly repo: NotificationRepository;

  constructor(client: DatabaseClient) {
    this.repo = new NotificationRepository(client);
  }

  /** Stores the notice, answering with its row id, or `null` when it could not be written. */
  public async record(notice: SecurityNotice): Promise<string | null> {
    const noticeId = `ntf_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const copy = SECURITY_NOTICE_COPY[notice.type];

    try {
      await this.repo.create({
        id: noticeId,
        userId: notice.userId,
        type: notice.type,
        title: copy.title,
        body: copy.body,
        // The incident the notice belongs to, kept apart from the wording so the list is
        // readable without the ids and an investigation can still find them.
        details: JSON.stringify({ type: notice.type, ...(notice.context ?? {}) })
      });

      logger.info('Security notice stored for the account holder', {
        userId: notice.userId,
        noticeId,
        type: notice.type
      });
      return noticeId;
    } catch (error) {
      // The incident has already happened by the time this runs — a burned session, a
      // rejected application, a suspended account, a claimed number — and the caller is
      // usually mid-response. A notice list that could not be written is worth an error
      // line, never a failing request.
      logger.error('Could not store a security notice for the account holder', error, {
        userId: notice.userId,
        type: notice.type
      });
      return null;
    }
  }
}

/**
 * Notices in flight. Every caller answers its own request immediately and lets the warning
 * go out afterwards, so a provider that takes seconds to answer never becomes a slow
 * response — and a caller that needs to know the warning went out (a test, or the process on
 * its way down) can wait for it.
 */
const inFlight = new Set<Promise<void>>();

function deliverInBackground(sender: SecurityNoticeSender, notice: SecurityNotice): void {
  const pending = sender
    .deliver(notice)
    .then(() => undefined)
    .catch((error: unknown) => {
      logger.error('Security notice failed unexpectedly', error, {
        userId: notice.userId,
        type: notice.type
      });
    })
    .finally(() => {
      inFlight.delete(pending);
    });

  inFlight.add(pending);
}

/** Waits for every notice still being sent. Safe to call when there are none. */
export async function settleSecurityNotices(): Promise<void> {
  await Promise.allSettled([...inFlight]);
}

export interface SecurityNoticeServiceOptions {
  /** Overridable for tests; defaults to the account's own notice list. */
  inbox?: SecurityNoticeInbox;
  /** Overridable for tests; defaults to the configured SMS gateway. */
  sender?: SecurityNoticeSender;
}

/**
 * The one way a notice is raised: durably first, out of band second.
 *
 * The order is the point, and it is why this is a class rather than a helper at each call
 * site. The durable write is awaited, so it has happened before the caller answers — which
 * matters most for the session-revoked notice, where the response is a `401` that signs the
 * owner out of the very device that would have received the text. The out-of-band attempt is
 * scheduled afterwards and never awaited, so no request waits on a gateway.
 */
export class SecurityNoticeService {
  private readonly inbox: SecurityNoticeInbox;
  private readonly sender: SecurityNoticeSender;

  constructor(client: DatabaseClient, options: SecurityNoticeServiceOptions = {}) {
    this.inbox = options.inbox ?? new SecurityNoticeInbox(client);
    this.sender = options.sender ?? new SmsSecurityNoticeSender(client);
  }

  /** Records the notice and schedules its delivery. Returns the stored notice's id, if any. */
  public async raise(notice: SecurityNotice): Promise<string | null> {
    const noticeId = await this.inbox.record(notice);

    // The id travels with the attempt so the outcome can be stamped onto the same row; a
    // notice whose durable write failed has nothing to stamp, and is still worth sending.
    deliverInBackground(this.sender, noticeId === null ? notice : { ...notice, noticeId });
    return noticeId;
  }
}
