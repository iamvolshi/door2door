import * as crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatSessionRevokedMessage,
  SmsSecurityNoticeSender,
  settleSecurityNotices,
  type SecurityNotice,
  type SecurityNoticeSender
} from '../src/auth/securityNotices';
import { SessionService } from '../src/auth/sessionService';
import { createToken } from '../src/auth/tokens';
import type { SmsProviderClient } from '../src/auth/smsProviders';
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

interface SessionRow {
  id: string;
  familyId: string | null;
  replacedBy: string | null;
  isRevoked: number;
}

let tempDir: string;
let app: RunningServer;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function refresh(token: string): Promise<ApiResponse> {
  return postJson(app, '/api/v1/auth/refresh', { refreshToken: token });
}

async function sessionRowFor(refreshToken: string): Promise<SessionRow> {
  const rows = await app.client.query<SessionRow>(
    'SELECT id, familyId, replacedBy, isRevoked FROM auth_sessions WHERE tokenHash = ?',
    [sha256(refreshToken)]
  );
  expect(rows.rows.length).toBe(1);
  return rows.rows[0];
}

async function familyRows(familyId: string): Promise<SessionRow[]> {
  const rows = await app.client.query<SessionRow>(
    'SELECT id, familyId, replacedBy, isRevoked FROM auth_sessions WHERE familyId = ?',
    [familyId]
  );
  return rows.rows;
}

/** Opens a session without the OTP flow, so a suite can hold several logins per phone. */
async function startSessionFor(userId: string) {
  const user = await new UserRepository(app.client).findById(userId);
  expect(user).toBeTruthy();
  return new SessionService(app.client).startSession(user!);
}

