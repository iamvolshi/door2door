import * as crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatSessionRevokedMessage,
  SESSION_REVOKED_TITLE,
  settleSecurityNotices,
  type SecurityNoticeSender
} from '../src/auth/securityNotices';
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
 * The second channel a security notice travels on.
 *
 * The SMS channel cannot always deliver: with no provider configured (the state this suite
 * runs in), no handset, or a gateway that refuses the message, the owner is signed out of
 * the burned session and told nothing. These tests hold the platform to the other half of
 * that promise — the warning is written to the account's own list, where signing in again
 * finds it, and it is on record before the 401 that caused it has even been answered.
 */

/** A number nothing else in the suite touches, since each one affords a single OTP request. */
const OWNER_PHONE = '+8801715550091';

let tempDir: string;
let app: RunningServer;
let ownerId: string;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

interface SessionRow {
  id: string;
  familyId: string;
}

/** The session a notice should name, and the family it belonged to. */
interface Incident {
  reusedSessionId: string;
  familyId: string;
}

/**
 * Opens a session for an existing account.
 *
 * This is the same call the OTP route makes once a verified code has proved the phone, so a
 * "sign-in" here is a real session pair rather than a fixture — and it is how the owner gets
 * back in after the burn, which the OTP resend cooldown would otherwise make slow.
 */
async function signIn(server: RunningServer, userId: string) {
  const user = await new UserRepository(server.client).findById(userId);
  expect(user, 'the account under test must exist').toBeTruthy();
  return new SessionService(server.client).startSession(user!);
}

function listNotices(server: RunningServer, token: string, query = ''): Promise<ApiResponse> {
  return getJson(server, `/api/v1/notifications${query}`, { token });
}

/**
 * Rotates a refresh token and then replays the spent one, which is the incident a security
 * notice exists for. Answers with the session that was replayed, so a test can tie the
 * notice it finds to the incident it caused.
 */
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

  const rows = await server.client.query<SessionRow>(
    'SELECT id, familyId FROM auth_sessions WHERE tokenHash = ?',
    [sha256(session.refreshToken)]
  );
  expect(rows.rows.length).toBe(1);
  return { reusedSessionId: rows.rows[0].id, familyId: rows.rows[0].familyId };
}

