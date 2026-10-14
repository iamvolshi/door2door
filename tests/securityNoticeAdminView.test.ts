import * as crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_REVOKED_TITLE, settleSecurityNotices, type SecurityNoticeSender } from '../src/auth/securityNotices';
import { SessionService } from '../src/auth/sessionService';
import { UserRepository } from '../src/db/repositories';
import {
  SEEDED,
  createTempDatabaseDir,
  getJson,
  login,
  postJson,
  removeTempDatabaseDir,
  startServer,
  type ApiResponse,
  type RunningServer
} from './apiTestClient';

/**
 * The operator's view of security notices.
 *
 * A warning the owner never received is invisible from the outside: the account was signed
 * out, the SMS may have failed, and nothing in the response said so. This view exists to make
 * that visible across every account, with the account it belongs to — so it is asserted here
 * from the operator's side: who was warned, how it went, and which accounts are still worth
 * following up.
 */

interface Incident {
  reusedSessionId: string;
  familyId: string;
}

let tempDir: string;
let app: RunningServer;
let adminToken: string;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function signIn(server: RunningServer, userId: string) {
  const user = await new UserRepository(server.client).findById(userId);
  expect(user, 'the account under test must exist').toBeTruthy();
  return new SessionService(server.client).startSession(user!);
}

/** Rotates a refresh token, then replays the spent one: the incident a notice is written for. */
async function burnFamily(server: RunningServer, userId: string): Promise<Incident> {
  const session = await signIn(server, userId);
  const rotated = await postJson(server, '/api/v1/auth/refresh', {
    refreshToken: session.refreshToken
  });
  expect(rotated.status).toBe(200);

  const replay = await postJson(server, '/api/v1/auth/refresh', {
    refreshToken: session.refreshToken
  });
  expect(replay.status).toBe(401);
  expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSE');

  const rows = await server.client.query<{ id: string; familyId: string }>(
    'SELECT id, familyId FROM auth_sessions WHERE tokenHash = ?',
    [sha256(session.refreshToken)]
  );
  expect(rows.rows.length).toBe(1);
  return { reusedSessionId: rows.rows[0].id, familyId: rows.rows[0].familyId };
}

function notices(server: RunningServer, token: string, query = ''): Promise<ApiResponse> {
  return getJson(server, `/api/v1/admin/security-notices${query}`, { token });
}

