import * as crypto from 'crypto';
import { logger } from '../core/logger';
import type { RateLimitCounter, RateLimitRepository } from '../db/repositories';

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  /**
   * The session this client's current window is already attributed to, or null when it is not
   * attributed to one yet.
   *
   * Returned so the caller can decide whether this request's session still has to be written:
   * the count has to happen before authentication (a flood is refused before it can cost a
   * token check), so the row is stamped afterwards, and this is the value that makes that
   * second write happen once per device per window rather than once per request.
   */
  sessionId: string | null;
}

export interface DatabaseRateLimiterOptions {
  repo: RateLimitRepository;
  /** Requests allowed per client per window. */
  max: number;
  windowMs: number;
  /** Keys the counter; see `keyFor`. */
  secret: string;
  /** How often closed windows are swept. Overridable for tests. */
  pruneIntervalMs?: number;
}

/** Counters whose window has closed are worthless, so they are swept as traffic flows. */
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Bounds request rates per client address, with the counter in the database.
 *
 * The limit used to be counted in the memory of whichever process served the request, so
 * `RATE_LIMIT_MAX` was really "per process": two processes serving the same customers
 * allowed twice the configured burst from one address, three allowed three times, and a
 * restart forgot the window entirely. The counter is now a row keyed by the client, and
 * the increment is a single atomic statement, so the number in the configuration is the
 * number the deployment enforces. It is also what makes the login limiter and the generic
 * limiter agree: the resend cooldown was already database-enforced, and this closes the
 * gap beside it.
 *
 * Two costs are worth naming. Every counted request is now a database write — 0.78 ms
 * measured against the pilot's SQLite store, where the in-process map cost microseconds —
 * which is the price of a count two processes share, and the ceiling to watch as traffic
 * grows. And the window is still fixed, anchored
 * to the first request that opened it, so a client can spend its allowance at the end of
 * one window and again at the start of the next; that boundary burst is unchanged, and
 * closing it would need a sliding window rather than a durable one.
 */
export class DatabaseRateLimiter {
  private readonly repo: RateLimitRepository;
  private readonly max: number;
  private readonly windowMs: number;
  private readonly secret: string;
  private readonly pruneIntervalMs: number;
  private lastPruneAt: number | null = null;
  private warnedUnavailable = false;

  /**
   * How many requests one client has sent in its current window.
   *
   * The count is a row in the database, so this read goes back to the shared counter
   * instead of asking a process for its own partial total: any process can ask, and
   * they all see the same number.
   */
  public async getCount(clientAddress: string, now: number = Date.now()): Promise<{ hits: number; windowStart: number } | null> {
    try {
      const result = await this.repo.querySingle<{ hits: number; windowStart: number }>(
        `SELECT hits, windowStart FROM request_rate_limits WHERE key = ? AND windowStart > ?`,
        [this.keyFor(clientAddress), now - this.windowMs]
      );
      if (!result) return null;
      return { hits: Number(result.hits), windowStart: Number(result.windowStart) };
    } catch (error) {
      this.reportUnavailable(error);
      return null;
    }
  }

  constructor(options: DatabaseRateLimiterOptions) {
    this.repo = options.repo;
    this.max = options.max;
    this.windowMs = options.windowMs;
    this.secret = options.secret;
    this.pruneIntervalMs = options.pruneIntervalMs ?? PRUNE_INTERVAL_MS;
  }

  /**
   * Counts one request from `clientAddress` and says whether it may proceed.
   *
   * Fails open. A counter that cannot be consulted means the database is unavailable, and
   * every route that needs data will say so on its own; turning that into a blanket `429`
   * would convert a database blip into a total outage, which is not what an abuse control
   * is for. The first failure is logged at error level and later ones are not, so the
   * condition is visible without one log line per request.
   */
  public async check(clientAddress: string, now: number = Date.now()): Promise<RateLimitDecision> {
    let counter: RateLimitCounter;
    try {
      counter = await this.repo.count(this.keyFor(clientAddress), now, this.windowMs);
    } catch (error) {
      this.reportUnavailable(error);
      // Nothing was counted, so nothing is attributed: null says "this row says nothing", and
      // the caller will try to name the session on a row that, for now, may not exist.
      return { allowed: true, retryAfterSeconds: 0, sessionId: null };
    }

    const decision: RateLimitDecision =
      counter.hits <= this.max
        ? { allowed: true, retryAfterSeconds: 0, sessionId: counter.sessionId }
        : {
            allowed: false,
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((counter.windowStart + this.windowMs - now) / 1000)
            ),
            sessionId: counter.sessionId
          };

    await this.pruneIfDue(now);
    return decision;
  }

  /**
   * Records which session is behind the requests this client is being counted for.
   *
   * Called once a request has proved which session it belongs to, which is necessarily after
   * the count itself: the limiter runs before authentication, so that an unauthenticated flood
   * is refused before it costs a token check, and the attribution follows. Best effort and
   * never thrown, for the same reason the limiter fails open — a database that cannot name the
   * session must not turn an authenticated request into an error, and the audit trail already
   * carries the session for everything the request went on to do.
   */
  public async recordSession(
    clientAddress: string,
    sessionId: string,
    now: number = Date.now()
  ): Promise<boolean> {
    try {
      return await this.repo.recordSession(
        this.keyFor(clientAddress),
        sessionId,
        now - this.windowMs
      );
    } catch (error) {
      this.reportUnavailable(error);
      return false;
    }
  }

  /** Drops counters whose window has closed. Never throws. */
  public async prune(now: number = Date.now()): Promise<number> {
    try {
      return await this.repo.pruneClosedWindows(now - this.windowMs);
    } catch (error) {
      logger.warn('Could not prune closed rate-limit windows', { error });
      return 0;
    }
  }

  /**
   * The row this client is counted in: a keyed digest of its address, never the address.
   *
   * The counter only has to recognise the same client again, and this table is written by
   * every request, so it is the last place that should hold where customers live. Deriving
   * the key from a shared secret is what makes it the *same* key in every process — a
   * random per-process salt would hand each process its own counter and bring back the
   * multiplication this replaces. Rotating the secret starts every window again, which is
   * harmless: the worst it can do is give a client a fresh allowance once.
   */
  private keyFor(clientAddress: string): string {
    return crypto.createHmac('sha256', this.secret).update(clientAddress).digest('hex').slice(0, 32);
  }

  private async pruneIfDue(now: number): Promise<void> {
    if (this.lastPruneAt !== null && now - this.lastPruneAt < this.pruneIntervalMs) return;
    this.lastPruneAt = now;
    await this.prune(now);
  }

  private reportUnavailable(error: unknown): void {
    if (this.warnedUnavailable) return;
    this.warnedUnavailable = true;
    logger.error('Rate limit counter unavailable; requests are being allowed uncounted', error);
  }
}
