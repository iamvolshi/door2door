import { describe, expect, it } from 'vitest';
import {
  ClientAddressRetention,
  DEFAULT_PII_RETENTION_DAYS
} from '../src/auth/clientAddressRetention';
import { REDACTED_CLIENT_DATA } from '../src/auth/pii';
import { DatabaseClient } from '../src/db/client';
import { RetentionRepository } from '../src/db/repositories';
import { SqliteDriver } from '../src/db/sqliteDriver';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 90;

const ago = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();
const ahead = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString();

async function freshClient(): Promise<DatabaseClient> {
  const client = new DatabaseClient(new SqliteDriver(':memory:'));
  await client.migrate();
  return client;
}

async function addUser(client: DatabaseClient, id = 'usr_retention'): Promise<string> {
  const now = new Date().toISOString();
  await client.query(
    `INSERT INTO users (id, email, phone, fullName, role, isActive, approvalStatus, createdAt, updatedAt)
     VALUES (?, ?, ?, 'Retention Test', 'CUSTOMER', 1, 'APPROVED', ?, ?)`,
    [id, `${id}@example.com`, '+8801700000099', now, now]
  );
  return id;
}

interface SessionInput {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  isRevoked?: boolean;
  ipAddress?: string | null;
  userAgent?: string | null;
}

async function addSession(client: DatabaseClient, session: SessionInput): Promise<void> {
  await client.query(
    `INSERT INTO auth_sessions (id, userId, tokenHash, ipAddress, userAgent, expiresAt, isRevoked, familyId, replacedBy, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      session.id,
      session.userId,
      `hash_${session.id}`,
      session.ipAddress === undefined ? '203.0.113.10' : session.ipAddress,
      session.userAgent === undefined ? 'curl/8.0' : session.userAgent,
      session.expiresAt,
      session.isRevoked ? 1 : 0,
      session.id,
      session.createdAt
    ]
  );
}

async function addAuditLog(
  client: DatabaseClient,
  id: string,
  createdAt: string,
  fields: { ipAddress?: string | null; userAgent?: string | null } = {}
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (id, userId, action, entityType, entityId, oldValues, newValues, ipAddress, userAgent, createdAt)
     VALUES (?, NULL, 'REGISTRATION_REVIEWED', 'USER', 'usr_reviewed', NULL, NULL, ?, ?, ?)`,
    [
      id,
      fields.ipAddress === undefined ? '203.0.113.20' : fields.ipAddress,
      fields.userAgent === undefined ? 'audit-agent/1.0' : fields.userAgent,
      createdAt
    ]
  );
}

async function addDelivery(
  client: DatabaseClient,
  id: string,
  createdAt: string,
  ipAddress: string | null = '203.0.113.30'
): Promise<void> {
  await client.query(
    `INSERT INTO otp_deliveries (id, phone, provider, delivered, providerStatus, failureCode, failureReason, messageId, attempts, latencyMs, requestId, ipAddress, createdAt)
     VALUES (?, '+8801700000099', 'greenweb', 1, 'SENT', NULL, NULL, 'msg_1', 1, 12, 'req_1', ?, ?)`,
    [id, ipAddress, createdAt]
  );
}

function retention(repo: RetentionRepository, days = WINDOW_DAYS): ClientAddressRetention {
  return new ClientAddressRetention({ repo, retentionDays: days });
}

