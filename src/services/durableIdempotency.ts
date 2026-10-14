import { randomUUID } from 'node:crypto';
import { ConflictError, ValidationError } from '../core/errors';
import { logger } from '../core/logger';
import { IdempotencyService } from './idempotencyService';
import type { DatabaseClient } from '../db/client';
import { IdempotencyRepository } from '../db/repositories';
import type { IdempotencyKeyRecord } from '../db/schema';

/** Expired rows are only swept periodically, so placing an order is not a DELETE each. */
const SWEEP_INTERVAL_MS = 10 * 60_000;

export interface IdempotentOutcome<T> {
  /** True when this is the stored answer to an earlier identical request. */
  fromCache: boolean;
  status: number;
  body: T;
}

export interface IdempotentRequest {
  /** The client's `Idempotency-Key` header value. */
  key: string;
  /** The account the key belongs to; part of the stored key. */
  userId: string;
  /** The endpoint the key was used on; part of the stored key. */
  endpoint: string;
  /** The request's substance, hashed to catch a key reused for a different payload. */
  payload: unknown;
}

/**
 * Idempotency that lives in the database rather than in the process.
 *
 * The in-memory variant answered retries only for as long as the process that saw the
 * first attempt stayed alive, so a crash, a deploy or a second server instance turned a
 * client's retry into a second order. Here the key, the claim and the response are rows,
 * which is what lets the platform promise "the same request places one order" instead of
 * "at most one order per process".
 *
 * The claim, the work and the stored answer are written in **one transaction**, and that
 * is what makes the promise hold in the awkward cases. A process killed while placing an
 * order, an answer that cannot be written, a connection lost mid-request: the whole thing
 * rolls back, so the retry finds no key and places the order once, rather than finding a
 * key whose order already exists and placing it again. For the same reason the action must
 * be a database write belonging to this transaction — an external side effect (an SMS, a
 * payment call) could not be rolled back with it and does not belong here.
 *
 * The stored key is namespaced with the account and the endpoint, mirroring the composite
 * key the in-memory service used: two customers, or two endpoints, can use the same
 * `Idempotency-Key` value without ever colliding, and one customer can never be handed
 * another's stored response.
 */
export class DurableIdempotencyService {
  private readonly repo: IdempotencyRepository;
  private nextSweepAt = 0;

  constructor(
    private readonly client: DatabaseClient,
    private readonly ttlSeconds = 3600
  ) {
    this.repo = new IdempotencyRepository(client);
  }

  public async execute<T>(
    request: IdempotentRequest,
    action: () => Promise<{ status: number; body: T }>
  ): Promise<IdempotentOutcome<T>> {
    const rawKey = request.key;
    if (!rawKey || rawKey.trim() === '') {
      throw new ValidationError('Idempotency key must be provided');
    }

    const scopedKey = `${request.userId}:${request.endpoint}:${rawKey}`;
    const requestHash = IdempotencyService.hashPayload(request.payload);

    // A key that already has an answer is answered without taking the write lock, so a
    // client retrying an order it is unsure about does not queue behind the very order it
    // is retrying. Everything else happens inside the transaction below.
    const answered = await this.inspect<T>(scopedKey, rawKey, requestHash);
    if (answered) return answered;

    const outcome = await this.client.transaction(async (): Promise<IdempotentOutcome<T>> => {
      // Re-read under the write lock: another process may have finished in the meantime,
      // and a `BEGIN IMMEDIATE` transaction is what makes this read-then-claim safe.
      const stored = await this.inspect<T>(scopedKey, rawKey, requestHash);
      if (stored) return stored;

      const claimed = await this.repo.claim({
        id: `idem_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        idempotencyKey: scopedKey,
        userId: request.userId,
        endpoint: request.endpoint,
        requestHash,
        expiresAt: new Date(Date.now() + this.ttlSeconds * 1000).toISOString()
      });

      if (!claimed) {
        const raced = await this.inspect<T>(scopedKey, rawKey, requestHash);
        if (raced) return raced;
        throw new ConflictError(
          `Operation with idempotency key '${rawKey}' is currently being processed`
        );
      }

      const result = await action();
      // Normalised so that a stored answer is always a JSON document: `inspect` treats a
      // row without one as an in-flight claim it must refuse, and a body that serialises
      // to nothing would otherwise lock its key out for the whole retention window.
      await this.repo.resolve(scopedKey, result.status, JSON.stringify(result.body ?? null));
      return { fromCache: false, status: result.status, body: result.body };
    });

    await this.sweepExpiredIfDue();
    return outcome;
  }

  /**
   * Decides what an already-stored key means for this request: the stored answer, a
   * conflict, or nothing at all. The last case drops a key whose retention window has
   * closed, so the value may be used again.
   */
  private async inspect<T>(
    scopedKey: string,
    rawKey: string,
    requestHash: string
  ): Promise<IdempotentOutcome<T> | null> {
    const row = (await this.repo.findByKey(scopedKey)) as IdempotencyKeyRecord | null;
    if (!row) return null;

    if (Date.parse(row.expiresAt) <= Date.now()) {
      // Conditioned on the row still being expired, so a claim written between this read
      // and this delete is not the row that disappears.
      await this.repo.deleteIfExpired(scopedKey, new Date().toISOString());
      return null;
    }

    // A stored answer is always a non-empty JSON document, so anything else counts as
    // absent — including a column a driver hands back as undefined.
    if (!row.responseBody) {
      // Claimed, with no answer. The claim is written in the same transaction as the
      // answer, so a committed row in this state is not something this service can leave
      // behind; refusing is the safe reading of a row that is nonetheless there, and the
      // retention window frees the key either way. Re-running the work here is what would
      // turn a half-finished attempt into a second order.
      throw new ConflictError(
        `Operation with idempotency key '${rawKey}' is currently being processed`
      );
    }

    if (row.requestHash !== requestHash) {
      logger.warn('Idempotency key reused with a different payload', { key: rawKey });
      throw new ConflictError(
        `Idempotency key '${rawKey}' was already used with a different request payload`
      );
    }

    logger.info('Serving stored idempotent response', { key: rawKey });
    return {
      fromCache: true,
      status: row.responseStatusCode ?? 200,
      body: JSON.parse(row.responseBody) as T
    };
  }

  /**
   * Best effort hygiene: a failure to prune must never fail an order that was placed.
   * Under the in-memory test driver the comparison is not evaluated, which can only leave
   * rows behind.
   */
  private async sweepExpiredIfDue(): Promise<void> {
    const now = Date.now();
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + SWEEP_INTERVAL_MS;
    try {
      await this.repo.deleteExpired(new Date(now).toISOString());
    } catch (error) {
      logger.warn('Could not prune expired idempotency keys', { error });
    }
  }
}
