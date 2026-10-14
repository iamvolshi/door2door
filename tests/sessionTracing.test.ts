import * as crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionService } from '../src/auth/sessionService';
import { UserRepository } from '../src/db/repositories';
import {
  SEEDED,
  createTempDatabaseDir,
  getJson,
  login,
  patchJson,
  postJson,
  removeTempDatabaseDir,
  startServer,
  type ApiResponse,
  type LoggedInAccount,
  type RunningServer
} from './apiTestClient';

/**
 * Which session did what.
 *
 * `audit_logs.userId` has always answered "which account", and that is not the question an
 * incident asks second. An account is several logins — a phone, a laptop, an old handset —
 * and a trail that stops at the account cannot distinguish the customer's own device from the
 * one somebody else is holding. So every request that proved which session it belongs to now
 * writes that session id onto the rows it produces, and names it on the counter that is
 * counting the client it came from.
 */

let tempDir: string;
let app: RunningServer;
/** Two logins of the same account: the distinction this whole feature exists to make. */
let phone: LoggedInAccount;
let laptop: { sessionId: string; accessToken: string };
let merchant: LoggedInAccount;
let admin: LoggedInAccount;

const VISITOR_PHONE = '+8801799600001';

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** The session a login opened, found the way the database knows it: by its token digest. */
async function sessionIdFor(refreshToken: string): Promise<string> {
  const rows = await app.client.query<{ id: string }>(
    'SELECT id FROM auth_sessions WHERE tokenHash = ?',
    [sha256(refreshToken)]
  );
  expect(rows.rows).toHaveLength(1);
  return rows.rows[0].id;
}

async function auditRows(
  where: string,
  params: unknown[]
): Promise<Array<{ action: string; entityId: string; sessionId: string | null; userId: string | null }>> {
  const result = await app.client.query<{
    action: string;
    entityId: string;
    sessionId: string | null;
    userId: string | null;
  }>(`SELECT action, entityId, sessionId, userId FROM audit_logs ${where}`, params);
  return result.rows;
}

/** Places an order the way a customer's app does, and hands back the order id. */
async function placeOrder(token: string, key: string): Promise<ApiResponse> {
  return postJson(
    app,
    '/api/v1/orders',
    {
      merchantId: SEEDED.merchantId,
      deliveryAddressId: SEEDED.addressId,
      serviceArea: 'cox_bazar_sadar',
      distanceKm: 3,
      items: [{ itemId: SEEDED.rupchandaId, quantity: 1 }]
    },
    { token, headers: { 'idempotency-key': key } }
  );
}

/** Opens a session without the OTP flow, so one account can hold two logins here. */
async function openSession(userId: string) {
  const user = await new UserRepository(app.client).findById(userId);
  expect(user).toBeTruthy();
  return new SessionService(app.client).startSession(user!);
}

