import type { DatabaseClient } from './client.js';

/** One rate-limit counter row: a digest of the client, never the address itself. */
export interface RateLimitCounter {
  key: string;
  hits: number;
  windowStart: number;
  sessionId: string | null;
}

/** Repository for the database-backed request-rate-limit counters. */
export class RateLimitRepository {
  constructor(protected client: DatabaseClient) {}

  async querySingle<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const result = await this.client.query<T>(sql, params);
    return result.rows[0] ?? null;
  }

  async count(key: string, now: number, windowMs: number): Promise<RateLimitCounter> {
    return this.client.transaction(async (tx) => {
      const current = await tx.query<RateLimitCounter>(
        `SELECT key, hits, windowStart, sessionId FROM request_rate_limits WHERE key = ?`,
        [key],
      );
      const row = current.rows[0];
      if (row && Number(row.windowStart) > now - windowMs) {
        const hits = Number(row.hits) + 1;
        await tx.query(`UPDATE request_rate_limits SET hits = ? WHERE key = ?`, [hits, key]);
        return {
          key,
          hits,
          windowStart: Number(row.windowStart),
          sessionId: (row.sessionId as string | null) ?? null,
        };
      }
      await tx.query(`DELETE FROM request_rate_limits WHERE key = ?`, [key]);
      await tx.query(
        `INSERT INTO request_rate_limits (key, windowStart, hits, sessionId) VALUES (?, ?, ?, ?)`,
        [key, now, 1, null],
      );
      return { key, hits: 1, windowStart: now, sessionId: null };
    });
  }

  async recordSession(key: string, sessionId: string, windowStartThreshold: number): Promise<boolean> {
    return this.client.transaction(async (tx) => {
      const current = await tx.query<RateLimitCounter>(
        `SELECT key, windowStart FROM request_rate_limits WHERE key = ?`,
        [key],
      );
      const row = current.rows[0];
      if (!row || Number(row.windowStart) <= windowStartThreshold) return false;
      const result = await tx.query(`UPDATE request_rate_limits SET sessionId = ? WHERE key = ?`, [
        sessionId,
        key,
      ]);
      return result.rowCount > 0;
    });
  }

  async pruneClosedWindows(threshold: number): Promise<number> {
    // One statement, not a scan-then-delete loop: a snapshot taken first could name a row
    // whose window has since rolled over, and deleting by key would then remove the fresh
    // window another request just opened. A just-opened row carries windowStart > threshold,
    // so the predicate below can never match it — the sweep only ever removes closed rows.
    const deleted = await this.client.query(
      `DELETE FROM request_rate_limits WHERE windowStart <= ?`,
      [threshold]
    );
    return deleted.rowCount;
  }
}
