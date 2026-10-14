import type { DatabaseClient } from './client.js';
import type { CatalogItemRecord } from './schema.js';
import { nowISO } from './repositoryUtils.js';

function mapCatalogRow(row: CatalogItemRecord | Record<string, unknown>): CatalogItemRecord {
  const source = row as Record<string, unknown>;
  return {
    ...(row as CatalogItemRecord),
    isAvailable: Boolean(source.isAvailable),
  };
}

/** Repository for catalog item records. */
export class CatalogRepository {
  constructor(protected client: DatabaseClient) {}

  async create(profile: Omit<CatalogItemRecord, 'createdAt' | 'updatedAt'>): Promise<CatalogItemRecord> {
    const now = nowISO();
    const record: CatalogItemRecord = {
      ...profile,
      createdAt: now,
      updatedAt: now,
    };
    const sql = `INSERT INTO catalog_items (id, merchantId, name, description, category, priceBdt, isAvailable, sku, imageUrl, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.client.query(sql, [
      record.id,
      record.merchantId,
      record.name,
      record.description,
      record.category,
      record.priceBdt,
      record.isAvailable ? 1 : 0,
      record.sku,
      record.imageUrl,
      record.createdAt,
      record.updatedAt,
    ]);
    return record;
  }

  async findById(id: string): Promise<CatalogItemRecord | null> {
    const result = await this.client.query<CatalogItemRecord>(`SELECT * FROM catalog_items WHERE id = ?`, [id]);
    return result.rows.length > 0 ? mapCatalogRow(result.rows[0]) : null;
  }

  /**
   * A store's menu, in one order for everybody: a merchant editing its own list and a
   * customer browsing the storefront read the same rows in the same sequence, so a change
   * that reorders one list reorders both. Without an `ORDER BY`, SQLite is free to answer
   * differently after any write, which made both lists shuffle for no visible reason.
   */
  async findByMerchantId(merchantId: string): Promise<CatalogItemRecord[]> {
    const result = await this.client.query<CatalogItemRecord>(
      `SELECT * FROM catalog_items WHERE merchantId = ? ORDER BY name COLLATE NOCASE, id`,
      [merchantId],
    );
    return result.rows.map(mapCatalogRow);
  }

  /** How many items a store lists. Used to bound a catalogue before it is added to. */
  async countByMerchantId(merchantId: string): Promise<number> {
    const result = await this.client.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM catalog_items WHERE merchantId = ?`,
      [merchantId]
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  /**
   * Applies a partial update to one of the store's own items. Ownership is part of the
   * statement, so a merchant cannot edit another store's item by guessing its id.
   */
  async updateOwned(
    id: string,
    merchantId: string,
    changes: Partial<
      Pick<CatalogItemRecord, 'name' | 'description' | 'category' | 'priceBdt' | 'isAvailable' | 'imageUrl'>
    >
  ): Promise<CatalogItemRecord | null> {
    const columns: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      columns.push(`${key} = ?`);
      params.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value ?? null));
    }
    if (columns.length === 0) return this.findById(id);

    columns.push('updatedAt = ?');
    params.push(nowISO(), id, merchantId);

    const result = await this.client.query(
      `UPDATE catalog_items SET ${columns.join(', ')} WHERE id = ? AND merchantId = ?`,
      params
    );
    return result.rowCount > 0 ? this.findById(id) : null;
  }

  /** Removes one of the store's own items. False when it is not theirs. */
  async removeOwned(id: string, merchantId: string): Promise<boolean> {
    const result = await this.client.query(
      `DELETE FROM catalog_items WHERE id = ? AND merchantId = ?`,
      [id, merchantId]
    );
    return result.rowCount > 0;
  }
}
