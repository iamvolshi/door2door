import type { DatabaseClient } from './client.js';
import type {
  AddressRecord,
  RiderDutyStatus,
  RiderVehicleType,
} from './schema.js';
import { nowISO } from './repositoryUtils.js';

function mapAddressRow(row: AddressRecord | Record<string, unknown>): AddressRecord {
  const source = row as Record<string, unknown>;
  return {
    ...(row as AddressRecord),
    latitude:
      source.latitude === null || source.latitude === undefined
        ? null
        : Number(source.latitude),
    longitude:
      source.longitude === null || source.longitude === undefined
        ? null
        : Number(source.longitude),
    isDefault: Boolean(source.isDefault),
    isPiiRestricted: Boolean(source.isPiiRestricted),
  };
}

/** Repository for address records. */
export class AddressRepository {
  constructor(protected client: DatabaseClient) {}

  async create(profile: Omit<AddressRecord, 'createdAt' | 'updatedAt'>): Promise<AddressRecord> {
    const now = nowISO();
    const record: AddressRecord = {
      ...profile,
      createdAt: now,
      updatedAt: now,
    };
    const sql = `INSERT INTO addresses (id, userId, label, streetAddress, area, district, postalCode, latitude, longitude, isDefault, isPiiRestricted, removedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.client.query(sql, [
      record.id,
      record.userId,
      record.label,
      record.streetAddress,
      record.area,
      record.district,
      record.postalCode,
      record.latitude,
      record.longitude,
      record.isDefault ? 1 : 0,
      record.isPiiRestricted ? 1 : 0,
      record.removedAt,
      record.createdAt,
      record.updatedAt,
    ]);
    return record;
  }

  async findById(id: string): Promise<AddressRecord | null> {
    const result = await this.client.query<AddressRecord>(
      `SELECT * FROM addresses WHERE id = ?`,
      [id],
    );
    return result.rows.length > 0 ? mapAddressRow(result.rows[0]) : null;
  }

  /**
   * A customer's own addresses: the default first, then newest.
   *
   * Detached rows are excluded everywhere a customer can see or reach an address. The `WHERE`
   * clause above every caller is the point: a listing, a count and a default lookup that each
   * forgot the filter would put an address back in front of somebody who had taken it off
   * their list, so the filter lives in the statements rather than in the handlers.
   */
  async findByUserId(userId: string): Promise<AddressRecord[]> {
    const result = await this.client.query<AddressRecord>(
      `SELECT * FROM addresses WHERE userId = ? AND removedAt IS NULL ORDER BY isDefault DESC, createdAt DESC`,
      [userId],
    );
    return result.rows.map(mapAddressRow);
  }

  async findDefaultByUserId(userId: string): Promise<AddressRecord | null> {
    const result = await this.client.query<AddressRecord>(
      `SELECT * FROM addresses WHERE userId = ? AND removedAt IS NULL AND isDefault = ? ORDER BY createdAt DESC LIMIT 1`,
      [userId, 1],
    );
    return result.rows.length > 0 ? mapAddressRow(result.rows[0]) : null;
  }

  /** The customer's live addresses only: a detached row does not count against the cap. */
  async countByUserId(userId: string): Promise<number> {
    const result = await this.client.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM addresses WHERE userId = ? AND removedAt IS NULL`,
      [userId],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  /**
   * Applies a partial update to one of the customer's own addresses. Ownership is part of
   * the statement, so a caller cannot edit somebody else's row by guessing its id.
   */
  async updateOwned(
    id: string,
    userId: string,
    changes: Partial<Pick<AddressRecord, 'label' | 'streetAddress' | 'area' | 'district' | 'postalCode' | 'latitude' | 'longitude' | 'isDefault'>>,
    options: { asDefault?: boolean } = {}
  ): Promise<AddressRecord | null> {
    const columns: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      columns.push(`${key} = ?`);
      params.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value ?? null));
    }
    if (options.asDefault !== undefined) {
      columns.push('isDefault = ?');
      params.push(options.asDefault ? 1 : 0);
    }
    if (columns.length === 0) return this.findById(id);

    columns.push('updatedAt = ?');
    params.push(nowISO(), id, userId);

    const result = await this.client.query(
      `UPDATE addresses SET ${columns.join(', ')} WHERE id = ? AND userId = ? AND removedAt IS NULL`,
      params
    );
    return result.rowCount > 0 ? this.findById(id) : null;
  }

  /** Removes one of the customer's own addresses. False when it is not theirs. */
  async removeOwned(id: string, userId: string): Promise<boolean> {
    const result = await this.client.query(`DELETE FROM addresses WHERE id = ? AND userId = ?`, [id, userId]);
    return result.rowCount > 0;
  }

  /**
   * Takes an address off the customer's list without deleting the row.
   *
   * Used for an address an order was delivered to: the order keeps naming it, so the row has to
   * stay for that history, but it stops being one of the customer's addresses. The default flag
   * is cleared in the same statement — a detached row cannot be the default of a list it is not
   * on — and `removedAt IS NULL` makes a repeated request a no-op rather than a second
   * detachment with a different timestamp.
   */
  async markRemoved(id: string, userId: string, removedAt: string): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE addresses SET removedAt = ?, isDefault = ?, updatedAt = ? WHERE id = ? AND userId = ? AND removedAt IS NULL`,
      [removedAt, 0, removedAt, id, userId]
    );
    return result.rowCount > 0;
  }

  /** Clears the default flag on every address the customer owns. */
  async clearDefaults(userId: string): Promise<number> {
    const result = await this.client.query(
      `UPDATE addresses SET isDefault = ?, updatedAt = ? WHERE userId = ? AND isDefault = ?`,
      [0, nowISO(), userId, 1]
    );
    return result.rowCount;
  }

  /** Marks one address as the default, without touching the others. */
  async markDefault(id: string, userId: string): Promise<AddressRecord | null> {
    const result = await this.client.query(
      `UPDATE addresses SET isDefault = ?, updatedAt = ? WHERE id = ? AND userId = ?`,
      [1, nowISO(), id, userId]
    );
    return result.rowCount > 0 ? this.findById(id) : null;
  }
}
