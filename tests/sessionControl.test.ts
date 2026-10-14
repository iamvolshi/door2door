import * as crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionService, type IssuedSession } from '../src/auth/sessionService';
import { createToken } from '../src/auth/tokens';
import { UserRepository } from '../src/db/repositories';
import {
  SEEDED,
  apiRequest,
  createTempDatabaseDir,
  getJson,
  login,
  postJson,
  removeTempDatabaseDir,
  startServer,
  type ApiResponse,
  type LoggedInAccount,
  type RunningServer
} from './apiTestClient';

/**
 * An account's own view of where it is signed in, and its own way to end all of it.
 *
 * The threat this exists for is the ordinary one — a phone left in a taxi, a shared laptop, a
 * token somebody may have read over a shoulder. Rotation and reuse detection already burn a
 * stolen chain, but nothing can name the sessions the owner signed in on and no longer trusts
 * except the owner, so `GET /auth/sessions` is what makes "sign out everywhere" a decision
 * rather than a guess.
 */

interface SessionRow {
  id: string;
  userId: string;
  tokenHash: string;
  isRevoked: number;
  familyId: string | null;
  expiresAt: string;
}

let tempDir: string;
let app: RunningServer;
/** The device that asks the questions. */
let device: LoggedInAccount;
/** Another login of the same account, and the one that gets rotated. */
let rotated: IssuedSession;
let third: IssuedSession;
let merchant: LoggedInAccount;

const PENDING_PHONE = '+8801799500001';

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function list(token: string): Promise<ApiResponse> {
  return getJson(app, '/api/v1/auth/sessions', { token });
}

function revokeAll(token: string): Promise<ApiResponse> {
  return postJson(app, '/api/v1/auth/sessions/revoke-all', {}, { token });
}

function me(token: string): Promise<ApiResponse> {
  return getJson(app, '/api/v1/auth/me', { token });
}

function refresh(refreshToken: string): Promise<ApiResponse> {
  return postJson(app, '/api/v1/auth/refresh', { refreshToken });
}

/** Opens a session without the OTP flow, so one account can hold several logins here. */
async function openSession(userId: string): Promise<IssuedSession> {
  const user = await new UserRepository(app.client).findById(userId);
  expect(user).toBeTruthy();
  return new SessionService(app.client).startSession(user!);
}

async function storedSession(id: string): Promise<SessionRow | null> {
  const row = await app.client.query<SessionRow>('SELECT * FROM auth_sessions WHERE id = ?', [id]);
  return row.rows[0] ?? null;
}