describe('Every authenticated request names the session it came through', () => {
  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${tempDir}/session-tracing.sqlite`,
      rateLimit: { max: 5000, windowMs: 60000 }
    });

    phone = await login(app, SEEDED.customer.phone);
    const second = await openSession(SEEDED.customer.id);
    laptop = { sessionId: second.sessionId, accessToken: second.accessToken };
    merchant = await login(app, SEEDED.merchant.phone);
    admin = await login(app, SEEDED.admin.phone);
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  it('tells two logins of one account apart in the trail', async () => {
    const fromPhone = await placeOrder(phone.accessToken, 'trace-phone-1');
    const fromLaptop = await placeOrder(laptop.accessToken, 'trace-laptop-1');
    expect(fromPhone.status).toBe(201);
    expect(fromLaptop.status).toBe(201);

    const phoneSession = await sessionIdFor(phone.refreshToken);
    const rows = await auditRows("WHERE action = 'ORDER_PLACED' AND entityId IN (?, ?)", [
      fromPhone.body.order.id,
      fromLaptop.body.order.id
    ]);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // Same account on both, which is exactly why the session is the interesting column.
      expect(row.userId).toBe(SEEDED.customer.id);
      expect(row.sessionId).toBe(
        row.entityId === fromPhone.body.order.id ? phoneSession : laptop.sessionId
      );
    }
    expect(rows[0].sessionId).not.toBe(rows[1].sessionId);

    // Which is the question an operator actually asks: what did this login do?
    const fromThatLaptop = await auditRows('WHERE sessionId = ?', [laptop.sessionId]);
    expect(fromThatLaptop.map((row) => row.entityId)).toContain(fromLaptop.body.order.id);
    expect(fromThatLaptop.map((row) => row.entityId)).not.toContain(fromPhone.body.order.id);
  });

  it('names the session on rows written deeper in than the route', async () => {
    // A merchant editing its profile, and an administrator suspending an account: one writes
    // its row in the route, the other inside an account-status transaction, and both carry
    // the session of whoever asked — not the session of the account being changed.
    const edited = await patchJson(
      app,
      '/api/v1/merchant/profile',
      { description: 'Traced description' },
      { token: merchant.accessToken }
    );
    expect(edited.status).toBe(200);

    const now = new Date().toISOString();
    await app.client.query(
      `INSERT INTO users (id, email, phone, fullName, role, isActive, approvalStatus, approvalReason, registrationDetails, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'usr_fixture_traced',
        'traced@fixture.coxsbazar.delivery',
        VISITOR_PHONE,
        'Traced Customer',
        'CUSTOMER',
        1,
        'APPROVED',
        null,
        null,
        now,
        now
      ]
    );
    const visitor = await login(app, VISITOR_PHONE);

    const suspended = await postJson(
      app,
      '/api/v1/admin/users/usr_fixture_traced/suspend',
      { reason: 'Traced suspension' },
      { token: admin.accessToken }
    );
    expect(suspended.status).toBe(200);
    expect(suspended.body.revokedSessions).toBe(1);

    const merchantRows = await auditRows(
      "WHERE action = 'MERCHANT_PROFILE_UPDATE' AND entityId = ?",
      [SEEDED.merchantId]
    );
    expect(merchantRows).toHaveLength(1);
    expect(merchantRows[0].sessionId).toBe(await sessionIdFor(merchant.refreshToken));

    const suspensionRows = await auditRows("WHERE action = 'ACCOUNT_SUSPENDED' AND entityId = ?", [
      'usr_fixture_traced'
    ]);
    expect(suspensionRows).toHaveLength(1);
    // The administrator's login did it. The suspended account's session played no part in the
    // request, and the row says so.
    expect(suspensionRows[0].userId).toBe(SEEDED.admin.id);
    expect(suspensionRows[0].sessionId).toBe(await sessionIdFor(admin.refreshToken));
    expect(suspensionRows[0].sessionId).not.toBe(visitor.sessionId);

    // And the suspension still did what it does: the victim's session is retired, so the row
    // that records it is also a record of the last request that session was allowed to make.
    expect((await getJson(app, '/api/v1/auth/me', { token: visitor.accessToken })).status).toBe(401);

    // Leaving the visitor's own last act in the trail, under their own session.
    const visitorRows = await auditRows("WHERE entityId = ? AND action = 'ACCOUNT_REGISTER'", ['usr_fixture_traced']);
    expect(visitorRows).toHaveLength(0);
  });

  it('leaves the column null where there was no session to name', async () => {
    // Registration is authorised by a code sent to a phone: the account is being created, so
    // there is no login behind the request and the trail says nothing rather than guessing.
    const request = await postJson(app, '/api/v1/auth/otp/request', { phone: '+8801799600002' });
    const registered = await postJson(app, '/api/v1/auth/register', {
      phone: '+8801799600002',
      otp: request.body.devOtp,
      fullName: 'Fresh Customer',
      role: 'CUSTOMER'
    });
    expect(registered.status).toBe(201);

    const rows = await auditRows("WHERE action = 'ACCOUNT_REGISTER' AND entityId = ?", [
      registered.body.user.id
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBeNull();
  });

  it('names the session on the counter that is counting the client', async () => {
    const phoneSession = await sessionIdFor(phone.refreshToken);

    // A request from a session this test chose, so the name on the counter is not whichever
    // test happened to run last.
    expect((await getJson(app, '/api/v1/auth/me', { token: laptop.accessToken })).status).toBe(200);

    const rows = await app.client.query<{ key: string; hits: number; sessionId: string | null }>(
      'SELECT key, hits, sessionId FROM request_rate_limits'
    );
    // One row: every request in this file comes from the same loopback address.
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].sessionId).toBe(laptop.sessionId);
    // Still keyed by a digest of the address rather than the address; the session id is the
    // name beside the count, which is the whole point of recording it.
    expect(rows.rows[0].key).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(rows.rows)).not.toContain('127.0.0.1');

    // An unauthenticated request from the same client counts, and does not erase the name: it
    // is the same client, and the last login it proved was this one.
    const hitsBefore = rows.rows[0].hits;
    expect((await getJson(app, '/api/v1/auth/me')).status).toBe(401);
    const afterAnonymous = await app.client.query<{ hits: number; sessionId: string | null }>(
      'SELECT hits, sessionId FROM request_rate_limits'
    );
    expect(afterAnonymous.rows[0].sessionId).toBe(laptop.sessionId);
    expect(afterAnonymous.rows[0].hits).toBe(hitsBefore + 1);

    // A different login behind the same address becomes the name the operator sees.
    expect((await getJson(app, '/api/v1/auth/me', { token: phone.accessToken })).status).toBe(200);
    const afterPhone = await app.client.query<{ sessionId: string | null }>(
      'SELECT sessionId FROM request_rate_limits'
    );
    expect(afterPhone.rows[0].sessionId).toBe(phoneSession);
  });
});