describe('Refresh token reuse detection', () => {
  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({ port: 0, host: '127.0.0.1', databaseFile: `${tempDir}/reuse.sqlite` });
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  it('rotates a refresh token normally when it is used once', async () => {
    const account = await login(app, SEEDED.customer.phone);

    const first = await refresh(account.refreshToken);
    expect(first.status).toBe(200);

    const second = await refresh(first.body.tokens.refreshToken);
    expect(second.status).toBe(200);
    expect(second.body.tokens.refreshToken).not.toBe(first.body.tokens.refreshToken);

    // Every link in the chain shares one family, and each retired link points at its successor.
    const retired = await sessionRowFor(account.refreshToken);
    const middle = await sessionRowFor(first.body.tokens.refreshToken);
    const current = await sessionRowFor(second.body.tokens.refreshToken);

    expect(retired.isRevoked).toBe(1);
    expect(retired.replacedBy).toBe(first.body.session.id);
    expect(middle.replacedBy).toBe(second.body.session.id);
    expect(current.id).toBe(second.body.session.id);
    expect(current.isRevoked).toBe(0);
    expect(current.familyId).toBe(retired.familyId);
  });

  it('detects a replayed refresh token and revokes the whole family', async () => {
    const account = await login(app, SEEDED.admin.phone);

    const rotated = await refresh(account.refreshToken);
    expect(rotated.status).toBe(200);
    const rotatedToken = rotated.body.tokens.refreshToken;
    const familyId = (await sessionRowFor(account.refreshToken)).familyId;
    expect(familyId).toBeTruthy();

    // Replaying the spent token is refused, and it is treated as theft, not a retry.
    const replay = await refresh(account.refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSE');
    expect(replay.body.error.message).toMatch(/revoked/i);
    expect(replay.body.error.details.revokedSessions).toBe(1);

    // The attacker gains nothing: the token minted by the legitimate rotation is dead too.
    const afterBurn = await refresh(rotatedToken);
    expect(afterBurn.status).toBe(401);
    expect(afterBurn.body.error.code).toBe('REFRESH_TOKEN_REUSE');

    const rows = await familyRows(familyId!);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((row) => row.isRevoked === 1)).toBe(true);

    // No residual window: burning the family retires the access tokens it issued as well,
    // so the one handed out by that rotation stops opening routes at once rather than at
    // its own expiry.
    const me = await getJson(app, '/api/v1/auth/me', { token: rotated.body.tokens.accessToken });
    expect(me.status).toBe(401);
    expect(me.body.error.message).toMatch(/revoked/i);

    // The family's first access token is dead too, and so is the replayed chain's.
    const oldest = await getJson(app, '/api/v1/auth/me', { token: account.accessToken });
    expect(oldest.status).toBe(401);

    // Recovery is a fresh session, which lands in a new family and is live at once.
    const fresh = await startSessionFor(SEEDED.admin.id);
    const back = await getJson(app, '/api/v1/auth/me', { token: fresh.accessToken });
    expect(back.status).toBe(200);
    expect(back.body.user.id).toBe(SEEDED.admin.id);
  });

  it('retires the access token a rotation replaces, and keeps the new one usable', async () => {
    // Opened directly so the suite still makes one OTP request per phone number.
    const account = await startSessionFor(SEEDED.customer.id);

    const before = await getJson(app, '/api/v1/auth/me', { token: account.accessToken });
    expect(before.status).toBe(200);

    const rotated = await refresh(account.refreshToken);
    expect(rotated.status).toBe(200);

    // The retired link's access token dies with the session it named; the pair returned by
    // the rotation is what the client should now be using.
    const retired = await getJson(app, '/api/v1/auth/me', { token: account.accessToken });
    expect(retired.status).toBe(401);
    expect(retired.body.error.message).toMatch(/revoked/i);

    const current = await getJson(app, '/api/v1/auth/me', { token: rotated.body.tokens.accessToken });
    expect(current.status).toBe(200);
    expect(current.body.user.id).toBe(SEEDED.customer.id);
  });

  it('refuses an access token that names no session', async () => {
    // Minted straight from the signer, so it carries no session id: unverifiable, refused.
    const unbound = createToken(
      { userId: SEEDED.customer.id, role: 'CUSTOMER', type: 'access' },
      300
    );

    const response = await getJson(app, '/api/v1/auth/me', { token: unbound });
    expect(response.status).toBe(401);
    expect(response.body.error.message).toMatch(/not bound to a session/i);
  });

  it('refuses an access token whose session row is gone', async () => {
    const account = await startSessionFor(SEEDED.customer.id);

    await app.client.query('DELETE FROM auth_sessions WHERE id = ?', [account.sessionId]);

    const response = await getJson(app, '/api/v1/auth/me', { token: account.accessToken });
    expect(response.status).toBe(401);
    expect(response.body.error.message).toMatch(/known session/i);
  });

  it('records the incident in the audit log', async () => {
    const logs = await app.client.query<{ newValues: string }>(
      "SELECT newValues FROM audit_logs WHERE action = 'REFRESH_TOKEN_REUSE_DETECTED' ORDER BY createdAt ASC, rowid ASC"
    );

    expect(logs.rows.length).toBeGreaterThanOrEqual(1);
    const recorded = logs.rows.map(
      (row) => JSON.parse(row.newValues) as { familyId: string; revokedSessions: number }
    );

    // Every attempt names the family it was attributed to, so an incident is traceable.
    expect(recorded.every((entry) => typeof entry.familyId === 'string')).toBe(true);
    // The first strike retired the live session; replaying the token it produced finds
    // nothing left to kill, which is exactly how `revokedSessions: 0` should read.
    expect(recorded.some((entry) => entry.revokedSessions >= 1)).toBe(true);
    expect(recorded.some((entry) => entry.revokedSessions === 0)).toBe(true);
  });

  it('burns only the replayed family, leaving other logins of the same account alone', async () => {
    const adminUser = await new UserRepository(app.client).findById(SEEDED.admin.id);
    expect(adminUser).toBeTruthy();

    // A login on another device is a different family.
    const otherDevice = await new SessionService(app.client).startSession(adminUser!, {
      userAgent: 'vitest/other-device'
    });

    const stillWorks = await refresh(otherDevice.refreshToken);
    expect(stillWorks.status).toBe(200);
    expect(stillWorks.body.success).toBe(true);
  });

  it('lets only one of two concurrent refreshes win, then burns the family', async () => {
    const account = await login(app, SEEDED.merchant.phone);
    const familyId = (await sessionRowFor(account.refreshToken)).familyId;

    const [a, b] = await Promise.all([refresh(account.refreshToken), refresh(account.refreshToken)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(loser.body.error.code).toBe('REFRESH_TOKEN_REUSE');
    expect(winner.body.tokens.refreshToken).toBeTruthy();

    // The successful rotation is dead as well: nothing survives a detected reuse.
    const afterwards = await refresh(winner.body.tokens.refreshToken);
    expect(afterwards.status).toBe(401);
    expect(afterwards.body.error.code).toBe('REFRESH_TOKEN_REUSE');

    const rows = await familyRows(familyId!);
    expect(rows.every((row) => row.isRevoked === 1)).toBe(true);
  });

  it('treats a replay of a logged-out token as reuse rather than a fresh login', async () => {
    const account = await login(app, SEEDED.driver.phone);

    const before = await getJson(app, '/api/v1/auth/me', { token: account.accessToken });
    expect(before.status).toBe(200);

    const logout = await postJson(app, '/api/v1/auth/logout', { refreshToken: account.refreshToken });
    expect(logout.body.revoked).toBe(true);

    // Logging out ends the session for the access token it handed out as well, so nothing
    // has to wait for that token's own expiry.
    const afterLogout = await getJson(app, '/api/v1/auth/me', { token: account.accessToken });
    expect(afterLogout.status).toBe(401);

    const replay = await refresh(account.refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSE');
    expect(replay.body.error.details.revokedSessions).toBe(0); // nothing live was left to kill
  });

  it('does not flag a well-formed refresh token that was never issued', async () => {
    const forged = createToken(
      { userId: SEEDED.customer.id, role: 'CUSTOMER', type: 'refresh' },
      600
    );

    const response = await refresh(forged);
    expect(response.status).toBe(401);
    // No session row means no family to attribute the attempt to, so this is a plain 401.
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('tells the account owner their session was ended, after answering the replay', async () => {
    const dir = createTempDatabaseDir();
    const notices: SecurityNotice[] = [];
    const sender: SecurityNoticeSender = {
      deliver: async (notice) => {
        notices.push(notice);
        return { delivered: true, provider: 'stub', messageId: 'stub-1', attempts: 1, latencyMs: 3 };
      }
    };

    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${dir}/notice.sqlite`,
      noticeSender: sender
    });

    try {
      const account = await login(server, SEEDED.customer.phone);
      const rotated = await postJson(server, '/api/v1/auth/refresh', {
        refreshToken: account.refreshToken
      });
      expect(rotated.status).toBe(200);

      const replay = await postJson(server, '/api/v1/auth/refresh', {
        refreshToken: account.refreshToken
      });
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSE');

      await settleSecurityNotices();
      expect(notices).toHaveLength(1);

      // The account's own verified number, and the incident the notice belongs to.
      expect(notices[0].type).toBe('SESSION_REVOKED');
      expect(notices[0].userId).toBe(SEEDED.customer.id);
      expect(notices[0].phone).toBe(SEEDED.customer.phone);
      // The attempt travels with the id of the row it belongs to, so its outcome can be
      // stamped onto that notice rather than reconstructed later.
      expect(notices[0].noticeId).toMatch(/^ntf_/);
      const replayed = await server.client.query<{ id: string; familyId: string }>(
        'SELECT id, familyId FROM auth_sessions WHERE tokenHash = ?',
        [sha256(account.refreshToken)]
      );
      expect(notices[0].context).toMatchObject({
        reusedSessionId: replayed.rows[0].id,
        familyId: replayed.rows[0].familyId
      });

      // The wording has to say what happened, and what to do about it, in one SMS segment.
      const message = formatSessionRevokedMessage();
      expect(message).toMatch(/session was ended/i);
      expect(message).toMatch(/sign in again/i);
      expect(message).toMatch(/used twice/i);
      expect(message.length).toBeLessThanOrEqual(160);
    } finally {
      await server.close();
      removeTempDatabaseDir(dir);
    }
  });

  it('records that the owner could not be reached when no provider is configured', async () => {
    // The suite runs with SMS_MOCK_MODE on and no provider, which is the common case: the
    // notice is not sent, and the audit trail says exactly that rather than implying it was.
    // Opened directly so the suite still makes one OTP request per phone number.
    const account = await startSessionFor(SEEDED.merchant.id);
    const familyId = (await sessionRowFor(account.refreshToken)).familyId;

    const rotated = await refresh(account.refreshToken);
    expect(rotated.status).toBe(200);
    const replay = await refresh(account.refreshToken);
    expect(replay.status).toBe(401);

    await settleSecurityNotices();

    const rows = await app.client.query<{ action: string; newValues: string }>(
      "SELECT action, newValues FROM audit_logs WHERE entityId = ? AND action LIKE 'SECURITY_NOTICE_%' ORDER BY createdAt DESC, rowid DESC",
      [SEEDED.merchant.id]
    );
    expect(rows.rows[0].action).toBe('SECURITY_NOTICE_FAILED');
    const recorded = JSON.parse(rows.rows[0].newValues) as {
      channel: string;
      delivered: boolean;
      code: string;
    };
    expect(recorded).toMatchObject({ channel: 'SMS', delivered: false, code: 'SMS_NOT_SENT' });

    // The incident itself is still recorded, so the two facts stand apart.
    const incidents = await app.client.query<{ newValues: string }>(
      "SELECT newValues FROM audit_logs WHERE entityId = ? AND action = 'REFRESH_TOKEN_REUSE_DETECTED'",
      [SEEDED.merchant.id]
    );
    const families = incidents.rows.map((row) => JSON.parse(row.newValues).familyId as string);
    expect(families).toContain(familyId);
  });

  it('sends the warning through the provider when one is configured', async () => {
    const sent: Array<{ to: string; message: string }> = [];
    const stub: SmsProviderClient = {
      name: 'bulksmsbd',
      send: async (to, message) => {
        sent.push({ to, message });
        return {
          delivered: true,
          provider: 'bulksmsbd',
          attempts: 1,
          latencyMs: 2,
          providerStatus: '202',
          messageId: 'stub-5888'
        };
      }
    };

    const sender = new SmsSecurityNoticeSender(app.client, {
      createClient: () => stub,
      status: () => ({ provider: 'bulksmsbd', configured: true, mockMode: false, supported: true })
    });

    const result = await sender.deliver({
      type: 'SESSION_REVOKED',
      userId: SEEDED.driver.id,
      phone: SEEDED.driver.phone,
      context: {
        familyId: 'sess_family_for_notice_test',
        reusedSessionId: 'sess_reused_for_notice_test'
      }
    });

    expect(result).toMatchObject({ delivered: true, provider: 'bulksmsbd', providerStatus: '202' });
    expect(sent).toEqual([{ to: SEEDED.driver.phone, message: formatSessionRevokedMessage() }]);

    const rows = await app.client.query<{ action: string; newValues: string }>(
      "SELECT action, newValues FROM audit_logs WHERE entityId = ? AND action = 'SECURITY_NOTICE_SENT' ORDER BY createdAt DESC, rowid DESC",
      [SEEDED.driver.id]
    );
    expect(JSON.parse(rows.rows[0].newValues)).toMatchObject({
      channel: 'SMS',
      provider: 'bulksmsbd',
      delivered: true,
      providerStatus: '202',
      messageId: 'stub-5888'
    });
  });

  it('cannot turn a failing notifier into a failing refresh', async () => {
    const dir = createTempDatabaseDir();
    const sender: SecurityNoticeSender = {
      deliver: async () => {
        throw new Error('SMS gateway exploded');
      }
    };

    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${dir}/failing-notice.sqlite`,
      noticeSender: sender
    });

    try {
      const account = await login(server, SEEDED.admin.phone);
      await postJson(server, '/api/v1/auth/refresh', { refreshToken: account.refreshToken });
      const replay = await postJson(server, '/api/v1/auth/refresh', {
        refreshToken: account.refreshToken
      });

      // The security outcome is unchanged by a gateway that cannot take the message.
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSE');
      await expect(settleSecurityNotices()).resolves.toBeUndefined();
    } finally {
      await server.close();
      removeTempDatabaseDir(dir);
    }
  });

  it('finishes a notice already on its way when the server stops', async () => {
    const dir = createTempDatabaseDir();
    let finished = false;
    // Held open deliberately, so "still in flight" is a fact rather than a race.
    let releaseGateway: () => void = () => undefined;
    const gatewayAnswered = new Promise<void>((resolve) => {
      releaseGateway = resolve;
    });

    const sender: SecurityNoticeSender = {
      deliver: async () => {
        await gatewayAnswered;
        finished = true;
        return { delivered: true, provider: 'stub', attempts: 1, latencyMs: 1 };
      }
    };

    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${dir}/shutdown-notice.sqlite`,
      noticeSender: sender
    });

    try {
      const account = await login(server, SEEDED.customer.phone);
      await postJson(server, '/api/v1/auth/refresh', { refreshToken: account.refreshToken });
      const replay = await postJson(server, '/api/v1/auth/refresh', {
        refreshToken: account.refreshToken
      });
      expect(replay.status).toBe(401);
      expect(finished).toBe(false);

      // Closing waits for the notice: without the flush it would return with the warning
      // still unsent and the process about to exit.
      const closing = server.close();
      releaseGateway();
      await closing;
      expect(finished).toBe(true);
    } finally {
      releaseGateway();
      removeTempDatabaseDir(dir);
    }
  });

  it('does not flag an access token presented as a refresh token', async () => {
    // Built directly so the suite makes only one OTP request per phone number.
    const user = await new UserRepository(app.client).findById(SEEDED.merchant.id);
    const session = await new SessionService(app.client).startSession(user!);

    const wrongType = await refresh(session.accessToken);
    expect(wrongType.status).toBe(401);
    expect(wrongType.body.error.code).toBe('UNAUTHORIZED');

    // The family is untouched, so the real refresh token still rotates.
    const stillFine = await refresh(session.refreshToken);
    expect(stillFine.status).toBe(200);
  });
});