describe('Security notices reach the account holder without SMS', () => {
  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${tempDir}/notice-inbox.sqlite`,
      // This suite makes a request per assertion; the limiter must not be what answers.
      rateLimit: { max: 5000, windowMs: 60000 }
    });

    // A brand-new customer: their code proves the phone, registration creates the account.
    // Nothing about it is seeded, so its notice list starts empty.
    const request = await postJson(app, '/api/v1/auth/otp/request', { phone: OWNER_PHONE });
    expect(request.status).toBe(200);
    const register = await postJson(app, '/api/v1/auth/register', {
      phone: OWNER_PHONE,
      otp: request.body.devOtp,
      fullName: 'Rumana Akter',
      role: 'CUSTOMER'
    });
    expect(register.status).toBe(201);
    ownerId = register.body.user.id;
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  it('delivers the warning into the owner’s list when the SMS could not be sent', async () => {
    const incident = await burnFamily(app, ownerId);
    await settleSecurityNotices();

    // The SMS channel failed, and the trail says so rather than implying a delivery.
    const attempts = await app.client.query<{ action: string; newValues: string }>(
      "SELECT action, newValues FROM audit_logs WHERE entityId = ? AND action LIKE 'SECURITY_NOTICE_%' ORDER BY createdAt DESC, rowid DESC",
      [ownerId]
    );
    // Two attempts by now: the number claimed at registration, and the burned session. Both
    // went unsent, and the trail says so rather than implying a delivery.
    expect(attempts.rows.length).toBe(2);
    for (const attempt of attempts.rows) {
      expect(attempt.action).toBe('SECURITY_NOTICE_FAILED');
      expect(JSON.parse(attempt.newValues)).toMatchObject({
        channel: 'SMS',
        delivered: false,
        code: 'SMS_NOT_SENT'
      });
    }
    expect(JSON.parse(attempts.rows[0].newValues).type).toBe('SESSION_REVOKED');

    // The second channel delivered — to the owner, and without a provider anywhere near it.
    const signedIn = await signIn(app, ownerId);
    const listed = await listNotices(app, signedIn.accessToken);

    expect(listed.status).toBe(200);
    // Registering the number warned about the claim; burning the family added the second.
    expect(listed.body.count).toBe(2);
    expect(listed.body.notifications.map((entry: any) => entry.type).sort()).toEqual([
      'PHONE_CLAIMED',
      'SESSION_REVOKED'
    ]);
    expect(listed.body.unreadCount).toBe(2);

    const notice = listed.body.notifications.find((entry: any) => entry.type === 'SESSION_REVOKED');
    expect(notice.title).toBe(SESSION_REVOKED_TITLE);
    // The same wording the SMS would have carried, so the two channels cannot drift into
    // telling the owner different things.
    expect(notice.body).toBe(formatSessionRevokedMessage());
    expect(notice.body).toMatch(/session was ended/i);
    expect(notice.body).toMatch(/used twice/i);
    expect(notice.body).toMatch(/sign in again/i);
    expect(notice.read).toBe(false);
    expect(notice.readAt).toBeNull();
    // The incident it belongs to, kept apart from the wording a customer reads.
    expect(notice.details).toMatchObject({
      familyId: incident.familyId,
      reusedSessionId: incident.reusedSessionId
    });
  });

  it('has the notice on record before the 401 is answered, while the SMS is still in flight', async () => {
    const dir = createTempDatabaseDir();
    // Held open deliberately: the gateway answering is what the SMS channel is waiting for,
    // and the question is what the platform has already written down without it.
    let releaseGateway: () => void = () => undefined;
    const gatewayHeld = new Promise<void>((resolve) => {
      releaseGateway = resolve;
    });

    const sender: SecurityNoticeSender = {
      deliver: async () => {
        await gatewayHeld;
        return { delivered: true, provider: 'held-open', attempts: 1, latencyMs: 1 };
      }
    };

    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${dir}/in-flight.sqlite`,
      noticeSender: sender
    });

    try {
      const incident = await burnFamily(server, SEEDED.driver.id);

      // The gateway has not answered, and the warning is already in the account's list —
      // written before the replay's 401 was answered, not after some background task ran.
      const stored = await server.client.query<{ type: string; details: string }>(
        'SELECT type, details FROM notifications WHERE userId = ?',
        [SEEDED.driver.id]
      );
      expect(stored.rows.map((row) => row.type)).toContain('SESSION_REVOKED');
      expect(JSON.parse(stored.rows[0].details)).toMatchObject({
        reusedSessionId: incident.reusedSessionId
      });

      const listed = await listNotices(server, (await signIn(server, SEEDED.driver.id)).accessToken);
      expect(listed.status).toBe(200);
      expect(listed.body.count).toBe(1);
    } finally {
      releaseGateway();
      await settleSecurityNotices();
      await server.close();
      removeTempDatabaseDir(dir);
    }
  });

  it('keeps a notice private to its owner, even when somebody names its id', async () => {
    // A second, unrelated account.
    const other = await login(app, SEEDED.customer.phone);
    const theirs = await listNotices(app, other.accessToken);
    expect(theirs.body.count).toBe(0);

    const owner = await listNotices(app, (await signIn(app, ownerId)).accessToken);
    const noticeId = owner.body.notifications[0].id;

    // Naming somebody else's notice changes nothing on either side: the ids narrow a query
    // inside the caller's own rows, they never select another account's.
    const foreign = await postJson(
      app,
      '/api/v1/notifications/read',
      { ids: [noticeId] },
      { token: other.accessToken }
    );
    expect(foreign.status).toBe(200);
    expect(foreign.body.markedRead).toBe(0);
    expect(foreign.body.unreadCount).toBe(0);

    // Acknowledging everything the other account has is equally unable to reach it.
    const foreignAll = await postJson(
      app,
      '/api/v1/notifications/read',
      {},
      { token: other.accessToken }
    );
    expect(foreignAll.body.markedRead).toBe(0);

    const untouched = await listNotices(app, (await signIn(app, ownerId)).accessToken);
    // Neither of the owner's notices moved: the claim at registration and the burned session.
    expect(untouched.body.unreadCount).toBe(2);
    expect(untouched.body.notifications.every((entry: any) => entry.read === false)).toBe(true);
  });

  it('reads a notice once, and does not claim to read it again', async () => {
    const owner = await signIn(app, ownerId);

    const unread = await listNotices(app, owner.accessToken, '?unreadOnly=true');
    expect(unread.body.count).toBe(2);
    const sessionNotice = unread.body.notifications.find(
      (entry: any) => entry.type === 'SESSION_REVOKED'
    );
    expect(sessionNotice.read).toBe(false);

    // Acknowledged by id, so the unrelated notice is left alone — and the count proves it.
    const marked = await postJson(
      app,
      '/api/v1/notifications/read',
      { ids: [sessionNotice.id] },
      { token: owner.accessToken }
    );
    expect(marked.status).toBe(200);
    expect(marked.body).toMatchObject({ markedRead: 1, unreadCount: 1 });

    // A second acknowledgement reports what it actually changed, which is nothing.
    const again = await postJson(
      app,
      '/api/v1/notifications/read',
      { ids: [sessionNotice.id] },
      { token: owner.accessToken }
    );
    expect(again.body).toMatchObject({ markedRead: 0, unreadCount: 1 });

    const stillUnread = await listNotices(app, owner.accessToken, '?unreadOnly=true');
    expect(stillUnread.body.count).toBe(1);
    expect(stillUnread.body.notifications[0].type).toBe('PHONE_CLAIMED');

    // Reading it does not remove it: the warning stays in the history it belongs to.
    const all = await listNotices(app, owner.accessToken);
    expect(all.body.count).toBe(2);
    const read = all.body.notifications.find((entry: any) => entry.type === 'SESSION_REVOKED');
    expect(read.read).toBe(true);
    expect(typeof read.readAt).toBe('string');
  });

  it('refuses a malformed acknowledgement instead of guessing what it meant', async () => {
    const owner = await signIn(app, ownerId);

    const refused: ApiResponse[] = [
      await listNotices(app, owner.accessToken, '?limit=0'),
      await listNotices(app, owner.accessToken, '?limit=abc'),
      // Above the cap: reported rather than silently answered with fewer notices than asked.
      await listNotices(app, owner.accessToken, '?limit=1000'),
      await postJson(app, '/api/v1/notifications/read', { ids: [] }, { token: owner.accessToken }),
      await postJson(app, '/api/v1/notifications/read', { ids: 'ntf_1' }, { token: owner.accessToken }),
      await postJson(app, '/api/v1/notifications/read', { ids: [1] }, { token: owner.accessToken })
    ];

    for (const response of refused) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('is still there after the process is replaced, which is what makes it a channel', async () => {
    const dir = createTempDatabaseDir();
    const databaseFile = `${dir}/durable-notice.sqlite`;

    const first = await startServer({ port: 0, host: '127.0.0.1', databaseFile });
    try {
      await burnFamily(first, SEEDED.merchant.id);
      const listed = await listNotices(first, (await signIn(first, SEEDED.merchant.id)).accessToken);
      expect(listed.body.count).toBe(1);
    } finally {
      await first.close();
    }

    // A different process against the same database: the warning was written down, not just
    // shown once to whoever happened to be connected.
    const restarted = await startServer({ port: 0, host: '127.0.0.1', databaseFile });
    try {
      const listed = await listNotices(
        restarted,
        (await signIn(restarted, SEEDED.merchant.id)).accessToken
      );
      expect(listed.status).toBe(200);
      expect(listed.body.count).toBe(1);
      expect(listed.body.notifications[0].type).toBe('SESSION_REVOKED');
      expect(listed.body.notifications[0].read).toBe(false);
    } finally {
      await restarted.close();
      removeTempDatabaseDir(dir);
    }
  });
});