describe('An account seeing and ending its own sessions', () => {
  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${tempDir}/session-control.sqlite`,
      rateLimit: { max: 5000, windowMs: 60000 }
    });

    device = await login(app, SEEDED.customer.phone);
    merchant = await login(app, SEEDED.merchant.phone);
    rotated = await openSession(SEEDED.customer.id);
    third = await openSession(SEEDED.customer.id);
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  it('lists the live sessions of the account, naming the one that asked', async () => {
    const response = await list(device.accessToken);
    expect(response.status).toBe(200);
    expect(response.body.count).toBe(3);
    expect(response.body.sessions).toHaveLength(3);

    const current = response.body.sessions.filter((session: { isCurrent: boolean }) => session.isCurrent);
    expect(current).toHaveLength(1);
    expect(current[0].id).toBe(response.body.currentSessionId);

    // Newest first, so the login somebody just made is the first thing they see.
    const created = response.body.sessions.map((session: { createdAt: string }) => session.createdAt);
    expect([...created].sort().reverse()).toEqual(created);

    for (const session of response.body.sessions) {
      expect(session).toMatchObject({
        id: expect.stringMatching(/^sess_/),
        familyId: expect.stringMatching(/^sess_/)
      });
      expect(typeof session.createdAt).toBe('string');
      expect(typeof session.expiresAt).toBe('string');
    }

    // What the list must never carry: the refresh token, and the digest that stands in for it.
    const rendered = JSON.stringify(response.body);
    expect(rendered).not.toContain(device.refreshToken);
    expect(rendered).not.toContain(sha256(device.refreshToken));
    expect(rendered).not.toContain(sha256(rotated.refreshToken));
  });

  it('shows one entry per login, not one per rotation', async () => {
    const refreshed = await refresh(rotated.refreshToken);
    expect(refreshed.status).toBe(200);
    const nextSessionId = refreshed.body.session.id as string;
    expect(nextSessionId).not.toBe(rotated.sessionId);

    // The rotated row is retired, not deleted: it stays for the audit trail and leaves the list.
    const retiredRow = await storedSession(rotated.sessionId);
    expect(retiredRow).toMatchObject({ isRevoked: 1 });

    const response = await list(device.accessToken);
    expect(response.body.count).toBe(3);
    const ids = response.body.sessions.map((session: { id: string }) => session.id);
    expect(ids).toContain(nextSessionId);
    expect(ids).not.toContain(rotated.sessionId);
    rotated = {
      ...rotated,
      sessionId: nextSessionId,
      accessToken: refreshed.body.tokens.accessToken,
      refreshToken: refreshed.body.tokens.refreshToken
    };
  });

  it('keeps the list to the account that asks', async () => {
    const mine = await list(device.accessToken);
    const theirs = await list(merchant.accessToken);

    expect(theirs.status).toBe(200);
    expect(theirs.body.count).toBe(1);
    const mineIds = new Set(mine.body.sessions.map((session: { id: string }) => session.id));
    for (const session of theirs.body.sessions) {
      expect(mineIds.has(session.id)).toBe(false);
      // The list is the caller's own rows, so it never needs to say whose they are.
      expect(session.userId).toBeUndefined();
      expect(session.tokenHash).toBeUndefined();
    }
    expect((await list('')).status).toBe(401);
  });

  it('ends every session the account holds, the asking one included', async () => {
    const before = await list(device.accessToken);
    const liveCount = before.body.count as number;
    const askingSessionId = before.body.currentSessionId as string;

    const response = await revokeAll(device.accessToken);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      revokedSessions: liveCount,
      currentSessionRevoked: true
    });

    // Every device is out: the two extra logins, the rotated chain's head, and the asker.
    for (const token of [device.accessToken, rotated.accessToken, third.accessToken]) {
      const refused = await me(token);
      expect(refused.status).toBe(401);
      expect(String(refused.body.error.message)).toMatch(/revoked/i);
    }
    expect((await list(device.accessToken)).status).toBe(401);

    // A refresh token cannot buy new access either: the session it names is retired.
    expect((await refresh(third.refreshToken)).status).toBe(401);

    // Another account is untouched — this ends one account's sessions, not the platform's.
    expect((await me(merchant.accessToken)).status).toBe(200);
    expect((await list(merchant.accessToken)).body.count).toBe(1);

    // The record: who did it, and which sessions it retired.
    const audits = await app.client.query<{ userId: string; oldValues: string; newValues: string }>(
      "SELECT * FROM audit_logs WHERE action = 'SESSIONS_REVOKED_ALL' ORDER BY rowid"
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0].userId).toBe(SEEDED.customer.id);
    const recorded = JSON.parse(audits.rows[0].oldValues);
    expect(recorded.sessionIds).toContain(askingSessionId);
    expect(recorded.revokedSessions).toBe(liveCount);
    expect(JSON.parse(audits.rows[0].newValues)).toMatchObject({ currentSessionRevoked: true });

    // And the account is not locked out of its own platform: a fresh login is a new family.
    const recovered = await openSession(SEEDED.customer.id);
    const after = await list(recovered.accessToken);
    expect(after.status).toBe(200);
    expect(after.body.count).toBe(1);
    expect(after.body.sessions[0].isCurrent).toBe(true);

    // Every retired row says so, including the ones the list never showed.
    const customerRows = await app.client.query<{ id: string; isRevoked: number }>(
      'SELECT id, isRevoked FROM auth_sessions WHERE userId = ?',
      [SEEDED.customer.id]
    );
    expect(
      customerRows.rows.every((row) => row.isRevoked === 1 || row.id === recovered.sessionId)
    ).toBe(true);
  });

  it('counts what it ended rather than what it saw', async () => {
    // A row whose refresh token ran out is not a session anybody is holding, so it is not in
    // the list and not in the count — but the flag is still retired with it, so nothing is left
    // claiming to be a usable session.
    const past = new Date(Date.now() - 60_000).toISOString();
    await app.client.query(
      `INSERT INTO auth_sessions (id, userId, tokenHash, ipAddress, userAgent, expiresAt, isRevoked, familyId, replacedBy, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'sess_expired_leftover',
        SEEDED.customer.id,
        sha256('expired-leftover'),
        null,
        null,
        past,
        0,
        'sess_expired_leftover',
        null,
        past
      ]
    );

    const live = await openSession(SEEDED.customer.id);

    // Three rows still say they are live, of which two are: the one just opened, the one the
    // test above finished with, and the expired one.
    const unrevoked = await app.client.query<{ total: number }>(
      'SELECT COUNT(*) AS total FROM auth_sessions WHERE userId = ? AND isRevoked = 0',
      [SEEDED.customer.id]
    );
    expect(Number(unrevoked.rows[0].total)).toBe(3);

    const before = await list(live.accessToken);
    expect(before.body.count).toBe(2);

    const response = await revokeAll(live.accessToken);
    expect(response.status).toBe(200);
    // Two, not three: the expired row was never a session the owner was signed in on.
    expect(response.body).toMatchObject({ revokedSessions: 2, currentSessionRevoked: true });
    expect((await storedSession(live.sessionId))!.isRevoked).toBe(1);
    expect((await storedSession('sess_expired_leftover'))!.isRevoked).toBe(1);

    // The same honesty where the caller's own session is the unusable one: an access token
    // minted just before its refresh token ran out still authenticates, and the reply says the
    // session it came from was not one of the live ones instead of claiming to have ended it.
    const expiredCallerId = 'sess_expired_caller';
    await app.client.query(
      `INSERT INTO auth_sessions (id, userId, tokenHash, ipAddress, userAgent, expiresAt, isRevoked, familyId, replacedBy, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        expiredCallerId,
        SEEDED.customer.id,
        sha256('expired-caller'),
        null,
        null,
        past,
        0,
        expiredCallerId,
        null,
        past
      ]
    );
    const stillAccepted = createToken(
      { userId: SEEDED.customer.id, role: 'CUSTOMER', type: 'access', sessionId: expiredCallerId },
      300
    );
    expect((await me(stillAccepted)).status).toBe(200);

    const expiredOutcome = await revokeAll(stillAccepted);
    expect(expiredOutcome.status).toBe(200);
    expect(expiredOutcome.body).toMatchObject({
      revokedSessions: 0,
      currentSessionRevoked: false
    });
    expect((await storedSession(expiredCallerId))!.isRevoked).toBe(1);
    expect((await me(stillAccepted)).status).toBe(401);
  });

  it('lets an account awaiting review end its own sessions', async () => {
    // A pending merchant holds no permission at all, which is exactly why this route has none:
    // a handset it no longer trusts is the one thing it must be able to cut off before anybody
    // has reviewed its application.
    const now = new Date().toISOString();
    await app.client.query(
      `INSERT INTO users (id, email, phone, fullName, role, isActive, approvalStatus, approvalReason, registrationDetails, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'usr_fixture_pending_sessions',
        'pending-sessions@fixture.coxsbazar.delivery',
        PENDING_PHONE,
        'Pending Applicant',
        'MERCHANT',
        1,
        'PENDING',
        null,
        null,
        now,
        now
      ]
    );
    const applicant = await login(app, PENDING_PHONE);

    expect((await me(applicant.accessToken)).status).toBe(200);
    const listed = await list(applicant.accessToken);
    expect(listed.status).toBe(200);
    expect(listed.body.count).toBe(1);

    const response = await revokeAll(applicant.accessToken);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ revokedSessions: 1, currentSessionRevoked: true });
    expect((await me(applicant.accessToken)).status).toBe(401);
  });
});