describe('Security notices as an operator sees them', () => {
  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${tempDir}/operator-view.sqlite`,
      rateLimit: { max: 5000, windowMs: 60000 }
    });

    // Two incidents for two different customers, both with no SMS provider configured —
    // the state most of the world is in, and the one an operator has to be able to see.
    await burnFamily(app, SEEDED.customer.id);
    await burnFamily(app, SEEDED.driver.id);
    await settleSecurityNotices();

    adminToken = (await login(app, SEEDED.admin.phone)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  it('lists every notice with its outcome and the account it belongs to', async () => {
    const listed = await notices(app, adminToken);

    expect(listed.status).toBe(200);
    expect(listed.body.count).toBe(2);
    // Newest first, so the driver's incident is ahead of the customer's.
    const [newest, oldest] = listed.body.notices;
    expect(newest.customer.phone).toBe(SEEDED.driver.phone);
    expect(oldest.customer.phone).toBe(SEEDED.customer.phone);

    expect(newest.type).toBe('SESSION_REVOKED');
    expect(newest.title).toBe(SESSION_REVOKED_TITLE);
    expect(newest.read).toBe(false);
    // The incident it belongs to, so the row can be tied back to the audit trail.
    expect(newest.details).toMatchObject({ reusedSessionId: expect.any(String) });

    // The delivery outcome is read off the notice itself, not reconstructed.
    expect(newest.outOfBand).toMatchObject({
      state: 'FAILED',
      channel: 'SMS',
      delivered: false,
      provider: 'none',
      code: 'SMS_NOT_SENT'
    });
    expect(typeof newest.outOfBand.attemptedAt).toBe('string');

    // Nobody was reached, and nobody has read it: both rows are follow-up work.
    expect(newest.followUp).toBe(true);
    expect(oldest.followUp).toBe(true);
    expect(listed.body.summary).toEqual({
      total: 2,
      delivered: 0,
      failed: 2,
      unknown: 0,
      read: 0,
      followUp: 2
    });
  });

  it('drops a notice from the follow-up list once its owner has read it', async () => {
    const driver = await signIn(app, SEEDED.driver.id);
    const acknowledged = await postJson(
      app,
      '/api/v1/notifications/read',
      {},
      { token: driver.accessToken }
    );
    expect(acknowledged.body.markedRead).toBe(1);

    const queue = await notices(app, adminToken, '?followUpOnly=true');
    expect(queue.body.count).toBe(1);
    expect(queue.body.notices[0].customer.phone).toBe(SEEDED.customer.phone);

    // Still on the list, and still undelivered: reading it does not rewrite what the SMS did.
    const all = await notices(app, adminToken);
    const driverNotice = all.body.notices.find(
      (notice: any) => notice.customer.phone === SEEDED.driver.phone
    );
    expect(driverNotice.outOfBand.state).toBe('FAILED');
    expect(driverNotice.followUp).toBe(false);
    expect(all.body.summary).toEqual({
      total: 2,
      delivered: 0,
      failed: 2,
      unknown: 0,
      read: 1,
      followUp: 1
    });
  });

  it('filters by state without the summary losing the ratio it reports', async () => {
    const delivered = await notices(app, adminToken, '?state=DELIVERED');
    expect(delivered.body.count).toBe(0);
    // The summary deliberately ignores the state filter: "none delivered" is only meaningful
    // beside "two failed".
    expect(delivered.body.summary.total).toBe(2);
    expect(delivered.body.summary.failed).toBe(2);

    const failed = await notices(app, adminToken, '?state=FAILED');
    expect(failed.body.count).toBe(2);

    const unknown = await notices(app, adminToken, '?state=UNKNOWN');
    expect(unknown.body.count).toBe(0);

    const everything = await notices(app, adminToken, '?state=ALL');
    expect(everything.body.count).toBe(2);
  });

  it('filters by account, by time, and by page size', async () => {
    const oneAccount = await notices(app, adminToken, `?userId=${SEEDED.customer.id}`);
    expect(oneAccount.body.count).toBe(1);
    expect(oneAccount.body.notices[0].customer.id).toBe(SEEDED.customer.id);

    const future = new Date(Date.now() + 60_000).toISOString();
    const nothingYet = await notices(app, adminToken, `?since=${encodeURIComponent(future)}`);
    expect(nothingYet.body.count).toBe(0);

    const past = new Date(Date.now() - 60_000).toISOString();
    const both = await notices(app, adminToken, `?since=${encodeURIComponent(past)}`);
    expect(both.body.count).toBe(2);

    // The page is capped; the summary is not, because it describes the whole set.
    const page = await notices(app, adminToken, '?limit=1');
    expect(page.body.count).toBe(1);
    expect(page.body.summary.total).toBe(2);
  });

  it('separates an owner who is locked out from one who can still read their list', async () => {
    // Nothing is locked out yet: both accounts hold working sessions and can read whatever
    // they have been told, so the priority worklist is empty even though the SMS failed.
    const before = await notices(app, adminToken, '?followUpOnly=true&lockedOutOnly=true');
    expect(before.body.count).toBe(0);

    // A third account, warned and unreached but still able to sign in — the case the filter
    // has to leave out, because its owner can still reach the warning by signing in.
    await burnFamily(app, SEEDED.merchant.id);
    await settleSecurityNotices();

    const customerSession = await signIn(app, SEEDED.customer.id);
    expect(
      (await getJson(app, '/api/v1/auth/me', { token: customerSession.accessToken })).status
    ).toBe(200);

    // Now suspend that account. Its unread warning is joined by the suspension notice, and
    // from here on nobody can sign in to read either of them.
    const suspended = await postJson(
      app,
      `/api/v1/admin/users/${SEEDED.customer.id}/suspend`,
      { reason: 'Chargeback fraud reported by two merchants' },
      { token: adminToken }
    );
    expect(suspended.status).toBe(200);
    await settleSecurityNotices();

    // Proved rather than assumed: the session it held is gone, and a fresh sign-in is refused.
    expect(
      (await getJson(app, '/api/v1/auth/me', { token: customerSession.accessToken })).status
    ).toBe(401);
    const otp = await postJson(app, '/api/v1/auth/otp/request', { phone: SEEDED.customer.phone });
    expect(otp.status).toBe(200);
    const refusedLogin = await postJson(app, '/api/v1/auth/otp/verify', {
      phone: SEEDED.customer.phone,
      otp: otp.body.devOtp
    });
    expect(refusedLogin.status).toBe(403);
    expect(String(refusedLogin.body.error.message)).toMatch(/inactive/i);

    // Unreached warnings, across both accounts.
    const followUp = await notices(app, adminToken, '?followUpOnly=true');
    expect(followUp.body.count).toBe(3);

    // The same set narrowed to the owners nobody can reach on this list at all.
    const lockedOut = await notices(app, adminToken, '?followUpOnly=true&lockedOutOnly=true');
    expect(lockedOut.body.count).toBe(2);
    for (const entry of lockedOut.body.notices) {
      expect(entry.userId).toBe(SEEDED.customer.id);
      expect(entry.lockedOut).toBe(true);
      expect(entry.followUp).toBe(true);
      expect(entry.customer).toMatchObject({ isActive: false, approvalStatus: 'APPROVED' });
    }
    expect(lockedOut.body.notices.map((entry: any) => entry.type).sort()).toEqual([
      'ACCOUNT_SUSPENDED',
      'SESSION_REVOKED'
    ]);

    // The account that is merely unreached is still distinguishable from the one that is
    // locked out, on the same page.
    const merchant = followUp.body.notices.find(
      (entry: any) => entry.userId === SEEDED.merchant.id
    );
    expect(merchant).toMatchObject({ followUp: true, lockedOut: false });
    expect(merchant.customer.isActive).toBe(true);

    // Narrowing the worklist does not narrow what is counted: the ratio is over every notice
    // the account and time filters admit, so "none delivered" stays meaningful.
    expect(lockedOut.body.summary).toEqual(followUp.body.summary);
    expect(lockedOut.body.summary.total).toBe(4);

    // Reinstating the account moves it out of the priority worklist without touching the
    // notice — the warning is still unreached, and now its owner can read it.
    const reinstated = await postJson(
      app,
      `/api/v1/admin/users/${SEEDED.customer.id}/reinstate`,
      {},
      { token: adminToken }
    );
    expect(reinstated.status).toBe(200);

    const after = await notices(app, adminToken, '?followUpOnly=true&lockedOutOnly=true');
    expect(after.body.count).toBe(0);
    const stillUnreached = await notices(app, adminToken, `?userId=${SEEDED.customer.id}`);
    expect(stillUnreached.body.notices.every((entry: any) => entry.followUp === true)).toBe(true);
    expect(stillUnreached.body.notices.every((entry: any) => entry.lockedOut === false)).toBe(true);
  });

  it('reports an attempt that never reported back as unknown, not as a failure', async () => {
    const dir = createTempDatabaseDir();
    // A notifier that never writes an outcome: the shape of a process killed between storing
    // the notice and hearing from the gateway.
    const sender: SecurityNoticeSender = {
      deliver: async () => ({ delivered: false, provider: 'silent' })
    };

    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${dir}/silent-notifier.sqlite`,
      noticeSender: sender
    });

    try {
      await burnFamily(server, SEEDED.merchant.id);
      await settleSecurityNotices();

      const operator = (await login(server, SEEDED.admin.phone)).accessToken;
      const listed = await notices(server, operator);

      expect(listed.body.count).toBe(1);
      const [notice] = listed.body.notices;
      expect(notice.outOfBand).toEqual({ state: 'UNKNOWN' });
      // Nothing is known, so it is work to do, not a delivery to trust.
      expect(notice.followUp).toBe(true);
      expect(listed.body.summary).toMatchObject({ total: 1, delivered: 0, failed: 0, unknown: 1, followUp: 1 });

      const queue = await notices(server, operator, '?state=UNKNOWN&followUpOnly=true');
      expect(queue.body.count).toBe(1);
    } finally {
      await server.close();
      removeTempDatabaseDir(dir);
    }
  });

  it('refuses a malformed filter instead of answering a different question', async () => {
    const refused: ApiResponse[] = [
      await notices(app, adminToken, '?state=bogus'),
      await notices(app, adminToken, '?followUpOnly=maybe'),
      await notices(app, adminToken, '?lockedOutOnly=maybe'),
      await notices(app, adminToken, '?since=not-a-date'),
      await notices(app, adminToken, '?limit=0'),
      await notices(app, adminToken, '?limit=1000')
    ];

    for (const response of refused) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('is operator-only and read-only', async () => {
    // The customer the view is about cannot read it, nor can any non-admin role: the incidents
    // of every account are not one account's business. The session is issued directly rather
    // than through a login, because the refusal under test is authorization and the number's
    // one-OTP-a-minute cooldown belongs to the test that proved it cannot sign in while
    // suspended.
    const customer = await signIn(app, SEEDED.customer.id);
    const forbidden = await notices(app, customer.accessToken);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
    expect(String(forbidden.body.error.message)).toContain('audit:read');

    // No token at all is the router's gate, not a handler's.
    const anonymous = await getJson(app, '/api/v1/admin/security-notices');
    expect(anonymous.status).toBe(401);

    // Read-only: the path answers no mutating verb.
    const attemptedWrite = await postJson(app, '/api/v1/admin/security-notices', {}, { token: adminToken });
    expect(attemptedWrite.status).toBe(405);
  });
});