describe('A window that has rolled over belongs to nobody', () => {
  let fastDir: string;
  let fast: RunningServer;

  beforeAll(async () => {
    fastDir = createTempDatabaseDir();
    // A quarter-second window, so the rollover can be observed instead of waited out.
    fast = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${fastDir}/fast-window.sqlite`,
      rateLimit: { max: 5000, windowMs: 250 }
    });
  });

  afterAll(async () => {
    await fast?.close();
    removeTempDatabaseDir(fastDir);
  });

  it('drops the previous window’s session rather than carrying it forward', async () => {
    const account = await login(fast, SEEDED.customer.phone);
    expect((await getJson(fast, '/api/v1/auth/me', { token: account.accessToken })).status).toBe(200);

    const attributed = await fast.client.query<{ sessionId: string | null }>(
      'SELECT sessionId FROM request_rate_limits'
    );
    expect(attributed.rows[0].sessionId).toMatch(/^sess_/);

    // Let the window close, then make the first request of the next one without a token: the
    // row is rolled over in place, and the device that was sending a moment ago is not named
    // as the one sending now.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect((await getJson(fast, '/api/v1/auth/me')).status).toBe(401);

    const rolled = await fast.client.query<{ hits: number; sessionId: string | null }>(
      'SELECT hits, sessionId FROM request_rate_limits'
    );
    expect(rolled.rows).toHaveLength(1);
    expect(rolled.rows[0].hits).toBe(1);
    expect(rolled.rows[0].sessionId).toBeNull();

    // And the next authenticated request names it again.
    expect((await getJson(fast, '/api/v1/auth/me', { token: account.accessToken })).status).toBe(200);
    const reattributed = await fast.client.query<{ sessionId: string | null }>(
      'SELECT sessionId FROM request_rate_limits'
    );
    expect(reattributed.rows[0].sessionId).toBe(attributed.rows[0].sessionId);
  });
});
