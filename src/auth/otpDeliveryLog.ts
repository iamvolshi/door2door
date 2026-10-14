import * as crypto from 'crypto';
import { logger } from '../core/logger';
import type { OtpDeliveryRecord } from '../db/schema';
import type { OtpDeliveryRepository } from '../db/repositories';

/**
 * How long dispatch attempts are kept. Long enough to investigate a complaint that
 * arrived days later, short enough that the table does not grow without bound; the
 * prune rides along with the next login rather than needing a scheduler.
 */
export const OTP_DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Everything a dispatch (or its absence) tells us about one OTP SMS. */
export interface OtpDeliveryAttempt {
  phone: string;
  provider: string;
  delivered: boolean;
  providerStatus?: string;
  failureCode?: string;
  failureReason?: string;
  messageId?: string;
  attempts?: number;
  latencyMs?: number;
  requestId?: string;
  ipAddress?: string;
}

/**
 * Writes the OTP SMS attempt trail.
 *
 * Recording is deliberately best-effort: by the time a row is written the message may
 * already be on its way, so a database hiccup must not fail the login or trigger a
 * second send (the resend cooldown would block the retry anyway). A failure here is
 * logged at error level and never thrown.
 */
export class OtpDeliveryLog {
  constructor(
    private readonly repo: OtpDeliveryRepository,
    private readonly retentionMs: number = OTP_DELIVERY_RETENTION_MS
  ) {}

  /** Records one attempt. Never throws. */
  public async record(attempt: OtpDeliveryAttempt): Promise<OtpDeliveryRecord | null> {
    const id = `otpd_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    try {
      return await this.repo.create({
        id,
        phone: attempt.phone,
        provider: attempt.provider,
        delivered: attempt.delivered,
        providerStatus: attempt.providerStatus ?? null,
        failureCode: attempt.failureCode ?? null,
        failureReason: attempt.failureReason ?? null,
        messageId: attempt.messageId ?? null,
        attempts: attempt.attempts ?? 0,
        latencyMs: attempt.latencyMs ?? null,
        requestId: attempt.requestId ?? null,
        ipAddress: attempt.ipAddress ?? null
      });
    } catch (error) {
      logger.error('Failed to record OTP delivery attempt', error, {
        phone: attempt.phone,
        provider: attempt.provider,
        delivered: attempt.delivered,
        deliveryId: id
      });
      return null;
    }
  }

  /** Drops attempts past the retention window. Never throws. */
  public async prune(now: number = Date.now()): Promise<number> {
    try {
      return await this.repo.pruneBefore(new Date(now - this.retentionMs).toISOString());
    } catch (error) {
      logger.error('Failed to prune OTP delivery attempts', error);
      return 0;
    }
  }
}
