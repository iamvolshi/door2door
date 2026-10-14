import type { DatabaseClient } from './client.js';
import type { IdempotencyKeyRecord } from './schema.js';
import { nowISO } from './repositoryUtils.js';

/** Repository for idempotency key records. */
export class IdempotencyRepository {
  constructor(protected client: DatabaseClient) {}

  async save(profile: Omit<IdempotencyKeyRecord, 'createdAt'>): Promise<IdempotencyKeyRecord> {
    const now = nowISO();
    const record: IdempotencyKeyRecord = {
      ...profile,
      createdAt: now,
    };
    const sql = `INSERT INTO idempotency_keys (id, idempotencyKey, userId, endpoint, requestHash, responseStatusCode, responseBody, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.client.query(sql, [
      record.id,
      record.idempotencyKey,
      record.userId,
      record.endpoint,
      record.requestHash,
      record.responseStatusCode,
      record.responseBody,
      record.expiresAt,
      record.createdAt,
    ]);
    return record;
  }

  async findByKey(idempotencyKey: string): Promise<IdempotencyKeyRecord | null> {
    const result = await this.client.query<IdempotencyKeyRecord>(
      `SELECT * FROM idempotency_keys WHERE idempotencyKey = ?`,
      [idempotencyKey],
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async claim(
    profile: Omit<IdempotencyKeyRecord, 'createdAt' | 'responseStatusCode' | 'responseBody'>,
  ): Promise<IdempotencyKeyRecord | null> {
    const preexisting = await this.findByKey(profile.idempotencyKey);
    if (preexisting) return null;
    const now = nowISO();
    const record: IdempotencyKeyRecord = {
      ...profile,
      responseStatusCode: null,
      responseBody: null,
      createdAt: now,
    };
    const sql = `INSERT INTO idempotency_keys (id, idempotencyKey, userId, endpoint, requestHash, responseStatusCode, responseBody, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    try {
      await this.client.query<IdempotencyKeyRecord>(sql, [
        record.id,
        record.idempotencyKey,
        record.userId ?? null,
        record.endpoint,
        record.requestHash,
        record.responseStatusCode,
        record.responseBody,
        record.expiresAt,
        record.createdAt,
      ]);
    } catch (error) {
      const raced = await this.findByKey(profile.idempotencyKey);
      if (raced) return null;
      throw error;
    }
    return record;
  }

  async resolve(key: string, status: number, body: string): Promise<IdempotencyKeyRecord | null> {
    const result = await this.client.query<IdempotencyKeyRecord>(
      `UPDATE idempotency_keys SET responseStatusCode = ?, responseBody = ? WHERE idempotencyKey = ?`,
      [status, body, key],
    );
    return result.rowCount > 0 ? await this.findByKey(key) : null;
  }

  async deleteIfExpired(scopedKey: string, expiresAt: string): Promise<boolean> {
    const result = await this.client.query<{ rowCount: number }>(
      `DELETE FROM idempotency_keys WHERE idempotencyKey = ? AND expiresAt < ?`,
      [scopedKey, expiresAt],
    );
    return result.rowCount > 0;
  }

  async deleteExpired(expiresAt: string): Promise<number> {
    const result = await this.client.query<IdempotencyKeyRecord>(
      `DELETE FROM idempotency_keys WHERE expiresAt < ?`,
      [expiresAt],
    );
    return result.rowCount;
  }
}