describe('Retention of recorded client addresses', () => {
  it('replaces the address and device string on a closed session, keeping the row', async () => {
    const client = await freshClient();
    const userId = await addUser(client);
    await addSession(client, {
      id: 'sess_dead',
      userId,
      createdAt: ago(WINDOW_DAYS + 10),
      expiresAt: ago(WINDOW_DAYS + 3)
    });

    const counts = await retention(new RetentionRepository(client)).sweep();

    expect(counts).toEqual({ sessions: 1, auditLogs: 0, otpDeliveries: 0 });
    const rows = await client.query<{ ipAddress: string; userAgent: string }>(
      `SELECT ipAddress, userAgent FROM auth_sessions WHERE id = 'sess_dead'`
    );
    // The row survives — it still says a login happened, and when — but no longer says who.
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].ipAddress).toBe(REDACTED_CLIENT_DATA);
    expect(rows.rows[0].userAgent).toBe(REDACTED_CLIENT_DATA);
    await client.close();
  });

  it('leaves a session that is still live alone, however old it is', async () => {
    const client = await freshClient();
    const userId = await addUser(client);
    await addSession(client, {
      id: 'sess_live',
      userId,
      createdAt: ago(WINDOW_DAYS + 30),
      expiresAt: ahead(1),
      ipAddress: '203.0.113.11'
    });

    const counts = await retention(new RetentionRepository(client)).sweep();

    // The device still holds a working token, so "where is this signed in from?" must
    // remain answerable; the window applies to the history, not to the live session.
    expect(counts).toEqual({ sessions: 0, auditLogs: 0, otpDeliveries: 0 });
    const rows = await client.query<{ ipAddress: string }>(
      `SELECT ipAddress FROM auth_sessions WHERE id = 'sess_live'`
    );
    expect(rows.rows[0].ipAddress).toBe('203.0.113.11');
    await client.close();
  });

  it('leaves a closed session alone while the window is still open', async () => {
    const client = await freshClient();
    const userId = await addUser(client);
    await addSession(client, {
      id: 'sess_recent',
      userId,
      createdAt: ago(2),
      expiresAt: ago(1),
      ipAddress: '203.0.113.12'
    });

    const counts = await retention(new RetentionRepository(client)).sweep();

    expect(counts?.sessions).toBe(0);
    const rows = await client.query<{ ipAddress: string }>(
      `SELECT ipAddress FROM auth_sessions WHERE id = 'sess_recent'`
    );
    expect(rows.rows[0].ipAddress).toBe('203.0.113.12');
    await client.close();
  });

  it('never turns "we did not have it" into "we removed it"', async () => {
    const client = await freshClient();
    const userId = await addUser(client);
    // The seed rows, and any request without metadata, record nothing at all.
    await addSession(client, {
      id: 'sess_empty',
      userId,
      createdAt: ago(WINDOW_DAYS + 5),
      expiresAt: ago(WINDOW_DAYS + 1),
      ipAddress: null,
      userAgent: null
    });
    await addAuditLog(client, 'aud_empty', ago(WINDOW_DAYS + 5), { ipAddress: null, userAgent: null });

    const counts = await retention(new RetentionRepository(client)).sweep();

    expect(counts).toEqual({ sessions: 0, auditLogs: 0, otpDeliveries: 0 });
    const session = await client.query<{ ipAddress: null; userAgent: null }>(
      `SELECT ipAddress, userAgent FROM auth_sessions WHERE id = 'sess_empty'`
    );
    expect(session.rows[0].ipAddress).toBeNull();
    expect(session.rows[0].userAgent).toBeNull();
    await client.close();
  });

  it('redacts the audit trail and the SMS trail, and counts what it touched', async () => {
    const client = await freshClient();
    await addAuditLog(client, 'aud_old', ago(WINDOW_DAYS + 1));
    await addAuditLog(client, 'aud_new', ago(1));
    await addDelivery(client, 'otp_old', ago(WINDOW_DAYS + 1));
    await addDelivery(client, 'otp_new', ago(1));

    const counts = await retention(new RetentionRepository(client)).sweep();

    expect(counts).toEqual({ sessions: 0, auditLogs: 1, otpDeliveries: 1 });

    const audits = await client.query<{ id: string; ipAddress: string; action: string }>(
      `SELECT id, ipAddress, action FROM audit_logs`
    );
    const auditBy = new Map(audits.rows.map((row) => [row.id, row.ipAddress]));
    expect(auditBy.get('aud_old')).toBe(REDACTED_CLIENT_DATA);
    expect(auditBy.get('aud_new')).toBe('203.0.113.20');
    // What the entry is evidence of is untouched: only the identifying fields go.
    expect(audits.rows.every((row) => row.action === 'REGISTRATION_REVIEWED')).toBe(true);

    const deliveries = await client.query<{ id: string; ipAddress: string; providerStatus: string }>(
      `SELECT id, ipAddress, providerStatus FROM otp_deliveries`
    );
    const deliveryBy = new Map(deliveries.rows.map((row) => [row.id, row.ipAddress]));
    expect(deliveryBy.get('otp_old')).toBe(REDACTED_CLIENT_DATA);
    expect(deliveryBy.get('otp_new')).toBe('203.0.113.30');
    // The rows are kept, with what the gateway said: 30-day delivery cleanup is a
    // separate job, so an address must not depend on it running.
    expect(deliveries.rows).toHaveLength(2);
    expect(deliveries.rows.every((row) => row.providerStatus === 'SENT')).toBe(true);
    await client.close();
  });

  it('applies the configured window, not a fixed one', async () => {
    const client = await freshClient();
    await addAuditLog(client, 'aud_two_days', ago(2));
    await addAuditLog(client, 'aud_one_hour', ago(1 / 24));

    const counts = await retention(new RetentionRepository(client), 1).sweep();

    expect(counts?.auditLogs).toBe(1);
    const rows = await client.query<{ id: string; ipAddress: string }>(
      `SELECT id, ipAddress FROM audit_logs`
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row.ipAddress]));
    expect(byId.get('aud_two_days')).toBe(REDACTED_CLIENT_DATA);
    expect(byId.get('aud_one_hour')).toBe('203.0.113.20');
    await client.close();
  });

  it('is idempotent: a second sweep finds nothing left to redact', async () => {
    const client = await freshClient();
    const userId = await addUser(client);
    await addSession(client, {
      id: 'sess_dead',
      userId,
      createdAt: ago(WINDOW_DAYS + 4),
      expiresAt: ago(WINDOW_DAYS + 2)
    });
    const repo = new RetentionRepository(client);

    expect((await retention(repo).sweep())?.sessions).toBe(1);
    expect((await retention(repo).sweep())?.sessions).toBe(0);

    const rows = await client.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM auth_sessions WHERE ipAddress = ?`,
      [REDACTED_CLIENT_DATA]
    );
    expect(Number(rows.rows[0].count)).toBe(1);
    await client.close();
  });

  it('runs at most once per interval unless it is asked directly', async () => {
    const client = await freshClient();
    const userId = await addUser(client);
    await addSession(client, {
      id: 'sess_dead',
      userId,
      createdAt: ago(WINDOW_DAYS + 4),
      expiresAt: ago(WINDOW_DAYS + 2)
    });
    const service = new ClientAddressRetention({
      repo: new RetentionRepository(client),
      retentionDays: WINDOW_DAYS,
      sweepIntervalMs: 3600_000
    });

    const now = Date.now();
    expect((await service.sweepIfDue(now))?.sessions).toBe(1);
    // The next login must not pay for the sweep again.
    expect(await service.sweepIfDue(now + 60_000)).toBeNull();
    // An hour later it may run again, and finds nothing new.
    expect(await service.sweepIfDue(now + 3600_001)).toEqual({
      sessions: 0,
      auditLogs: 0,
      otpDeliveries: 0
    });
    // A direct call ignores the interval.
    expect(await service.sweep()).not.toBeNull();
    await client.close();
  });

  it('reports a failure instead of throwing into the login', async () => {
    const broken = {
      redactClientDataBefore: async () => {
        throw new Error('database is gone');
      }
    } as unknown as RetentionRepository;

    const service = new ClientAddressRetention({ repo: broken, retentionDays: WINDOW_DAYS });
    await expect(service.sweep()).resolves.toBeNull();
    await expect(service.sweepIfDue()).resolves.toBeNull();
  });

  it('defaults to the documented ninety-day window', () => {
    expect(DEFAULT_PII_RETENTION_DAYS).toBe(90);
    const client = { redactClientDataBefore: async () => ({ sessions: 0, auditLogs: 0, otpDeliveries: 0 }) };
    const service = new ClientAddressRetention({
      repo: client as unknown as RetentionRepository
    });
    expect(service).toBeInstanceOf(ClientAddressRetention);
  });
});
