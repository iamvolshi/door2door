import { logger } from '../core/logger';
import type { RedactionCounts, RetentionRepository } from '../db/repositories';
import { REDACTED_CLIENT_DATA } from './pii';

/**
 * How long the address a client connected from — and the device string recorded beside it
 * — may be kept before it is replaced.
 *
 * The rows stay; only the identifying two fields go. Ninety days is deliberately longer
 * than the 30-day OTP delivery trail (`src/auth/otpDeliveryLog.ts`), because these are the
 * records a security review reads months later: which login rotated into which, where a
 * session was opened from, what an administrator's decision was recorded against.
 */
export const DEFAULT_PII_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How often the sweep may run within one process. The work is small (three indexed
 * updates) but it is housekeeping, so it rides along with traffic the way the other
 * retention jobs do rather than needing a scheduler.
 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface ClientAddressRetentionOptions {
  repo: RetentionRepository;
  /** Overridable for tests and for `PII_RETENTION_DAYS`. */
  retentionDays?: number;
  /** Overridable for tests. */
  sweepIntervalMs?: number;
}

/**
 * Replaces the client address and device string on records past their retention window.
 *
 * The effect of a sweep is deliberately one-way and unlogged-as-an-event: the fields are
 * what is being removed, so a permanent record of *whose* address was there would defeat
 * the exercise. What is logged is the count, so an operator can see that the control ran
 * and how much it touched.
 *
 * Best effort by construction: a failure must never fail a login.
 */
export class ClientAddressRetention {
  private readonly retentionMs: number;
  private readonly sweepIntervalMs: number;
  private lastSweepAt: number | null = null;

  constructor(private readonly options: ClientAddressRetentionOptions) {
    this.retentionMs = (options.retentionDays ?? DEFAULT_PII_RETENTION_DAYS) * DAY_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  }

  /**
   * Sweeps at most once per interval. Returns null when the sweep was not due, or when it
   * ran but failed. Never throws.
   */
  public async sweepIfDue(now: number = Date.now()): Promise<RedactionCounts | null> {
    if (this.lastSweepAt !== null && now - this.lastSweepAt < this.sweepIntervalMs) {
      return null;
    }
    // Claimed before the work starts, so concurrent callers in this process cannot both
    // run the same three statements.
    this.lastSweepAt = now;
    return this.sweep(now);
  }

  /** Sweeps regardless of the interval. Never throws. */
  public async sweep(now: number = Date.now()): Promise<RedactionCounts | null> {
    try {
      const counts = await this.options.repo.redactClientDataBefore(
        new Date(now - this.retentionMs).toISOString(),
        new Date(now).toISOString(),
        REDACTED_CLIENT_DATA
      );

      const total = counts.sessions + counts.auditLogs + counts.otpDeliveries;
      if (total > 0) {
        logger.info('Redacted client addresses past their retention window', {
          retentionDays: this.retentionMs / DAY_MS,
          ...counts
        });
      }
      return counts;
    } catch (error) {
      logger.error('Failed to redact client addresses past their retention window', error);
      return null;
    }
  }
}
