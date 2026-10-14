import type { DatabaseClient } from './client.js';
import type {
  RiderProfileRecord,
  RiderDutyStatus,
  RiderVehicleType,
} from './schema.js';
import { nowISO } from './repositoryUtils.js';

/** Rider roster entry: the profile plus who holds it, never the identity documents. */
export interface RiderRosterRow {
  userId: string;
  fullName: string;
  phone: string;
  nidNumber: string;
  vehicleType: RiderVehicleType;
  licenseNumber?: string | null;
  zoneId?: string | null;
  dutyStatus: RiderDutyStatus;
  createdAt: string;
  updatedAt: string;
}

/** Filters for the dispatcher roster. */
export interface RiderRosterQuery {
  zoneId?: string;
  includeOffDuty?: boolean;
  limit?: number;
}

/** Repository for rider profile records. */
export class RiderProfileRepository {
  constructor(protected client: DatabaseClient) {}

  async create(profile: Omit<RiderProfileRecord, 'createdAt' | 'updatedAt'>): Promise<RiderProfileRecord> {
    const now = nowISO();
    const record: RiderProfileRecord = {
      ...profile,
      createdAt: now,
      updatedAt: now,
    };
    const sql = `INSERT INTO rider_profiles (userId, nidNumber, vehicleType, licenseNumber, zoneId, dutyStatus, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.client.query(sql, [
      record.userId,
      record.nidNumber,
      record.vehicleType,
      record.licenseNumber || null,
      record.zoneId || null,
      record.dutyStatus,
      record.createdAt,
      record.updatedAt,
    ]);
    return record;
  }

  async findByUserId(userId: string): Promise<RiderProfileRecord | null> {
    const result = await this.client.query<RiderProfileRecord>(
      `SELECT * FROM rider_profiles WHERE userId = ?`,
      [userId],
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async setDutyStatusUnlessDelivering(userId: string, newStatus: RiderDutyStatus): Promise<RiderProfileRecord | null> {
    const existing = await this.findByUserId(userId);
    if (!existing) return null;
    if (existing.dutyStatus === 'ON_DELIVERY') return existing;
    return await this.client.query<RiderProfileRecord>(
      `UPDATE rider_profiles SET dutyStatus = ? WHERE userId = ?`,
      [newStatus, userId],
    ).then((result) => result.rowCount > 0 ? { ...existing, dutyStatus: newStatus } : null);
  }

  async listRoster(query: RiderRosterQuery = {}): Promise<RiderRosterRow[]> {
    const conditions: string[] = [`u.isActive = 1`];
    const params: unknown[] = [];
    if (query.zoneId !== undefined) {
      conditions.push(`rp.zoneId = ?`);
      params.push(query.zoneId);
    }
    if (!query.includeOffDuty) {
      conditions.push(`rp.dutyStatus != 'OFF_DUTY'`);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.client.query<RiderRosterRow>(
      `SELECT rp.userId, rp.nidNumber, rp.vehicleType, rp.licenseNumber, rp.zoneId, rp.dutyStatus, rp.createdAt, rp.updatedAt, u.fullName, u.phone FROM rider_profiles rp JOIN users u ON u.id = rp.userId${where} ORDER BY CASE WHEN rp.dutyStatus = 'AVAILABLE' THEN 0 ELSE 1 END, u.fullName ASC LIMIT ?`,
      [...params, query.limit ?? 100],
    );
    return result.rows;
  }
}
