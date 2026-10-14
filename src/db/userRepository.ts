import type { DatabaseClient } from './client.js';
import type {
  UserRole,
  UserRecord,
  ApprovalStatus,
} from './schema.js';
import { NotFoundError } from '../core/errors.js';
import { nowISO } from './repositoryUtils.js';

function mapUserRow(row: UserRecord | Record<string, unknown>): UserRecord {
  const source = row as Record<string, unknown>;
  return {
    ...(row as UserRecord),
    isActive: Boolean(source.isActive),
    approvalStatus: (source.approvalStatus as ApprovalStatus | undefined) ?? 'APPROVED',
  };
}

/** Repository for user account records. */
export class UserRepository {
  constructor(protected client: DatabaseClient) {}

  async create(profile: Omit<UserRecord, 'createdAt' | 'updatedAt'>): Promise<UserRecord> {
    const now = nowISO();
    const record: UserRecord = {
      approvalStatus: 'APPROVED',
      ...profile,
      createdAt: now,
      updatedAt: now,
    };
    const sql = `INSERT INTO users (id, email, phone, fullName, role, isActive, approvalStatus, registrationDetails, approvalReason, reviewedBy, reviewedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.client.query(sql, [
      record.id,
      record.email,
      record.phone,
      record.fullName,
      record.role,
      record.isActive ? 1 : 0,
      record.approvalStatus,
      record.registrationDetails,
      record.approvalReason,
      record.reviewedBy,
      record.reviewedAt,
      record.createdAt,
      record.updatedAt,
    ]);
    return record;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const result = await this.client.query<UserRecord>(
      `SELECT * FROM users WHERE id = ?`,
      [id],
    );
    return result.rows.length > 0 ? mapUserRow(result.rows[0]) : null;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const result = await this.client.query<UserRecord>(
      `SELECT * FROM users WHERE email = ?`,
      [email],
    );
    return result.rows.length > 0 ? mapUserRow(result.rows[0]) : null;
  }

  async findByPhone(phone: string): Promise<UserRecord | null> {
    const result = await this.client.query<UserRecord>(
      `SELECT * FROM users WHERE phone = ?`,
      [phone],
    );
    return result.rows.length > 0 ? mapUserRow(result.rows[0]) : null;
  }

  async listByApproval(filter: { status?: ApprovalStatus; role?: UserRole; limit?: number } = {}): Promise<UserRecord[]> {
    const status = filter.status ?? undefined;
    const role = filter.role ?? undefined;
    let query = `SELECT * FROM users`;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (status !== undefined) {
      conditions.push(`approvalStatus = ?`);
      params.push(status);
    }
    if (role !== undefined) {
      conditions.push(`role = ?`);
      params.push(role);
    }
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    // Newest applications surface first (the queue is a triage), with the limit applied at
    // the database so the pending list cannot grow unbounded as registrations accumulate.
    const limit =
      typeof filter?.limit === 'number' && Number.isFinite(filter.limit) ? Math.max(0, Math.floor(filter.limit)) : 100;
    query += ` ORDER BY createdAt DESC LIMIT ?`;
    params.push(limit);
    const result = await this.client.query<UserRecord>(query, params);
    return result.rows.map(mapUserRow);
  }

  /**
   * Records an admin's decision on a registration.
   *
   * Reads before writing so the written row is a modification, never a creation: an unknown
   * id is `NotFoundError`, not a row conjured into existence or a silent success. Only the
   * decision columns move — everything else carries over, including `isActive`, so an
   * approval alone never activates anything.
   */
  async updateApproval(
    id: string,
    decision: { approvalStatus: ApprovalStatus; reason?: string | null; reviewedBy?: string | null }
  ): Promise<UserRecord> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new NotFoundError('User not found');
    }
    const now = nowISO();
    const updated: UserRecord = {
      ...existing,
      approvalStatus: decision.approvalStatus,
      approvalReason: decision.reason ?? null,
      reviewedBy: decision.reviewedBy ?? existing.reviewedBy,
      reviewedAt: now,
      updatedAt: now,
    };
    await this.client.query(
      `UPDATE users SET approvalStatus = ?, approvalReason = ?, reviewedBy = ?, reviewedAt = ?, updatedAt = ? WHERE id = ?`,
      [updated.approvalStatus, updated.approvalReason, updated.reviewedBy, updated.reviewedAt, updated.updatedAt, id],
    );
    return updated;
  }

  /**
   * Activates or deactivates a user's account.
   *
   * Refuses to touch what never existed: an unknown id is `NotFoundError`. The approval
   * columns are untouched, so suspending a permitted account does not un-permit it.
   */
  async updateStatus(id: string, isActive: boolean): Promise<UserRecord> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new NotFoundError('User not found');
    }
    const updated: UserRecord = { ...existing, isActive, updatedAt: nowISO() };
    await this.client.query(`UPDATE users SET isActive = ?, updatedAt = ? WHERE id = ?`, [
      updated.isActive ? 1 : 0,
      updated.updatedAt,
      id,
    ]);
    return updated;
  }
}
