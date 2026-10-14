import type { DatabaseClient } from './client.js';
import type { RefundRecord } from './schema.js';
import { nowISO } from './repositoryUtils.js';

/** Repository for refund records. */
export class RefundRepository {
  constructor(protected client: DatabaseClient) {}

  async create(refund: Omit<RefundRecord, 'createdAt'>): Promise<RefundRecord> {
    const record: RefundRecord = { ...refund, createdAt: nowISO() };
    const sql = `INSERT INTO refunds (id, orderId, paymentId, amountBdt, status, reason, notes, initiatedBy, initiatorRole, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.client.query(sql, [
      record.id,
      record.orderId,
      record.paymentId || null,
      record.amountBdt,
      record.status,
      record.reason || null,
      record.notes || null,
      record.initiatedBy,
      record.initiatorRole,
      record.createdAt,
    ]);
    return record;
  }

  /** Every refund recorded against one order, oldest first. */
  async findByOrderId(orderId: string): Promise<RefundRecord[]> {
    const result = await this.client.query<RefundRecord>(
      `SELECT * FROM refunds WHERE orderId = ? ORDER BY createdAt`,
      [orderId],
    );
    return result.rows;
  }

  /**
   * What has already been given back for an order. Refunds are summed rather than
   * limited to one row, so a partial refund can be followed by another — the limit is the
   * money that was taken, not the number of rows.
   */
  async totalRefundedBdt(orderId: string): Promise<number> {
    const result = await this.client.query<{ total: number | null }>(
      `SELECT COALESCE(SUM(amountBdt), 0) as total FROM refunds WHERE orderId = ? AND status = 'COMPLETED'`,
      [orderId],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  async findById(id: string): Promise<RefundRecord | null> {
    const result = await this.client.query<RefundRecord>(`SELECT * FROM refunds WHERE id = ?`, [id]);
    return result.rows.length > 0 ? result.rows[0] : null;
  }
}
