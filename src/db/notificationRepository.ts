import type { DatabaseClient } from './client.js';
import type {
  UserRole,
  ApprovalStatus,
  NotificationRecord,
  OutOfBandState,
  SmsReceiptState,
} from './schema.js';
import { nowISO } from './repositoryUtils.js';

/** Repository for the account holder's own security-notice list. */
export class NotificationRepository {
  constructor(protected client: DatabaseClient) {}

  private mapRow(row: NotificationRecord | Record<string, unknown>): NotificationRecord {
    const source = row as Record<string, unknown>;
    return {
      ...(row as NotificationRecord),
      outOfBandState: (source.outOfBandState as OutOfBandState | undefined) ?? 'UNKNOWN',
    };
  }

  async create(input: Omit<NotificationRecord, 'createdAt'>): Promise<NotificationRecord> {
    const now = nowISO();
    const record: NotificationRecord = {
      ...input,
      outOfBandState: input.outOfBandState ?? 'UNKNOWN',
      outOfBandDetail: input.outOfBandDetail ?? null,
      readAt: input.readAt ?? null,
      createdAt: now,
    };
    const sql = `INSERT INTO notifications (id, userId, type, title, body, details, outOfBandState, outOfBandDetail, createdAt, readAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.client.query<NotificationRecord>(sql, [
      record.id,
      record.userId,
      record.type,
      record.title,
      record.body,
      record.details ?? null,
      record.outOfBandState,
      record.outOfBandDetail ?? null,
      record.createdAt,
      record.readAt ?? null,
    ]);
    return this.mapRow(record);
  }

  async findById(id: string): Promise<NotificationRecord | null> {
    const result = await this.client.query<NotificationRecord>(
      `SELECT * FROM notifications WHERE id = ?`,
      [id],
    );
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async recordOutOfBandOutcome(
    id: string,
    outcome: { state: OutOfBandState; detail: Record<string, unknown> },
  ): Promise<boolean> {
    const result = await this.client.query<NotificationRecord>(
      `UPDATE notifications SET outOfBandState = ?, outOfBandDetail = ? WHERE id = ?`,
      [outcome.state, JSON.stringify(outcome.detail), id],
    );
    return result.rowCount > 0;
  }

  async listForUser(
    userId: string,
    options: { limit: number; unreadOnly: boolean },
  ): Promise<{ items: NotificationRecord[]; unreadCount: number }> {
    const result = await this.client.query<NotificationRecord>(
      `SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt DESC`,
      [userId],
    );
    const rows = result.rows.map((row) => this.mapRow(row));
    const unread = rows.filter((row) => row.readAt === null || row.readAt === undefined);
    const items = (options.unreadOnly ? unread : rows).slice(0, options.limit);
    return { items, unreadCount: unread.length };
  }

  async markRead(userId: string, ids?: string[]): Promise<number> {
    const now = nowISO();
    if (ids === undefined) {
      const result = await this.client.query<NotificationRecord>(
        `UPDATE notifications SET readAt = ? WHERE userId = ? AND readAt IS NULL`,
        [now, userId],
      );
      return result.rowCount;
    }
    let marked = 0;
    for (const id of ids) {
      const existing = await this.findById(id);
      if (!existing || existing.userId !== userId) continue;
      if (existing.readAt !== null && existing.readAt !== undefined) continue;
      const result = await this.client.query<NotificationRecord>(
        `UPDATE notifications SET readAt = ? WHERE id = ?`,
        [now, id],
      );
      if (result.rowCount > 0) marked += 1;
    }
    return marked;
  }

  /**
   * Every notice with the account it belongs to, newest first, for the operator view.
   *
   * The account is joined rather than looked up per row: `lockedOut` is derived from it on
   * every read, because suspension and reinstatement both happen after the notice is
   * written and a stored flag would lie about either one.
   */
  async listOperatorNotices(filter: {
    type?: string;
    userId?: string;
    since?: string;
  } = {}): Promise<SecurityNoticeRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.type !== undefined) {
      conditions.push(`n.type = ?`);
      params.push(filter.type);
    }
    if (filter.userId !== undefined) {
      conditions.push(`n.userId = ?`);
      params.push(filter.userId);
    }
    if (filter.since !== undefined) {
      conditions.push(`n.createdAt >= ?`);
      params.push(filter.since);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.client.query<SecurityNoticeRow>(
      `SELECT n.*, u.fullName AS customerName, u.phone AS customerPhone, u.role AS customerRole, u.isActive AS customerActive, u.approvalStatus AS customerApprovalStatus FROM notifications n LEFT JOIN users u ON u.id = n.userId${where} ORDER BY n.createdAt DESC`,
      params,
    );
    return result.rows.map((row) => this.mapRow(row) as SecurityNoticeRow);
  }

  async countUnread(userId: string): Promise<number> {
    const result = await this.client.query<NotificationRecord>(
      `SELECT * FROM notifications WHERE userId = ?`,
      [userId],
    );
    return result.rows.filter((row) => {
      const mapped = this.mapRow(row);
      return mapped.readAt === null || mapped.readAt === undefined;
    }).length;
  }
}

/** One notice as an operator needs it: the notice plus the account it belongs to. */
export interface SecurityNoticeRow extends NotificationRecord {
  customerActive?: number | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerRole?: UserRole | null;
  customerApprovalStatus?: ApprovalStatus | null;
}

/** How many notices an operator gets when they do not ask, and the most they may ask for. */
export const DEFAULT_OPERATOR_NOTICE_LIMIT = 20;
export const MAX_NOTIFICATION_LIMIT = 100;
