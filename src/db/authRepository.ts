import type { DatabaseClient } from './client.js';
import type {
  AuthCredentialRecord,
  AuthSessionRecord,
  AuthSessionView,
} from './schema.js';
import { nowISO } from './repositoryUtils.js';

function mapAuthSessionRow(row: AuthSessionRecord | Record<string, unknown>): AuthSessionRecord {
  const source = row as Record<string, unknown>;
  return {
    ...(row as AuthSessionRecord),
    isRevoked: Boolean(source.isRevoked),
    expiresAt: source.expiresAt as string,
  };
}

/** Repository for authentication credentials and sessions. */
export class AuthRepository {
  constructor(protected client: DatabaseClient) {}

  async saveCredentials(profile: Omit<AuthCredentialRecord, 'createdAt' | 'updatedAt'>): Promise<AuthCredentialRecord> {
    const now = nowISO();
    const record: AuthCredentialRecord = {
      ...profile,
      createdAt: now,
      updatedAt: now,
    };
    const sql = `INSERT INTO auth_credentials (id, userId, passwordHash, salt, mfaSecret, failedAttempts, lockedUntil, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.client.query(sql, [
      record.id,
      record.userId,
      record.passwordHash,
      record.salt,
      record.mfaSecret,
      record.failedAttempts,
      record.lockedUntil,
      record.createdAt,
      record.updatedAt,
    ]);
    return record;
  }

  async getCredentialsByUserId(userId: string): Promise<AuthCredentialRecord | null> {
    const result = await this.client.query<AuthCredentialRecord>(
      `SELECT * FROM auth_credentials WHERE userId = ?`,
      [userId],
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async createSession(profile: Omit<AuthSessionRecord, 'createdAt'>): Promise<AuthSessionRecord> {
    const now = nowISO();
    const record: AuthSessionRecord = {
      ...profile,
      createdAt: now,
    };
    const sql = `INSERT INTO auth_sessions (id, userId, tokenHash, ipAddress, userAgent, expiresAt, isRevoked, familyId, replacedBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.client.query(sql, [
      record.id,
      record.userId,
      record.tokenHash,
      record.ipAddress || null,
      record.userAgent || null,
      record.expiresAt,
      record.isRevoked ? 1 : 0,
      record.familyId ?? record.id,
      record.replacedBy ?? null,
      record.createdAt,
    ]);
    return mapAuthSessionRow(record);
  }

  async getSessionByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null> {
    const result = await this.client.query<AuthSessionRecord>(
      `SELECT * FROM auth_sessions WHERE tokenHash = ?`,
      [tokenHash],
    );
    return result.rows.length > 0 ? mapAuthSessionRow(result.rows[0]) : null;
  }

  async getSessionById(sessionId: string): Promise<AuthSessionRecord | null> {
    const result = await this.client.query<AuthSessionRecord>(
      `SELECT * FROM auth_sessions WHERE id = ?`,
      [sessionId],
    );
    return result.rows.length > 0 ? mapAuthSessionRow(result.rows[0]) : null;
  }

  /**
   * The account's live sessions, newest first: one row per login that is still usable.
   *
   * A rotation retires the row it replaces, so a chain of refreshes is one row here however
   * many times it has been exchanged. Expired rows are excluded because a session whose
   * refresh token ran out is not one anybody is holding.
   *
   * The columns are named rather than `SELECT *`, so the token digest cannot reach a caller
   * that renders this list (see `AuthSessionView`).
   */
  async listLiveSessionsForUser(
    userId: string,
    now: string = nowISO(),
  ): Promise<AuthSessionView[]> {
    const result = await this.client.query<AuthSessionView>(
      `SELECT id, userId, familyId, ipAddress, userAgent, createdAt, expiresAt FROM auth_sessions WHERE userId = ? AND isRevoked = ? AND expiresAt > ? ORDER BY createdAt DESC, id`,
      [userId, 0, now],
    );
    return result.rows;
  }

  async revokeSessionsForUser(userId: string): Promise<number> {
    const result = await this.client.query<{ rowCount: number }>(
      `UPDATE auth_sessions SET isRevoked = 1 WHERE userId = ? AND isRevoked = 0`,
      [userId],
    );
    return result.rowCount > 0 ? result.rowCount : 0;
  }

  /**
   * Retires one live session of one account, and only if the row is both that account's and
   * still live. Returns true only when this call is the one that ended it.
   *
   * The owner is part of the statement rather than checked before it, so one account can
   * never end another's session. A row that is already revoked, has expired out of the
   * listing, or belongs to somebody else all answer the same way — zero rows.
   */
  async revokeSessionForUser(
    userId: string,
    sessionId: string,
    now: string = nowISO(),
  ): Promise<boolean> {
    const result = await this.client.query<AuthSessionRecord>(
      `UPDATE auth_sessions SET isRevoked = ? WHERE id = ? AND userId = ? AND isRevoked = ? AND expiresAt > ?`,
      [1, sessionId, userId, 0, now],
    );
    return result.rowCount > 0;
  }

  async revokeSessionByTokenHash(tokenHash: string): Promise<boolean> {
    const result = await this.client.query<{ rowCount: number }>(
      `UPDATE auth_sessions SET isRevoked = 1 WHERE tokenHash = ?`,
      [tokenHash],
    );
    return result.rowCount > 0;
  }

  /**
   * Atomically claims a refresh token for rotation: true only when this call is the one
   * that retired it. A second caller affecting zero rows is presenting an already-used
   * token, which is how reuse is detected without a race between concurrent refreshes.
   */
  async markSessionRotated(tokenHash: string, nextSessionId: string): Promise<boolean> {
    // Fully parameterized (no literals) so every driver, including the in-memory test
    // double, binds the same values.
    const result = await this.client.query<AuthSessionRecord>(
      `UPDATE auth_sessions SET replacedBy = ?, isRevoked = ? WHERE tokenHash = ? AND isRevoked = ?`,
      [nextSessionId, 1, tokenHash, 0],
    );
    return result.rowCount > 0;
  }

  /**
   * Revokes every live session in a rotation chain, returning how many were retired.
   * The second statement covers rows written before `familyId` existed, whose own id is
   * their family root.
   */
  async revokeSessionFamily(familyId: string): Promise<number> {
    // Collect the live members first so the count reflects only sessions this call
    // retired; a family is small, and reuse handling is a rare incident path.
    const byFamily = await this.client.query<AuthSessionRecord>(
      `SELECT id FROM auth_sessions WHERE familyId = ? AND isRevoked = ?`,
      [familyId, 0],
    );
    // Sessions written before families existed carry no familyId; their own id is the
    // root, so a family id that is also a session id names them.
    const legacyRoot = await this.client.query<AuthSessionRecord>(
      `SELECT id FROM auth_sessions WHERE id = ? AND isRevoked = ?`,
      [familyId, 0],
    );
    const live = new Set(
      [...byFamily.rows, ...legacyRoot.rows].map((row) => (row as AuthSessionRecord).id),
    );
    for (const id of live) {
      await this.client.query(`UPDATE auth_sessions SET isRevoked = ? WHERE id = ?`, [1, id]);
    }
    return live.size;
  }
}