/**
 * Ending one device rather than all of them: the phone in the taxi, without the laptop the
 * owner is working on.
 *
 * A server of its own, so the order the suite above leaves its fixtures in cannot decide what
 * these cases see. The account holds three logins throughout: the one that asks, the one that
 * is ended, and one that must survive both.
 */
describe('An account ending one of its own devices', () => {
  let devicesDir: string;
  let devices: RunningServer;
  let asks: LoggedInAccount;
  /** The session ids behind the two tokens the cases act with, as the list reports them. */
  let asksSessionId: string;
  let sparedSessionId: string;
  let ended: IssuedSession;
  let spared: IssuedSession;
  let outsider: LoggedInAccount;

  const DEVICE_AGENTS = {
    laptop: 'Mozilla/5.0 (Macintosh) Door2Door/1.0',
    handset: 'Mozilla/5.0 (iPhone; iPhone OS 17_2) Door2Door/1.0',
    tablet: 'Mozilla/5.0 (iPad; iPadOS 17_2) Door2Door/1.0'
  };

  function list2(token: string): Promise<ApiResponse> {
    return getJson(devices, '/api/v1/auth/sessions', { token });
  }

  function endDevice(sessionId: string, token: string): Promise<ApiResponse> {
    return apiRequest(devices, 'DELETE', `/api/v1/auth/sessions/${sessionId}`, { token });
  }

  function me2(token: string): Promise<ApiResponse> {
    return getJson(devices, '/api/v1/auth/me', { token });
  }

  function refresh2(refreshToken: string): Promise<ApiResponse> {
    return postJson(devices, '/api/v1/auth/refresh', { refreshToken });
  }

  /** Opens a session without the OTP flow, so one account can hold several logins here. */
  async function openDevice(userId: string, userAgent: string): Promise<IssuedSession> {
    const user = await new UserRepository(devices.client).findById(userId);
    expect(user).toBeTruthy();
    return new SessionService(devices.client).startSession(user!, { userAgent });
  }

  beforeAll(async () => {
    devicesDir = createTempDatabaseDir();
    devices = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${devicesDir}/session-devices.sqlite`,
      rateLimit: { max: 5000, windowMs: 60000 }
    });

    asks = await login(devices, SEEDED.customer.phone);
    ended = await openDevice(SEEDED.customer.id, DEVICE_AGENTS.handset);
    spared = await openDevice(SEEDED.customer.id, DEVICE_AGENTS.tablet);
    outsider = await login(devices, SEEDED.merchant.phone);

    asksSessionId = (await list2(asks.accessToken)).body.currentSessionId;
    sparedSessionId = (await list2(spared.accessToken)).body.currentSessionId;
  });

  afterAll(async () => {
    await devices?.close();
    removeTempDatabaseDir(devicesDir);
  });

  it('ends the named device and leaves the others signed in', async () => {
    const before = await list2(asks.accessToken);
    expect(before.body.count).toBe(3);

    const response = await endDevice(ended.sessionId, asks.accessToken);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      revokedSessionId: ended.sessionId,
      // The device that asked is not the device it named, and the reply distinguishes them so
      // a client does not have to guess whether it just signed itself out.
      currentSessionRevoked: false
    });
    expect(String(response.body.message)).toMatch(/still signed in/);

    // The phone is out at once: its access token is refused because the session behind it is
    // gone, and its refresh token cannot buy a new one.
    expect((await me2(ended.accessToken)).status).toBe(401);
    expect((await refresh2(ended.refreshToken)).status).toBe(401);

    // The other two are untouched — this is the whole point of ending one rather than all.
    expect((await me2(asks.accessToken)).status).toBe(200);
    expect((await me2(spared.accessToken)).status).toBe(200);
    const after = await list2(asks.accessToken);
    expect(after.body.count).toBe(2);
    expect(after.body.sessions.map((session: { id: string }) => session.id)).not.toContain(ended.sessionId);
    expect(after.body.sessions.map((session: { userAgent: string }) => session.userAgent)).toContain(
      DEVICE_AGENTS.tablet
    );
  });

  it('answers a session of another account, and an id that names nothing, the same way', async () => {
    const theirs = await list2(outsider.accessToken);
    expect(theirs.body.count).toBe(1);
    const theirSessionId = theirs.body.sessions[0].id as string;

    const notMine = await endDevice(theirSessionId, asks.accessToken);
    expect(notMine.status).toBe(404);

    // Indistinguishable from an id that exists for nobody: a caller must not be able to learn
    // that a session id is real, let alone whose it is, by trying to end it. Only the request
    // id differs, and that is this request's own tracing handle rather than an answer.
    const nothing = await endDevice('sess_does_not_exist', asks.accessToken);
    expect(nothing.status).toBe(404);
    expect(nothing.body.error.code).toBe(notMine.body.error.code);
    expect(nothing.body.error.message).toBe(notMine.body.error.message);

    // And the account whose session was named is untouched, still signed in on it.
    expect((await me2(outsider.accessToken)).status).toBe(200);
    expect((await list2(outsider.accessToken)).body.count).toBe(1);
  });

  it('does not report a session it never ended', async () => {
    // Already ended in the first case: there is no live session by that id to end, so the
    // answer is the same not-found rather than a second success a client could log as real.
    const again = await endDevice(ended.sessionId, asks.accessToken);
    expect(again.status).toBe(404);

    // An id that is not even a session id is refused the same way, rather than reaching SQL.
    expect((await endDevice('not-a-session-id', asks.accessToken)).status).toBe(404);
  });

  it('ends the asking device too, and says so when the caller names it', async () => {
    const mine = await list2(spared.accessToken);
    const askingSessionId = mine.body.sessions.find((session: { isCurrent: boolean }) => session.isCurrent).id;

    const response = await endDevice(askingSessionId, spared.accessToken);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ revokedSessionId: askingSessionId, currentSessionRevoked: true });
    expect(String(response.body.message)).toMatch(/Sign in again/);
    expect((await me2(spared.accessToken)).status).toBe(401);

    // The other device is still signed in: ending your own is not ending everyone's.
    expect((await me2(asks.accessToken)).status).toBe(200);
  });

  it('records each end in the trail, naming the session that asked', async () => {
    const rows = await devices.client.query<{
      id: string;
      userId: string | null;
      entityId: string;
      sessionId: string | null;
      oldValues: string;
    }>(`SELECT * FROM audit_logs WHERE action = 'SESSION_REVOKED' ORDER BY rowid`);

    // Two ends happened; the 404s wrote nothing, exactly as elsewhere in the API — the trail
    // records what was done, not what was attempted.
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((row) => row.entityId).sort()).toEqual([ended.sessionId, spared.sessionId].sort());
    for (const row of rows.rows) {
      expect(row.userId).toBe(SEEDED.customer.id);
      // `sessionId` is the session the request came through — the asker, not the ended row —
      // so "which of my logins ended that one?" has an answer.
      expect(row.sessionId).toBeTruthy();
      expect(JSON.parse(row.oldValues).endedBy).toBe(row.sessionId);
    }

    // The laptop ended the phone, and the phone's own token ended the tablet: who asked is a
    // different fact from what was ended, and the trail keeps both.
    const phoneEnded = rows.rows.find((row) => row.entityId === ended.sessionId)!;
    expect(phoneEnded.sessionId).toBe(asksSessionId);
    expect(JSON.parse(phoneEnded.oldValues)).toEqual({ sessionId: ended.sessionId, endedBy: asksSessionId });
    const selfEnded = rows.rows.find((row) => row.entityId === spared.sessionId)!;
    expect(selfEnded.sessionId).toBe(sparedSessionId);
    // Nothing was left claiming to be live for that account either.
    const live = await devices.client.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM auth_sessions WHERE userId = ? AND isRevoked = 0',
      [SEEDED.customer.id]
    );
    expect(Number(live.rows[0].n)).toBe(1);
  });

  it('lets an account awaiting review end its own device', async () => {
    // No permission on this route, for the same reason the list has none: a handset the
    // applicant no longer trusts has to be cut off before anybody has reviewed the account.
    const now = new Date().toISOString();
    await devices.client.query(
      `INSERT INTO users (id, email, phone, fullName, role, isActive, approvalStatus, approvalReason, registrationDetails, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'usr_fixture_pending_devices',
        'pending-devices@fixture.coxsbazar.delivery',
        '+8801799500007',
        'Pending Applicant',
        'MERCHANT',
        1,
        'PENDING',
        null,
        null,
        now,
        now
      ]
    );
    const applicant = await login(devices, '+8801799500007');
    const handset = await openDevice('usr_fixture_pending_devices', DEVICE_AGENTS.handset);

    expect((await me2(applicant.accessToken)).status).toBe(200);
    const response = await endDevice(handset.sessionId, applicant.accessToken);
    expect(response.status).toBe(200);
    expect(response.body.currentSessionRevoked).toBe(false);
    expect((await me2(handset.accessToken)).status).toBe(401);
    expect((await me2(applicant.accessToken)).status).toBe(200);
  });
});
