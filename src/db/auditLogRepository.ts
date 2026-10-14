import type { DatabaseClient } from './client.js';
import type { AuditLogRecord } from './schema.js';
import { nowISO } from './repositoryUtils.js';

/** Repository for audit log records. */
export class AuditLogRepository {
  constructor(protected client: DatabaseClient) {}

  async log(profile: Omit<AuditLogRecord, 'createdAt'>): Promise<AuditLogRecord> {
    const now = nowISO();
    const record: AuditLogRecord = {
      ...profile,
      createdAt: now,
    };
    const sql = `INSERT INTO audit_logs (id, userId, action, entityType, entityId, oldValues, newValues, ipAddress, userAgent, sessionId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.client.query(sql, [
      record.id,
      record.userId,
      record.action,
      record.entityType,
      record.entityId,
      record.oldValues,
      record.newValues,
      record.ipAddress,
      record.userAgent,
      record.sessionId,
      record.createdAt,
    ]);
    return record;
  }
}
