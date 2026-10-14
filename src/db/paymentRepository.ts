import type { DatabaseClient } from './client.js';
import type {
  PaymentRecord,
  PaymentReconciliationRecord,
  PaymentStatus,
} from './schema.js';
import { NotFoundError } from '../core/errors.js';
import { nowISO } from './repositoryUtils.js';

/** Repository for payment records. */
export class PaymentRepository {
  constructor(protected client: DatabaseClient) {}

  async create(profile: Omit<PaymentRecord, 'createdAt' | 'updatedAt'>): Promise<PaymentRecord> {
    const now = nowISO();
    const record: PaymentRecord = {
      ...profile,
      createdAt: now,
      updatedAt: now,
    };
    const sql = `INSERT INTO payments (id, orderId, transactionId, provider, method, amountBdt, status, rawGatewayResponse, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.client.query(sql, [
      record.id,
      record.orderId,
      record.transactionId,
      record.provider,
      record.method,
      record.amountBdt,
      record.status,
      record.rawGatewayResponse,
      record.createdAt,
      record.updatedAt,
    ]);
    return record;
  }

  /**
   * Sets a payment's status.
   *
   * Reads before writing, both because some drivers return no row for `UPDATE` and because
   * a payment id that never existed must be `NotFoundError` rather than a quiet success —
   * the notifier downstream keys refunds and receipts off this record.
   */
  async updateStatus(id: string, status: PaymentStatus): Promise<PaymentRecord> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new NotFoundError('Payment not found');
    }
    const updated: PaymentRecord = { ...existing, status };
    await this.client.query(`UPDATE payments SET status = ? WHERE id = ?`, [status, id]);
    return updated;
  }

  /** Every payment attempt against one order, oldest first. */
  async findByOrderId(orderId: string): Promise<PaymentRecord[]> {
    const result = await this.client.query<PaymentRecord>(`SELECT * FROM payments WHERE orderId = ? ORDER BY createdAt`, [
      orderId,
    ]);
    return result.rows;
  }

  async findCompletedByOrderId(orderId: string): Promise<PaymentRecord | null> {
    const result = await this.client.query<PaymentRecord>(`SELECT * FROM payments WHERE orderId = ? AND status = ?`, [
      orderId,
      'COMPLETED',
    ]);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async findById(id: string): Promise<PaymentRecord | null> {
    const result = await this.client.query<PaymentRecord>(
      `SELECT * FROM payments WHERE id = ?`,
      [id],
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async createReconciliation(profile: Omit<PaymentReconciliationRecord, 'createdAt'>): Promise<PaymentReconciliationRecord> {
    const now = nowISO();
    const record: PaymentReconciliationRecord = {
      ...profile,
      createdAt: now,
    };
    const sql = `INSERT INTO payment_reconciliations (id, paymentId, orderId, gatewayReference, expectedAmountBdt, receivedAmountBdt, status, notes, reconciledAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.client.query(sql, [
      record.id,
      record.paymentId,
      record.orderId,
      record.gatewayReference,
      record.expectedAmountBdt,
      record.receivedAmountBdt,
      record.status,
      record.notes,
      record.reconciledAt,
      record.createdAt,
    ]);
    return record;
  }
}
