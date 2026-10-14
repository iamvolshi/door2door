import type { DatabaseClient } from './client.js';

/** How many rows of each trail a retention sweep redacted. */
export interface RedactionCounts {
  sessions: number;
  auditLogs: number;
  otpDeliveries: number;
}

/** Repository for the client-address retention sweep. */
export class RetentionRepository {
  constructor(protected client: DatabaseClient) {}

  async redactClientDataBefore(
    cutoffIso: string,
    nowIso: string,
    redacted: string,
  ): Promise<RedactionCounts> {
    // A session is history when it can no longer be used — revoked by logout, rotation or
    // suspension, or simply expired. Only history past the window is redacted: a live
    // session keeps the answer to "where is this signed in from?".
    const sessions = await this.client.query(
      `UPDATE auth_sessions SET ipAddress = ?, userAgent = ? WHERE (isRevoked <> ? OR expiresAt < ?) AND createdAt < ? AND (ipAddress IS NOT NULL OR userAgent IS NOT NULL) AND NOT (ipAddress = ? AND userAgent = ?)`,
      [redacted, redacted, 0, nowIso, cutoffIso, redacted, redacted],
    );
    const auditLogs = await this.client.query(
      `UPDATE audit_logs SET ipAddress = ?, userAgent = ? WHERE createdAt < ? AND (ipAddress IS NOT NULL OR userAgent IS NOT NULL) AND NOT (ipAddress = ? AND userAgent = ?)`,
      [redacted, redacted, cutoffIso, redacted, redacted],
    );
    const otpDeliveries = await this.client.query(
      `UPDATE otp_deliveries SET ipAddress = ? WHERE createdAt < ? AND ipAddress IS NOT NULL AND ipAddress != ?`,
      [redacted, cutoffIso, redacted],
    );
    return {
      sessions: sessions.rowCount,
      auditLogs: auditLogs.rowCount,
      otpDeliveries: otpDeliveries.rowCount,
    };
  }
}
