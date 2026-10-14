import type { DatabaseClient } from './client.js';
import type {
  OtpDeliveryRecord,
  SmsReceiptState,
} from './schema.js';
import { nowISO } from './repositoryUtils.js';

/** Filters for the OTP SMS attempt trail. */
export interface OtpDeliveryQuery {
  phone?: string;
  delivered?: boolean;
  provider?: string;
  /** What the gateway has reported about the handset, or `undefined` for any. */
  receipt?: SmsReceiptState;
  limit?: number;
}

/** Repository for the OTP SMS attempt trail. */
export class OtpDeliveryRepository {
  constructor(protected client: DatabaseClient) {}

  private mapRow(row: OtpDeliveryRecord | Record<string, unknown>): OtpDeliveryRecord {
    const source = row as Record<string, unknown>;
    return {
      ...(row as OtpDeliveryRecord),
      delivered: Boolean(source.delivered),
      attempts: Number(source.attempts ?? 0),
    };
  }

  async create(input: Omit<OtpDeliveryRecord, 'createdAt'>): Promise<OtpDeliveryRecord> {
    const now = nowISO();
    const record: OtpDeliveryRecord = { ...input, receiptState: input.receiptState ?? 'UNKNOWN', createdAt: now };
    const sql = `INSERT INTO otp_deliveries (id, phone, provider, delivered, providerStatus, failureCode, failureReason, messageId, attempts, latencyMs, requestId, ipAddress, receiptState, receiptDetail, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.client.query<OtpDeliveryRecord>(sql, [
      record.id,
      record.phone,
      record.provider,
      record.delivered ? 1 : 0,
      record.providerStatus ?? null,
      record.failureCode ?? null,
      record.failureReason ?? null,
      record.messageId ?? null,
      record.attempts,
      record.latencyMs ?? null,
      record.requestId ?? null,
      record.ipAddress ?? null,
      record.receiptState ?? null,
      record.receiptDetail ?? null,
      record.createdAt,
    ]);
    return this.mapRow(record);
  }

  async findRecent(query: OtpDeliveryQuery = {}): Promise<OtpDeliveryRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.phone !== undefined) {
      conditions.push(`phone = ?`);
      params.push(query.phone);
    }
    if (query.delivered !== undefined) {
      conditions.push(`delivered = ?`);
      params.push(query.delivered ? 1 : 0);
    }
    if (query.provider !== undefined) {
      conditions.push(`provider = ?`);
      params.push(query.provider);
    }
    if (query.receipt !== undefined) {
      conditions.push(`receiptState = ?`);
      params.push(query.receipt);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.client.query<OtpDeliveryRecord>(
      `SELECT * FROM otp_deliveries${where} ORDER BY createdAt DESC LIMIT ?`,
      [...params, query.limit ?? 100],
    );
    return result.rows.map((row) => this.mapRow(row));
  }

  async summarize(filter: { since: string }): Promise<{ total: number; delivered: number; failed: number }> {
    const result = await this.client.query<OtpDeliveryRecord>(
      `SELECT delivered, createdAt FROM otp_deliveries`,
    );
    const rows = result.rows.filter((row) => (row.createdAt ?? '') >= filter.since);
    const delivered = rows.filter((row) => Boolean(row.delivered)).length;
    return { total: rows.length, delivered, failed: rows.length - delivered };
  }

  async pruneBefore(cutoffIso: string): Promise<number> {
    const result = await this.client.query<OtpDeliveryRecord>(
      `SELECT id, createdAt FROM otp_deliveries`,
    );
    let pruned = 0;
    for (const row of result.rows) {
      if ((row.createdAt ?? '') >= cutoffIso) continue;
      const deleted = await this.client.query<OtpDeliveryRecord>(
        `DELETE FROM otp_deliveries WHERE id = ?`,
        [row.id],
      );
      pruned += deleted.rowCount;
    }
    return pruned;
  }

  async findById(id: string): Promise<OtpDeliveryRecord | null> {
    const result = await this.client.query<OtpDeliveryRecord>(
      `SELECT * FROM otp_deliveries WHERE id = ?`,
      [id],
    );
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async findByMessageId(provider: string, messageId: string): Promise<OtpDeliveryRecord | null> {
    const result = await this.client.query<OtpDeliveryRecord>(
      `SELECT * FROM otp_deliveries WHERE provider = ? AND messageId = ? LIMIT 1`,
      [provider, messageId],
    );
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async findForPhoneSince(phone: string, sinceIso: string, limit: number): Promise<OtpDeliveryRecord[]> {
    const result = await this.client.query<OtpDeliveryRecord>(
      `SELECT * FROM otp_deliveries WHERE phone = ? AND createdAt >= ? ORDER BY createdAt DESC LIMIT ?`,
      [phone, sinceIso, limit],
    );
    return result.rows.map((row) => this.mapRow(row));
  }

  async recordReceipt(
    id: string,
    receipt: { state: SmsReceiptState; detail: Record<string, unknown> },
  ): Promise<OtpDeliveryRecord | null> {
    const current = await this.findById(id);
    if (!current) return null;
    // A gateway may report twice, so the new word is kept beside the old ones: the count
    // says how many reports arrived and `previousStates` keeps the handset outcomes they
    // replaced, newest last. The latest report's own fields win the top level.
    const previous = parseReceiptDetail(current.receiptDetail) ?? {};
    const previousStates = Array.isArray(previous.previousStates)
      ? [...(previous.previousStates as unknown[])]
      : [];
    if (current.receiptState === 'DELIVERED' || current.receiptState === 'FAILED') {
      previousStates.push(current.receiptState);
    }
    const detail = {
      ...receipt.detail,
      count: (typeof previous.count === 'number' ? previous.count : 0) + 1,
      previousStates,
    };
    const result = await this.client.query<OtpDeliveryRecord>(
      `UPDATE otp_deliveries SET receiptState = ?, receiptDetail = ? WHERE id = ?`,
      [receipt.state, JSON.stringify(detail), id],
    );
    return result.rowCount > 0 ? this.findById(id) : null;
  }

  async summarizeReceipts(filter: { since: string }): Promise<{
    delivered: number;
    failed: number;
    unknown: number;
  }> {
    const result = await this.client.query<OtpDeliveryRecord>(
      `SELECT receiptState, createdAt FROM otp_deliveries`,
    );
    const rows = result.rows.filter((row) => (row.createdAt ?? '') >= filter.since);
    return {
      delivered: rows.filter((row) => row.receiptState === 'DELIVERED').length,
      failed: rows.filter((row) => row.receiptState === 'FAILED').length,
      unknown: rows.filter(
        (row) => row.receiptState !== 'DELIVERED' && row.receiptState !== 'FAILED',
      ).length,
    };
  }

  async findRecentLoginActivity(query: OtpLoginActivityQuery = {}): Promise<OtpLoginActivityRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.phone !== undefined && query.phone !== null && query.phone !== '') {
      conditions.push(`phone = ?`);
      params.push(query.phone);
    }
    if (query.since !== undefined) {
      conditions.push(`lastSentAt >= ?`);
      params.push(new Date(query.since).getTime());
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.client.query<{
      phone: string;
      attempts: number;
      expiresAt: number;
      lastSentAt: number;
    }>(`SELECT phone, attempts, expiresAt, lastSentAt FROM otp_challenges${where} ORDER BY lastSentAt DESC LIMIT ?`, [
      ...params,
      query.limit ?? 20,
    ]);
    const now = Date.now();
    return result.rows.map((row) => ({
      phone: row.phone,
      attempts: Number(row.attempts ?? 0),
      lockedOut: false,
      codeLive: Number(row.expiresAt ?? 0) > now,
      createdAt: new Date(Number(row.lastSentAt ?? now)).toISOString(),
    }));
  }
}

/** Filters for the operator's phone-login activity view. */
export interface OtpLoginActivityQuery {
  /** The E.164 number to inspect. An empty string (not undefined) means "everything". */
  phone?: string | null;
  /** Lower bound on the challenge row's own `createdAt`. */
  since?: string;
  /** Rows per number, bounded so one busy number cannot blow the paged page. */
  limit?: number;
}

export interface OtpLoginActivityRow {
  phone: string;
  attempts: number;
  lockedOut: boolean;
  codeLive: boolean;
  createdAt: string;
}

/**
 * Reads a stored receipt detail. Tolerant on purpose: the column holds what a gateway
 * reported, transcribed by us, so a row nobody can parse is a row with no readable receipt
 * rather than a failed read.
 */
export function parseReceiptDetail(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
