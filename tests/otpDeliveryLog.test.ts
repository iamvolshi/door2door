import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OtpDeliveryLog } from '../src/auth/otpDeliveryLog';
import { DatabaseClient } from '../src/db/client';
import { OtpDeliveryRepository } from '../src/db/repositories';
import { SqliteDriver } from '../src/db/sqliteDriver';
import {
  SEEDED,
  createTempDatabaseDir,
  getJson,
  login,
  postJson,
  removeTempDatabaseDir,
  startServer,
  type RunningServer
} from './apiTestClient';

/**
 * The OTP SMS attempt trail: every dispatch is recorded with the provider's own answer, so
 * an operator can answer "did this login's code actually go out?" long after the fact.
 */
describe('OTP delivery attempts', () => {
  let tempDir: string;
  let app: RunningServer;
  let adminToken: string;
  let customerToken: string;

  /**
   * Stands in for the SMS gateway. Sends are reported as not sent until a test accepts
   * them, because logging in needs the development code back in the response.
   */
  let smsAccepted = false;
  const stubDispatch = async (phone: string) =>
    smsAccepted
      ? {
          delivered: true,
          provider: 'greenweb',
          providerStatus: 'SENT',
          messageId: `gw-${phone.slice(-4)}`,
          attempts: 1,
          latencyMs: 42
        }
      : {
          delivered: false,
          provider: 'none',
          code: 'SMS_NOT_SENT',
          reason: 'SMS provider is not configured',
          attempts: 0
        };

  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${tempDir}/delivery.sqlite`,
      otpDispatch: stubDispatch
    });

    const admin = await login(app, SEEDED.admin.phone);
    adminToken = admin.accessToken;
    const customer = await login(app, SEEDED.customer.phone);
    customerToken = customer.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  const deliveries = (token: string, query = '') =>
    getJson(app, `/api/v1/admin/otp-deliveries${query}`, { token });

  it('records an accepted send with the provider answer and message id', async () => {
    smsAccepted = true;
    const request = await postJson(app, '/api/v1/auth/otp/request', {
      phone: SEEDED.merchant.phone
    });
    smsAccepted = false;
    expect(request.status).toBe(200);
    expect(request.body.smsDelivered).toBe(true);

    const listed = await deliveries(adminToken, `?phone=${encodeURIComponent(SEEDED.merchant.phone)}`);
    expect(listed.status).toBe(200);
    expect(listed.body.count).toBe(1);

    const [attempt] = listed.body.deliveries;
    expect(attempt.phone).toBe(SEEDED.merchant.phone);
    expect(attempt.delivered).toBe(true);
    expect(attempt.provider).toBe('greenweb');
    expect(attempt.providerStatus).toBe('SENT');
    expect(attempt.messageId).toBe(`gw-${SEEDED.merchant.phone.slice(-4)}`);
    expect(attempt.attempts).toBe(1);
    expect(attempt.latencyMs).toBe(42);
    expect(attempt.failureCode).toBeNull();
    expect(typeof attempt.requestId).toBe('string');
    expect(typeof attempt.sentAt).toBe('string');
  });

  it('records a send that never left, with the reason', async () => {
    // With the default test configuration no provider is configured, so dispatch reports
    // SMS_NOT_SENT rather than claiming success.
    const probe = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${tempDir}/unconfigured.sqlite`
    });

    try {
      const admin = await login(probe, SEEDED.admin.phone);
      const request = await postJson(probe, '/api/v1/auth/otp/request', {
        phone: SEEDED.driver.phone
      });
      expect(request.status).toBe(200);
      expect(request.body.smsDelivered).toBe(false);

      const listed = await getJson(probe, `/api/v1/admin/otp-deliveries?phone=${encodeURIComponent(SEEDED.driver.phone)}`, {
        token: admin.accessToken
      });
      const [attempt] = listed.body.deliveries;
      expect(attempt.delivered).toBe(false);
      expect(attempt.provider).toBe('none');
      expect(attempt.failureCode).toBe('SMS_NOT_SENT');
      expect(attempt.failureReason).toMatch(/not configured/i);
      expect(attempt.messageId).toBeNull();
    } finally {
      await probe.close();
    }
  });

  it('keeps one row per attempt, one row per send, and no row for a refused resend', async () => {
    smsAccepted = true;
    const phone = '+8801713330001';
    await postJson(app, '/api/v1/auth/otp/request', { phone });
    // A second request for the same number is refused by the resend cooldown, which is
    // itself a login outcome an operator may be asked about, but it sends no SMS.
    const refused = await postJson(app, '/api/v1/auth/otp/request', { phone });
    expect(refused.status).toBe(429);

    smsAccepted = false;

    const listed = await deliveries(adminToken, `?phone=${encodeURIComponent(phone)}`);
    expect(listed.body.count).toBe(1);
    expect(listed.body.deliveries[0].delivered).toBe(true);
  });

  it('filters by outcome, provider and limit, and rejects nonsense', async () => {
    const onlyFailures = await deliveries(adminToken, '?delivered=false');
    expect(onlyFailures.status).toBe(200);
    expect(onlyFailures.body.deliveries.length).toBeGreaterThan(0);
    expect(onlyFailures.body.deliveries.every((entry: any) => entry.delivered === false)).toBe(true);

    const onlyAccepted = await deliveries(adminToken, '?delivered=true&provider=greenweb');
    expect(onlyAccepted.body.deliveries.length).toBeGreaterThan(0);
    expect(
      onlyAccepted.body.deliveries.every(
        (entry: any) => entry.delivered === true && entry.provider === 'greenweb'
      )
    ).toBe(true);

    const limited = await deliveries(adminToken, '?limit=1');
    expect(limited.body.deliveries).toHaveLength(1);
    expect(limited.body.count).toBe(1);

    expect((await deliveries(adminToken, '?delivered=sometimes')).status).toBe(400);
    expect((await deliveries(adminToken, '?limit=0')).status).toBe(400);
    expect((await deliveries(adminToken, '?phone=12')).status).toBe(400);
  });

  it('finds a number however the operator types it', async () => {
    const national = SEEDED.merchant.phone.replace('+880', '0');
    const listed = await deliveries(adminToken, `?phone=${encodeURIComponent(national)}`);
    expect(listed.status).toBe(200);
    expect(listed.body.count).toBe(1);
    expect(listed.body.deliveries[0].phone).toBe(SEEDED.merchant.phone);
  });

  it('summarises accepted and failed sends over the window', async () => {
    const listed = await deliveries(adminToken);
    const { summary } = listed.body;
    expect(summary.windowHours).toBe(24);
    expect(summary.total).toBe(summary.delivered + summary.failed);
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.delivered).toBeGreaterThan(0);

    // The summary ignores the outcome filter, so a failure-only listing still reports both.
    const filtered = await deliveries(adminToken, '?delivered=false');
    expect(filtered.body.summary.total).toBe(summary.total);
    expect(filtered.body.summary.delivered).toBe(summary.delivered);
  });

  it('is admin-only', async () => {
    const forbidden = await deliveries(customerToken);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
    expect((await getJson(app, '/api/v1/admin/otp-deliveries')).status).toBe(401);
  });

  it('prunes attempts older than the retention window on the next login', async () => {
    const oldId = 'otpd_old0000000000000001';
    const stale = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
    await app.client.query(
      `INSERT INTO otp_deliveries (id, phone, provider, delivered, attempts, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
      [oldId, '+8801713330002', 'greenweb', 1, 1, stale]
    );
    expect((await deliveries(adminToken, '?phone=%2B8801713330002')).body.count).toBe(1);

    await postJson(app, '/api/v1/auth/otp/request', { phone: '+8801713330003' });

    expect((await deliveries(adminToken, `?phone=${encodeURIComponent('+8801713330002')}`)).body.count).toBe(0);
  });
});

/**
 * The write itself must never be able to break a login: the message may already be on its
 * way, and the resend cooldown would block a retry.
 */
describe('OtpDeliveryLog', () => {
  it('reports a failed write instead of throwing', async () => {
    const client = new DatabaseClient(new SqliteDriver(':memory:'));
    await client.migrate();
    const repo = new OtpDeliveryRepository(client);
    const log = new OtpDeliveryLog(repo);
    await client.close();

    const stored = await log.record({
      phone: '+8801811999001',
      provider: 'greenweb',
      delivered: true,
      attempts: 1
    });

    expect(stored).toBeNull();
    expect(await log.prune()).toBe(0);
  });

  it('stores and prunes through a live database', async () => {
    const client = new DatabaseClient(new SqliteDriver(':memory:'));
    await client.migrate();
    const repo = new OtpDeliveryRepository(client);
    const log = new OtpDeliveryLog(repo, 1000);

    const stored = await log.record({
      phone: '+8801811999002',
      provider: 'bulksmsbd',
      delivered: false,
      providerStatus: '1007',
      failureCode: 'SMS_INSUFFICIENT_BALANCE',
      failureReason: 'Insufficient SMS balance',
      attempts: 3,
      latencyMs: 1200
    });
    expect(stored).not.toBeNull();

    const [row] = await repo.findRecent({ phone: '+8801811999002' });
    expect(row.delivered).toBe(false);
    expect(row.providerStatus).toBe('1007');
    expect(row.failureCode).toBe('SMS_INSUFFICIENT_BALANCE');
    expect(row.failureReason).toBe('Insufficient SMS balance');
    expect(row.attempts).toBe(3);

    const summary = await repo.summarize({ since: new Date(Date.now() - 60000).toISOString() });
    expect(summary).toEqual({ total: 1, delivered: 0, failed: 1 });

    // A one-second retention window makes this row immediately old.
    expect(await log.prune(Date.now() + 5000)).toBe(1);
    expect(await repo.findRecent({})).toHaveLength(0);
    await client.close();
  });
});
