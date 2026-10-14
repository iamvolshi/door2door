import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SECURITY_NOTICE_COPY, settleSecurityNotices } from '../src/auth/securityNotices';
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
 * The events a security notice now covers besides a burned session family.
 *
 * An administrator refusing an application, an administrator suspending an account, and a
 * phone number that has just had an account created on it all end with the same thing: the
 * account holder has to be told, on a channel that works even when a text message cannot be
 * delivered. These tests drive each event through the live API and read the result back the
 * way its owner would — and the way an operator would.
 */

let tempDir: string;
let app: RunningServer;
let adminToken: string;

const ADMIN_PHONE = SEEDED.admin.phone;

/** Phone numbers used once each: a number affords one OTP request per resend cooldown. */
const PHONE = {
  claimed: '+8801715550101',
  merchant: '+8801715550102',
  suspendedWithSession: '+8801715550103',
  suspendedBeforeSignIn: '+8801715550104',
  plainFixture: '+8801715550105',
  guard: '+8801715550107'
} as const;

function notices(server: RunningServer, token: string, query = ''): Promise<ApiResponse> {
  return getJson(server, `/api/v1/admin/security-notices${query}`, { token });
}

function listNotices(server: RunningServer, token: string, query = ''): Promise<ApiResponse> {
  return getJson(server, `/api/v1/notifications${query}`, { token });
}

/** The same call the OTP route makes once a code is verified. */
async function signIn(server: RunningServer, userId: string) {
  const user = await new UserRepository(server.client).findById(userId);
  expect(user, 'the account under test must exist').toBeTruthy();
  return new SessionService(server.client).startSession(user!);
}

/** Registers through the real flow: one OTP request, then the application. */
async function register(
  phone: string,
  role: 'CUSTOMER' | 'MERCHANT',
  details?: Record<string, string>
): Promise<ApiResponse> {
  const request = await postJson(app, '/api/v1/auth/otp/request', { phone });
  expect(request.status).toBe(200);

  return postJson(app, '/api/v1/auth/register', {
    phone,
    otp: request.body.devOtp,
    fullName: 'Fixture Applicant',
    role,
    ...(details ? { details } : {})
  });
}

