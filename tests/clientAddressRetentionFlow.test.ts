import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDACTED_CLIENT_DATA } from '../src/auth/pii';
import { DatabaseClient } from '../src/db/client';
import { AuditLogRepository } from '../src/db/repositories';
import { SqliteDriver } from '../src/db/sqliteDriver';
import {
  SEEDED,
  createTempDatabaseDir,
  postJson,
  removeTempDatabaseDir,
  startServer,
  type RunningServer
} from './apiTestClient';

/**
 * The sweep as it actually runs: rows created by the real login flow, aged past the
 * window, redacted by the boot of the next process.
 */
let tempDir: string;
let databaseFile: string;
let first: RunningServer;
let second: RunningServer;
/** The session from the first login, which must survive every sweep that follows. */
let liveSessionId: string;

const LIVE_AGENT = 'retention-test-agent/1.0';

/** Backdates every row a client address was recorded on, as time passing would. */
async function ageEveryRecordedAddress(days: number): Promise<void> {
  const side = new DatabaseClient(new SqliteDriver(databaseFile));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  await side.query(`UPDATE auth_sessions SET createdAt = ?`, [cutoff]);
  await side.query(`UPDATE audit_logs SET createdAt = ?`, [cutoff]);
  await side.query(`UPDATE otp_deliveries SET createdAt = ?`, [cutoff]);
  await side.close();
}

