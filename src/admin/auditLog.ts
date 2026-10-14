import * as crypto from 'crypto';

export interface AuditLogEntry {
  id: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  timestamp: number;
  isoTimestamp: string;
  ipAddress?: string;
  deviceSignature?: string;
  metadata?: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface AuditLogFilter {
  actorId?: string;
  targetId?: string;
  targetType?: string;
  action?: string;
  fromDate?: number;
  toDate?: number;
  limit?: number;
  offset?: number;
}

export class AuditLogger {
  private logEntries: AuditLogEntry[] = [];
  private static readonly GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

  constructor(initialEntries: AuditLogEntry[] = []) {
    this.logEntries = [...initialEntries];
  }

  private computeHash(entryWithoutHash: Omit<AuditLogEntry, 'hash'>): string {
    const payload = [
      entryWithoutHash.id,
      entryWithoutHash.actorId,
      entryWithoutHash.action,
      entryWithoutHash.targetType,
      entryWithoutHash.targetId,
      entryWithoutHash.timestamp,
      entryWithoutHash.previousHash,
      JSON.stringify(entryWithoutHash.metadata || {}),
      entryWithoutHash.ipAddress || '',
      entryWithoutHash.deviceSignature || ''
    ].join('|');

    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  public record(
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata?: Record<string, unknown>,
    context?: { ipAddress?: string; deviceSignature?: string }
  ): AuditLogEntry {
    const id = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const timestamp = Date.now();
    const isoTimestamp = new Date(timestamp).toISOString();
    const previousHash = this.logEntries.length > 0
      ? this.logEntries[this.logEntries.length - 1].hash
      : AuditLogger.GENESIS_HASH;

    const entryData: Omit<AuditLogEntry, 'hash'> = {
      id,
      actorId,
      action,
      targetType,
      targetId,
      timestamp,
      isoTimestamp,
      ipAddress: context?.ipAddress,
      deviceSignature: context?.deviceSignature,
      metadata,
      previousHash
    };

    const hash = this.computeHash(entryData);
    const entry: AuditLogEntry = { ...entryData, hash };
    this.logEntries.push(entry);
    return entry;
  }

  public getEntries(filter?: AuditLogFilter): AuditLogEntry[] {
    let results = [...this.logEntries];

    if (filter) {
      if (filter.actorId) {
        results = results.filter(e => e.actorId === filter.actorId);
      }
      if (filter.targetId) {
        results = results.filter(e => e.targetId === filter.targetId);
      }
      if (filter.targetType) {
        results = results.filter(e => e.targetType === filter.targetType);
      }
      if (filter.action) {
        results = results.filter(e => e.action === filter.action);
      }
      if (filter.fromDate !== undefined) {
        results = results.filter(e => e.timestamp >= filter.fromDate!);
      }
      if (filter.toDate !== undefined) {
        results = results.filter(e => e.timestamp <= filter.toDate!);
      }

      const offset = filter.offset || 0;
      const limit = filter.limit || results.length;
      results = results.slice(offset, offset + limit);
    }

    return results;
  }

  public getEntryById(id: string): AuditLogEntry | undefined {
    return this.logEntries.find(e => e.id === id);
  }

  public verifyIntegrity(): { isValid: boolean; corruptedIndex?: number; reason?: string } {
    if (this.logEntries.length === 0) {
      return { isValid: true };
    }

    for (let i = 0; i < this.logEntries.length; i++) {
      const current = this.logEntries[i];
      const expectedPrevHash = i === 0 ? AuditLogger.GENESIS_HASH : this.logEntries[i - 1].hash;

      if (current.previousHash !== expectedPrevHash) {
        return {
          isValid: false,
          corruptedIndex: i,
          reason: `Broken chain link at index ${i}: expected prevHash ${expectedPrevHash}, got ${current.previousHash}`
        };
      }

      const recalculatedHash = this.computeHash(current);
      if (current.hash !== recalculatedHash) {
        return {
          isValid: false,
          corruptedIndex: i,
          reason: `Hash mismatch at index ${i}: stored ${current.hash}, recomputed ${recalculatedHash}`
        };
      }
    }

    return { isValid: true };
  }

  public totalCount(): number {
    return this.logEntries.length;
  }
}