/** Inserts an account directly, for a state the registration flow cannot reach quickly. */
async function insertAccount(
  phone: string,
  role: 'CUSTOMER' | 'ADMIN',
  fullName: string
): Promise<string> {
  const id = `usr_fixture_${phone.slice(-4)}`;
  const now = new Date().toISOString();
  await app.client.query(
    `INSERT INTO users (id, email, phone, fullName, role, isActive, approvalStatus, approvalReason, registrationDetails, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      `${phone.slice(-4)}@fixture.coxsbazar.delivery`,
      phone,
      fullName,
      role,
      1,
      'APPROVED',
      null,
      null,
      now,
      now
    ]
  );
  return id;
}

describe('Security notices for the other events worth a warning', () => {
  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${tempDir}/notice-events.sqlite`,
      rateLimit: { max: 5000, windowMs: 60000 }
    });
    adminToken = (await login(app, ADMIN_PHONE)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  it('warns the account a newly claimed phone number now belongs to', async () => {
    const registered = await register(PHONE.claimed, 'CUSTOMER');
    expect(registered.status).toBe(201);
    const ownerId = registered.body.user.id;

    // Registration returns a session, so the warning is readable immediately — before any
    // SMS has had a chance to fail.
    const mine = await listNotices(app, registered.body.tokens.accessToken);
    expect(mine.status).toBe(200);
    expect(mine.body.count).toBe(1);

    const [notice] = mine.body.notifications;
    expect(notice.type).toBe('PHONE_CLAIMED');
    expect(notice.title).toBe(SECURITY_NOTICE_COPY.PHONE_CLAIMED.title);
    expect(notice.body).toBe(SECURITY_NOTICE_COPY.PHONE_CLAIMED.body);
    expect(notice.read).toBe(false);
    expect(notice.details).toMatchObject({ role: 'CUSTOMER', approvalStatus: 'APPROVED' });

    // It is a notice about one account, not an announcement.
    const other = await login(app, SEEDED.customer.phone);
    expect((await listNotices(app, other.accessToken)).body.count).toBe(0);

    // And the attempt is on the operator's side of the platform, labelled with what it was.
    const operator = await notices(app, adminToken, `?type=PHONE_CLAIMED&userId=${ownerId}`);
    expect(operator.body.count).toBe(1);
    expect(operator.body.notices[0].outOfBand).toMatchObject({
      state: 'FAILED',
      channel: 'SMS',
      code: 'SMS_NOT_SENT'
    });
    expect(operator.body.notices[0].customer.phone).toBe(PHONE.claimed);
  });

  it('warns an applicant whose registration an administrator refused', async () => {
    const registered = await register(PHONE.merchant, 'MERCHANT', {
      businessName: 'Fixture Store',
      tradeLicenseNumber: 'TRAD-9911',
      streetAddress: 'House 4, Road 2, Kolatoli',
      area: 'Kolatoli',
      district: "Cox's Bazar"
    });
    expect(registered.status).toBe(201);
    expect(registered.body.approvalRequired).toBe(true);
    const applicantId = registered.body.user.id;

    const reason = 'Trade licence could not be verified with the city corporation';
    const rejected = await postJson(
      app,
      `/api/v1/admin/registrations/${applicantId}/reject`,
      { reason },
      { token: adminToken }
    );
    expect(rejected.status).toBe(200);
    await settleSecurityNotices();

    const listed = await listNotices(app, registered.body.tokens.accessToken);
    expect(listed.status).toBe(200);
    // The claim at registration, and the refusal afterwards.
    expect(listed.body.notifications.map((entry: any) => entry.type).sort()).toEqual([
      'PHONE_CLAIMED',
      'REGISTRATION_REJECTED'
    ]);

    const rejection = listed.body.notifications.find(
      (entry: any) => entry.type === 'REGISTRATION_REJECTED'
    );
    expect(rejection.title).toBe(SECURITY_NOTICE_COPY.REGISTRATION_REJECTED.title);
    expect(rejection.body).toBe(SECURITY_NOTICE_COPY.REGISTRATION_REJECTED.body);
    // The administrator's words are kept in the record, and never travel as the message.
    expect(rejection.details).toMatchObject({
      role: 'MERCHANT',
      reason,
      reviewedBy: SEEDED.admin.id
    });
    expect(rejection.body).not.toContain('licence');
    expect(rejection.title).not.toContain('licence');

    const attempts = await app.client.query<{ action: string; newValues: string }>(
      "SELECT action, newValues FROM audit_logs WHERE entityId = ? AND action LIKE 'SECURITY_NOTICE_%' ORDER BY createdAt DESC, rowid DESC",
      [applicantId]
    );
    expect(attempts.rows).toHaveLength(2);
    expect(JSON.parse(attempts.rows[0].newValues)).toMatchObject({
      type: 'REGISTRATION_REJECTED',
      channel: 'SMS',
      code: 'SMS_NOT_SENT'
    });
  });

  it('cuts off the sessions a suspended account already holds, and warns it', async () => {
    const ownerId = await insertAccount(PHONE.suspendedWithSession, 'CUSTOMER', 'Suspended Session');
    const signedIn = await login(app, PHONE.suspendedWithSession);
    expect((await getJson(app, '/api/v1/auth/me', { token: signedIn.accessToken })).status).toBe(200);

    const suspended = await postJson(
      app,
      `/api/v1/admin/users/${ownerId}/suspend`,
      { reason: 'Chargeback fraud reported by two merchants' },
      { token: adminToken }
    );
    expect(suspended.status).toBe(200);
    expect(suspended.body.account).toMatchObject({ id: ownerId, isActive: false, role: 'CUSTOMER' });
    // The session the account was holding is retired as part of the suspension, not left to
    // run out its access token.
    expect(suspended.body.revokedSessions).toBeGreaterThanOrEqual(1);

    const after = await getJson(app, '/api/v1/auth/me', { token: signedIn.accessToken });
    expect(after.status).toBe(401);
    expect(String(after.body.error.message)).toMatch(/revoked/i);
    // A refresh token from the same account is refused too, so the client cannot mint a new
    // access token from the one it kept. The refusal names the account being inactive: the
    // rotation path checks that before it looks at the session at all.
    const refreshed = await postJson(app, '/api/v1/auth/refresh', {
      refreshToken: signedIn.refreshToken
    });
    expect(refreshed.status).toBe(403);
    expect(String(refreshed.body.error.message)).toMatch(/inactive/i);

    await settleSecurityNotices();
    const notice = await app.client.query<{ type: string; details: string }>(
      'SELECT type, details FROM notifications WHERE userId = ?',
      [ownerId]
    );
    expect(notice.rows).toHaveLength(1);
    expect(notice.rows[0].type).toBe('ACCOUNT_SUSPENDED');
    expect(JSON.parse(notice.rows[0].details)).toMatchObject({
      role: 'CUSTOMER',
      reason: 'Chargeback fraud reported by two merchants',
      suspendedBy: SEEDED.admin.id
    });

    // An operator can see that this customer was never reached by text, while the account is
    // locked out and cannot read its own list — which is exactly the follow-up case.
    const queue = await notices(app, adminToken, `?type=ACCOUNT_SUSPENDED&followUpOnly=true`);
    const mine = queue.body.notices.find((entry: any) => entry.userId === ownerId);
    expect(mine, 'the suspended account should be in the follow-up queue').toBeTruthy();
    // The notice names its account once, and the joined customer agrees with it.
    expect(mine.customer.id).toBe(ownerId);
    expect(mine.outOfBand.state).toBe('FAILED');
    expect(mine.followUp).toBe(true);
  });

  it('refuses a sign-in for a suspended account', async () => {
    // Suspended before it ever asks for a code, so the refusal happens at the login gate
    // rather than at a session that was already retired.
    const ownerId = await insertAccount(PHONE.suspendedBeforeSignIn, 'CUSTOMER', 'Suspended Login');
    const suspended = await postJson(
      app,
      `/api/v1/admin/users/${ownerId}/suspend`,
      { reason: 'Account under investigation' },
      { token: adminToken }
    );
    expect(suspended.status).toBe(200);

    const request = await postJson(app, '/api/v1/auth/otp/request', {
      phone: PHONE.suspendedBeforeSignIn
    });
    expect(request.status).toBe(200);
    const verify = await postJson(app, '/api/v1/auth/otp/verify', {
      phone: PHONE.suspendedBeforeSignIn,
      otp: request.body.devOtp
    });

    expect(verify.status).toBe(403);
    expect(String(verify.body.error.message)).toMatch(/inactive/i);
  });

  it('restores access on reinstatement, where the notice is waiting', async () => {
    const ownerId = await insertAccount(PHONE.plainFixture, 'CUSTOMER', 'Reinstated Fixture');
    const suspended = await postJson(
      app,
      `/api/v1/admin/users/${ownerId}/suspend`,
      { reason: 'Suspended in error' },
      { token: adminToken }
    );
    expect(suspended.status).toBe(200);

    const reinstated = await postJson(
      app,
      `/api/v1/admin/users/${ownerId}/reinstate`,
      {},
      { token: adminToken }
    );
    expect(reinstated.status).toBe(200);
    expect(reinstated.body.account).toMatchObject({ id: ownerId, isActive: true });
    // Nothing was revoked by the reinstatement itself; the sessions retired at suspension
    // stay retired, and the owner signs in again to get new ones.
    expect(reinstated.body.revokedSessions).toBe(0);

    await settleSecurityNotices();
    // The account can hold a session again, and that is when it finds the warning the
    // suspension could not deliver while it was locked out.
    const session = await signIn(app, ownerId);
    expect((await getJson(app, '/api/v1/auth/me', { token: session.accessToken })).status).toBe(200);

    const listed = await listNotices(app, session.accessToken);
    expect(listed.status).toBe(200);
    expect(listed.body.notifications[0].type).toBe('ACCOUNT_SUSPENDED');
    expect(listed.body.notifications[0].read).toBe(false);
  });

  it('refuses the suspensions an administrator must not be able to make', async () => {
    const customerId = await insertAccount(PHONE.guard, 'CUSTOMER', 'Guard Fixture');
    const otherAdminId = await insertAccount('+8801715550106', 'ADMIN', 'Second Administrator');
    // Any account without the grant will do; the point is that it is not an administrator.
    const outsider = await login(app, SEEDED.driver.phone);

    const attempts: Array<{ response: ApiResponse; expect: string }> = [
      {
        // No reason: a suspension nobody can explain is one nobody can review.
        response: await postJson(
          app,
          `/api/v1/admin/users/${customerId}/suspend`,
          {},
          { token: adminToken }
        ),
        expect: 'reason'
      },
      {
        // An administrator's own account: there is no second administrator to undo it.
        response: await postJson(
          app,
          `/api/v1/admin/users/${SEEDED.admin.id}/suspend`,
          { reason: 'Self-inflicted' },
          { token: adminToken }
        ),
        expect: 'own account'
      },
      {
        response: await postJson(
          app,
          `/api/v1/admin/users/${otherAdminId}/suspend`,
          { reason: 'Administrator' },
          { token: adminToken }
        ),
        expect: 'Administrator accounts'
      },
      {
        // A status that does not exist is a 404, not a created account.
        response: await postJson(
          app,
          '/api/v1/admin/users/usr_not_a_real_user/suspend',
          { reason: 'Nobody' },
          { token: adminToken }
        ),
        expect: 'not found'
      },
      {
        // An account without the grant cannot close anybody's, not even its own.
        response: await postJson(
          app,
          `/api/v1/admin/users/${customerId}/suspend`,
          { reason: 'Not allowed' },
          { token: outsider.accessToken }
        ),
        expect: 'system:manage'
      }
    ];

    for (const { response, expect: expected } of attempts) {
      expect([400, 403, 404]).toContain(response.status);
      expect(String(response.body.error.message)).toContain(expected);
    }
    expect(attempts[4].response.status).toBe(403);

    // Suspending twice, and reinstating what was never suspended, are conflicts rather than
    // silent no-ops: the caller has to know the state it was acting on was not the state.
    const suspended = await postJson(
      app,
      `/api/v1/admin/users/${customerId}/suspend`,
      { reason: 'First suspension' },
      { token: adminToken }
    );
    expect(suspended.status).toBe(200);

    const twice = await postJson(
      app,
      `/api/v1/admin/users/${customerId}/suspend`,
      { reason: 'Second suspension' },
      { token: adminToken }
    );
    expect(twice.status).toBe(409);

    // The reverse: reinstating a live account is a conflict, the same way suspending a
    // suspended one is, and neither is a silent no-op.
    const reinstated = await postJson(
      app,
      `/api/v1/admin/users/${customerId}/reinstate`,
      {},
      { token: adminToken }
    );
    expect(reinstated.status).toBe(200);

    const again = await postJson(
      app,
      `/api/v1/admin/users/${customerId}/reinstate`,
      {},
      { token: adminToken }
    );
    expect(again.status).toBe(409);
  });

  it('keeps every notice within one SMS segment', () => {
    for (const [type, copy] of Object.entries(SECURITY_NOTICE_COPY)) {
      expect(copy.body.length, `${type} must travel as a single SMS segment`).toBeLessThanOrEqual(
        160
      );
      expect(copy.body.length).toBeGreaterThan(0);
      expect(copy.title.length).toBeLessThanOrEqual(80);
      // A warning that names nobody and asks for no link is one the owner can act on without
      // trusting the message.
      expect(copy.body).toMatch(/Cox's Bazar Door2Door|this phone number/);
    }
  });

  it('lets an operator separate an incident from a claim', async () => {
    // Four accounts were suspended in this file, and each suspension warned its owner once.
    const incidents = await notices(app, adminToken, '?type=ACCOUNT_SUSPENDED');
    expect(incidents.body.count).toBe(4);
    for (const entry of incidents.body.notices) {
      expect(entry.type).toBe('ACCOUNT_SUSPENDED');
    }

    const claims = await notices(app, adminToken, '?type=PHONE_CLAIMED');
    expect(claims.body.count).toBe(2);

    const everything = await notices(app, adminToken, '?type=ALL');
    expect(everything.body.count).toBeGreaterThanOrEqual(5);

    const refused = await notices(app, adminToken, '?type=NOT_A_TYPE');
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_ERROR');
  });
});