interface LoggedIn {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

async function loginWithAgent(phone: string, agent: string): Promise<LoggedIn> {
  const headers = { 'user-agent': agent };
  const request = await postJson(first, '/api/v1/auth/otp/request', { phone }, { headers });
  expect(request.status).toBe(200);

  const verify = await postJson(
    first,
    '/api/v1/auth/otp/verify',
    { phone, otp: request.body.devOtp },
    { headers }
  );
  expect(verify.status).toBe(200);

  return {
    accessToken: verify.body.tokens.accessToken,
    refreshToken: verify.body.tokens.refreshToken,
    sessionId: verify.body.session.id
  };
}

beforeAll(async () => {
  tempDir = createTempDatabaseDir();
  databaseFile = `${tempDir}/retention.sqlite`;
  first = await startServer({ port: 0, host: '127.0.0.1', databaseFile });
});

afterAll(async () => {
  await first?.close();
  await second?.close();
  removeTempDatabaseDir(tempDir);
});

describe('Client address retention through the running API', () => {
  it('redacts the history on the next boot while sparing the live session', async () => {
    // Two logins for different people, so the same number's resend cooldown is not in play.
    const live = await loginWithAgent(SEEDED.customer.phone, LIVE_AGENT);
    liveSessionId = live.sessionId;
    const ended = await loginWithAgent(SEEDED.driver.phone, 'ended-agent/1.0');

    // Ending a session is what makes it history; the session itself must stay alive.
    const logout = await postJson(first, '/api/v1/auth/logout', {
      refreshToken: ended.refreshToken
    });
    expect(logout.status).toBe(200);
    expect(logout.body.revoked).toBe(true);

    // An audit entry, written through the real repository, for the same window.
    const side = new DatabaseClient(new SqliteDriver(databaseFile));
    await new AuditLogRepository(side).log({
      id: 'aud_retention_1',
      userId: SEEDED.admin.id,
      action: 'REGISTRATION_REVIEWED',
      entityType: 'USER',
      entityId: SEEDED.merchant.id,
      oldValues: null,
      newValues: null,
      ipAddress: '203.0.113.9',
      userAgent: 'audit-agent/1.0'
    });
    await side.close();

    // Both rows must be dead before the window can touch them.
    const states = await first.client.query<{ id: string; isRevoked: number; expiresAt: string }>(
      `SELECT id, isRevoked, expiresAt FROM auth_sessions WHERE id IN (?, ?)`,
      [live.sessionId, ended.sessionId]
    );
    const endedRow = states.rows.find((row) => row.id === ended.sessionId);
    expect(endedRow?.isRevoked).toBe(1);

    await first.close();
    await ageEveryRecordedAddress(120);

    second = await startServer({ port: 0, host: '127.0.0.1', databaseFile });

    const sessions = await second.client.query<{
      id: string;
      ipAddress: string | null;
      userAgent: string | null;
    }>(`SELECT id, ipAddress, userAgent FROM auth_sessions ORDER BY id`);

    const liveRow = sessions.rows.find((row) => row.id === live.sessionId);
    const endedRowAfter = sessions.rows.find((row) => row.id === ended.sessionId);

    // The live device keeps the answer to "where is this signed in from?".
    expect(liveRow?.ipAddress).toBe('127.0.0.1');
    expect(liveRow?.userAgent).toBe(LIVE_AGENT);
    // The ended one keeps its record and loses its address and device string.
    expect(endedRowAfter?.ipAddress).toBe(REDACTED_CLIENT_DATA);
    expect(endedRowAfter?.userAgent).toBe(REDACTED_CLIENT_DATA);

    // Exactly one session still identifies a client, and it is the live one.
    const identifiable = await second.client.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM auth_sessions WHERE ipAddress IS NOT NULL AND ipAddress <> ?`,
      [REDACTED_CLIENT_DATA]
    );
    expect(Number(identifiable.rows[0].count)).toBe(1);

    // The SMS trail keeps both attempts (they are 30-day rows, pruned separately) and
    // loses the address on them; the audit entry keeps what it is evidence of.
    const deliveries = await second.client.query<{ ipAddress: string | null; provider: string }>(
      `SELECT ipAddress, provider FROM otp_deliveries`
    );
    expect(deliveries.rows).toHaveLength(2);
    expect(deliveries.rows.every((row) => row.ipAddress === REDACTED_CLIENT_DATA)).toBe(true);
    expect(deliveries.rows.every((row) => row.provider === 'none')).toBe(true);

    const audits = await second.client.query<{
      ipAddress: string | null;
      userAgent: string | null;
      action: string;
      entityId: string;
    }>(`SELECT ipAddress, userAgent, action, entityId FROM audit_logs WHERE id = 'aud_retention_1'`);
    expect(audits.rows[0]?.ipAddress).toBe(REDACTED_CLIENT_DATA);
    expect(audits.rows[0]?.userAgent).toBe(REDACTED_CLIENT_DATA);
    expect(audits.rows[0]?.action).toBe('REGISTRATION_REVIEWED');
    expect(audits.rows[0]?.entityId).toBe(SEEDED.merchant.id);
  });

  it('still serves logins after redacting, and records the new one in full', async () => {
    const otpRequest = await postJson(second, '/api/v1/auth/otp/request', {
      phone: SEEDED.merchant.phone
    });
    expect(otpRequest.status).toBe(200);

    const verify = await postJson(second, '/api/v1/auth/otp/verify', {
      phone: SEEDED.merchant.phone,
      otp: otpRequest.body.devOtp
    });
    expect(verify.status).toBe(200);

    const fresh = await second.client.query<{ ipAddress: string | null }>(
      `SELECT ipAddress FROM auth_sessions WHERE id = ?`,
      [verify.body.session.id]
    );
    expect(fresh.rows[0]?.ipAddress).toBe('127.0.0.1');

    const used = await second.client.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM auth_sessions WHERE ipAddress = ?`,
      [REDACTED_CLIENT_DATA]
    );
    expect(Number(used.rows[0].count)).toBe(1);
  });

  it('redacts with the first login of a process, without a restart', async () => {
    // A fresh process: its boot sweep runs before any of these rows exist, so whatever
    // happens next happened on the login path and nowhere else.
    await second.close();
    second = await startServer({ port: 0, host: '127.0.0.1', databaseFile });

    const side = new DatabaseClient(new SqliteDriver(databaseFile));
    const aged = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    const ended = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await side.query(
      `INSERT INTO auth_sessions (id, userId, tokenHash, ipAddress, userAgent, expiresAt, isRevoked, familyId, replacedBy, createdAt)
       VALUES ('sess_login_path', ?, 'hash_login_path', '203.0.113.77', 'side-agent/1.0', ?, 1, 'sess_login_path', NULL, ?)`,
      [SEEDED.customer.id, ended, aged]
    );
    await side.close();

    const before = await second.client.query<{ ipAddress: string }>(
      `SELECT ipAddress FROM auth_sessions WHERE id = 'sess_login_path'`
    );
    expect(before.rows[0].ipAddress).toBe('203.0.113.77');

    // Requesting a login code is where the sweep rides along: a number nobody has used,
    // so the code is issued rather than answered from the resend cooldown.
    const first = await postJson(second, '/api/v1/auth/otp/request', { phone: '+8801711110201' });
    expect(first.status).toBe(200);

    const after = await second.client.query<{ ipAddress: string }>(
      `SELECT ipAddress FROM auth_sessions WHERE id = 'sess_login_path'`
    );
    expect(after.rows[0].ipAddress).toBe(REDACTED_CLIENT_DATA);

    // The next login in the same process does not repeat the work: the sweep is due once
    // an hour, so a busy API does not run three updates behind every code request.
    const side2 = new DatabaseClient(new SqliteDriver(databaseFile));
    await side2.query(
      `INSERT INTO auth_sessions (id, userId, tokenHash, ipAddress, userAgent, expiresAt, isRevoked, familyId, replacedBy, createdAt)
       VALUES ('sess_not_yet', ?, 'hash_not_yet', '203.0.113.78', 'side-agent/1.0', ?, 1, 'sess_not_yet', NULL, ?)`,
      [SEEDED.customer.id, ended, aged]
    );
    await side2.close();

    const next = await postJson(second, '/api/v1/auth/otp/request', { phone: '+8801711110202' });
    expect(next.status).toBe(200);

    const held = await second.client.query<{ ipAddress: string }>(
      `SELECT ipAddress FROM auth_sessions WHERE id = 'sess_not_yet'`
    );
    expect(held.rows[0].ipAddress).toBe('203.0.113.78');
  });

  it('redacts the same rows only once, however many times it runs', async () => {
    await second.close();
    second = await startServer({ port: 0, host: '127.0.0.1', databaseFile });

    const redacted = await second.client.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM auth_sessions WHERE ipAddress = ?`,
      [REDACTED_CLIENT_DATA]
    );
    const identifiable = await second.client.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM auth_sessions WHERE ipAddress IS NOT NULL AND ipAddress <> ?`,
      [REDACTED_CLIENT_DATA]
    );

    // Booting again applies the row the hourly guard deferred on the login path, and the
    // rows already marked are neither counted nor touched a second time: three sessions are
    // de-identified (the ended driver, the login-path fixture and the deferred one) and two
    // still identify a client.
    expect(Number(redacted.rows[0].count)).toBe(3);
    expect(Number(identifiable.rows[0].count)).toBe(2);

    // Which two matters: the live session has now survived three sweeps.
    const live = await second.client.query<{ ipAddress: string | null }>(
      `SELECT ipAddress FROM auth_sessions WHERE id = ?`,
      [liveSessionId]
    );
    expect(live.rows[0].ipAddress).toBe('127.0.0.1');
  });
});
