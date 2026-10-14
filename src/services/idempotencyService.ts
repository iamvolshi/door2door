import { ConflictError, ValidationError } from '../core/errors';
import { logger } from '../core/logger';
import * as crypto from 'crypto';

export type IdempotencyStatus = 'PENDING' | 'RESOLVED' | 'FAILED';

export interface IdempotencyRecord<T = unknown> {
  key: string;
  userId: string;
  operation: string;
  requestHash: string;
  status: IdempotencyStatus;
  responsePayload?: T;
  responseStatus?: number;
  createdAt: Date;
  expiresAt: Date;
  errorDetails?: string;
}

export interface IdempotencyOptions {
  ttlSeconds?: number;
  lockWaitTimeoutMs?: number;
}

/**
 * Process-local idempotency. Nothing that moves money uses it any more: `POST /orders`
 * goes through `DurableIdempotencyService`, whose keys are rows and therefore survive a
 * restart. This class is kept for its `hashPayload` helper and an older test, and its
 * store is not something a new endpoint should reach for — a retry that lands on another
 * process, or after a deploy, would not be recognised here.
 */
export class IdempotencyService {
  private store: Map<string, IdempotencyRecord> = new Map();
  private defaultTtlSeconds: number;

  constructor(defaultTtlSeconds: number = 3600) {
    this.defaultTtlSeconds = defaultTtlSeconds;
  }

  public static hashPayload(payload: unknown): string {
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
    return crypto.createHash('sha256').update(str).digest('hex');
  }

  private buildCompositeKey(key: string, operation: string, userId: string): string {
    return `${userId}:${operation}:${key}`;
  }

  public cleanExpired(): void {
    const now = new Date();
    for (const [k, rec] of this.store.entries()) {
      if (rec.expiresAt < now) {
        this.store.delete(k);
      }
    }
  }

  public async executeIdempotent<T>(
    key: string,
    userId: string,
    operation: string,
    requestPayload: unknown,
    action: () => Promise<{ status: number; body: T }>,
    options?: IdempotencyOptions
  ): Promise<{ fromCache: boolean; status: number; body: T }> {
    if (!key || key.trim() === '') {
      throw new ValidationError('Idempotency key must be provided');
    }

    const ttl = options?.ttlSeconds ?? this.defaultTtlSeconds;
    const compositeKey = this.buildCompositeKey(key, operation, userId);
    const currentHash = IdempotencyService.hashPayload(requestPayload);
    const existing = this.store.get(compositeKey);
    const now = new Date();

    if (existing && existing.expiresAt > now) {
      if (existing.requestHash !== currentHash) {
        logger.warn('Idempotency payload mismatch for existing key', {
          key,
          userId,
          operation,
        });
        throw new ConflictError(
          `Idempotency key '${key}' already exists with a different request payload`
        );
      }

      if (existing.status === 'PENDING') {
        throw new ConflictError(
          `Operation '${operation}' with idempotency key '${key}' is currently being processed`
        );
      }

      if (existing.status === 'RESOLVED') {
        logger.info('Serving cached idempotent response', { key, operation, userId });
        return {
          fromCache: true,
          status: existing.responseStatus ?? 200,
          body: existing.responsePayload as T,
        };
      }
    }

    // Create PENDING lock record
    const newRecord: IdempotencyRecord<T> = {
      key,
      userId,
      operation,
      requestHash: currentHash,
      status: 'PENDING',
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttl * 1000),
    };
    this.store.set(compositeKey, newRecord);

    try {
      const result = await action();
      newRecord.status = 'RESOLVED';
      newRecord.responseStatus = result.status;
      newRecord.responsePayload = result.body;
      this.store.set(compositeKey, newRecord);

      return {
        fromCache: false,
        status: result.status,
        body: result.body,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      newRecord.status = 'FAILED';
      newRecord.errorDetails = errorMsg;
      this.store.delete(compositeKey);
      throw err;
    }
  }

  public getRecord(key: string, operation: string, userId: string): IdempotencyRecord | undefined {
    return this.store.get(this.buildCompositeKey(key, operation, userId));
  }

  public clearAll(): void {
    this.store.clear();
  }
}

export const idempotencyService = new IdempotencyService();
