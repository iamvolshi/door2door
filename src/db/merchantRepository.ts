import type { DatabaseClient } from './client.js';
import type { MerchantRecord } from './schema.js';
import { nowISO } from './repositoryUtils.js';

function mapMerchantRow(row: MerchantRecord | Record<string, unknown>): MerchantRecord {
  const source = row as Record<string, unknown>;
  return {
    ...(row as MerchantRecord),
    isOpen: Boolean(source.isOpen),
  };
}

/** Repository for merchant records. */
export class MerchantRepository {
  constructor(protected client: DatabaseClient) {}

  async create(profile: Omit<MerchantRecord, 'createdAt' | 'updatedAt'>): Promise<MerchantRecord> {
    const now = nowISO();
    const record: MerchantRecord = {
      ...profile,
      createdAt: now,
      updatedAt: now,
    };
    const sql = `INSERT INTO merchants (id, ownerUserId, businessName, tradeLicenseNumber, description, category, addressId, phone, isOpen, rating, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.client.query(sql, [
      record.id,
      record.ownerUserId,
      record.businessName,
      record.tradeLicenseNumber,
      record.description,
      record.category,
      record.addressId,
      record.phone,
      record.isOpen ? 1 : 0,
      record.rating,
      record.createdAt,
      record.updatedAt,
    ]);
    return record;
  }

  async findByTradeLicenseNumber(tradeLicenseNumber: string): Promise<MerchantRecord | null> {
    const result = await this.client.query<MerchantRecord>(
      `SELECT * FROM merchants WHERE tradeLicenseNumber = ?`,
      [tradeLicenseNumber],
    );
    return result.rows.length > 0 ? mapMerchantRow(result.rows[0]) : null;
  }

  async findByOwnerUserId(ownerUserId: string): Promise<MerchantRecord | null> {
    const result = await this.client.query<MerchantRecord>(
      `SELECT * FROM merchants WHERE ownerUserId = ?`,
      [ownerUserId],
    );
    return result.rows.length > 0 ? mapMerchantRow(result.rows[0]) : null;
  }

  /**
   * Every storefront, open first, for public discovery. Paginated by a hard cap rather
   * than offsets: the pilot's store count fits one page, and a cursor can wait for the
   * day it does not. Only columns a visitor may see are selected — no licence numbers,
   * no owner ids, no phones.
   */
  async listStores(
    limit = 50
  ): Promise<Pick<MerchantRecord, 'id' | 'businessName' | 'description' | 'category' | 'isOpen' | 'rating'>[]> {
    const capped = Math.max(1, Math.min(100, Math.floor(limit)));
    const result = await this.client.query<MerchantRecord>(
      `SELECT id, businessName, description, category, isOpen, rating
       FROM merchants ORDER BY isOpen DESC, rating DESC LIMIT ${capped}`
    );
    return result.rows.map((row) => {
      const mapped = mapMerchantRow(row);
      return {
        id: mapped.id,
        businessName: mapped.businessName,
        description: mapped.description,
        category: mapped.category,
        isOpen: mapped.isOpen,
        rating: mapped.rating
      };
    });
  }

  async findById(id: string): Promise<MerchantRecord | null> {
    const result = await this.client.query<MerchantRecord>(
      `SELECT * FROM merchants WHERE id = ?`,
      [id],
    );
    return result.rows.length > 0 ? mapMerchantRow(result.rows[0]) : null;
  }

  /**
   * Changes the parts of a store its owner may edit.
   *
   * The writable set is closed on purpose: the trade licence is a licensing decision rather
   * than a shop sign, the phone is the account's own number, and the rating belongs to the
   * customers who gave it. A caller that sends one of those is refused before reaching here
   * (see services/merchantProfileRules.ts), so this method's job is to write what it is given
   * in one statement and answer with the row as it now stands.
   */
  async updateProfile(
    id: string,
    changes: Partial<
      Pick<MerchantRecord, 'businessName' | 'description' | 'category' | 'isOpen' | 'addressId'>
    >
  ): Promise<MerchantRecord | null> {
    const columns: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      columns.push(`${key} = ?`);
      params.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value ?? null));
    }
    if (columns.length === 0) return this.findById(id);

    columns.push('updatedAt = ?');
    params.push(nowISO(), id);

    const result = await this.client.query(
      `UPDATE merchants SET ${columns.join(', ')} WHERE id = ?`,
      params
    );
    return result.rowCount > 0 ? this.findById(id) : null;
  }
}
