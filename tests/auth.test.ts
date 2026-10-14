import * as crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createToken } from '../src/auth/tokens';
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

const UNREGISTERED_PHONE = '+8801700000000';

let tempDir: string;
let app: RunningServer;
/** Session created by the first login test, reused instead of re-requesting OTPs. */
let customerSession: { accessToken: string; refreshToken: string };

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function wrongCode(realCode: string): string {
  return realCode === '000000' ? '111111' : '000000';
}

describe('Phone OTP authentication', () => {
  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({ port: 0, host: '127.0.0.1', databaseFile: `${tempDir}/auth.sqlite` });
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  it('logs in with an OTP and returns a usable JWT session', async () => {
    const request = await postJson(app, '/api/v1/auth/otp/request', { phone: SEEDED.customer.phone });
    expect(request.status).toBe(200);
    expect(request.body.success).toBe(true);
    expect(request.body.smsDelivered).toBe(false); // no SMS provider is configured in tests
    expect(typeof request.body.devOtp).toBe('string');

    const verify = await postJson(app, '/api/v1/auth/otp/verify', {
      phone: SEEDED.customer.phone,
      otp: request.body.devOtp
    });
    expect(verify.status).toBe(200);
    expect(verify.body.user.id).toBe(SEEDED.customer.id);
    expect(verify.body.user.role).toBe('CUSTOMER');
    expect(verify.body.tokens.tokenType).toBe('Bearer');
    expect(verify.body.session.id).toMatch(/^sess_/);
    customerSession = verify.body.tokens;

    const me = await getJson(app, '/api/v1/auth/me', { token: customerSession.accessToken });
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(SEEDED.customer.id);

    // The same code cannot be replayed.
    const replay = await postJson(app, '/api/v1/auth/otp/verify', {
      phone: SEEDED.customer.phone,
      otp: request.body.devOtp
    });
    expect(replay.status).toBe(400);
  });

  it('persists only a hash of the refresh token', async () => {
    const sessions = await app.client.query<{ tokenHash: string }>(
      'SELECT tokenHash FROM auth_sessions WHERE userId = ?',
      [SEEDED.customer.id]
    );

    expect(sessions.rows.length).toBeGreaterThan(0);
    for (const row of sessions.rows) {
      expect(row.tokenHash).not.toBe(customerSession.refreshToken);
    }
    expect(sessions.rows.map((row) => row.tokenHash)).toContain(sha256(customerSession.refreshToken));
  });

  it('answers the same way for an unregistered number instead of enumerating accounts', async () => {
    const response = await postJson(app, '/api/v1/auth/otp/request', { phone: UNREGISTERED_PHONE });
    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(['devOtp', 'expiresInSeconds', 'smsDelivered', 'success']);
    expect(response.body.smsDelivered).toBe(false);

    // Someone without the code cannot tell the two cases apart.
    const wrongCode = await postJson(app, '/api/v1/auth/otp/verify', {
      phone: UNREGISTERED_PHONE,
      otp: '000000'
    });
    expect(wrongCode.status).toBe(401);
    expect(wrongCode.body.error.message).toBe('Incorrect verification code');

    // The right code offers registration rather than a session, and issues no token.
    const verify = await postJson(app, '/api/v1/auth/otp/verify', {
      phone: UNREGISTERED_PHONE,
      otp: response.body.devOtp
    });
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({
      success: true,
      registrationRequired: true,
      phone: UNREGISTERED_PHONE
    });
    expect(verify.body.tokens).toBeUndefined();
    expect(verify.body.user).toBeUndefined();
  });

  it('rejects an incorrect code', async () => {
    const request = await postJson(app, '/api/v1/auth/otp/request', { phone: SEEDED.driver.phone });
    const code: string = request.body.devOtp;

    const wrong = await postJson(app, '/api/v1/auth/otp/verify', {
      phone: SEEDED.driver.phone,
      otp: wrongCode(code)
    });
    expect(wrong.status).toBe(401);

    const right = await postJson(app, '/api/v1/auth/otp/verify', { phone: SEEDED.driver.phone, otp: code });
    expect(right.status).toBe(200);
    expect(right.body.user.role).toBe('DRIVER');
  });

  it('rejects malformed phone numbers', async () => {
    const response = await postJson(app, '/api/v1/auth/otp/request', { phone: 'not-a-phone' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rotates the refresh token and burns the family when the old one is replayed', async () => {
    const account = await login(app, SEEDED.admin.phone);

    const refreshed = await postJson(app, '/api/v1/auth/refresh', { refreshToken: account.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.tokens.refreshToken).not.toBe(account.refreshToken);

    const replay = await postJson(app, '/api/v1/auth/refresh', { refreshToken: account.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSE');

    // Reuse is treated as theft, so the rotation above is revoked as well: whoever holds
    // the newest token in this chain has to sign in again. Detail: ./sessionReuse.test.ts
    const afterReuse = await postJson(app, '/api/v1/auth/refresh', {
      refreshToken: refreshed.body.tokens.refreshToken
    });
    expect(afterReuse.status).toBe(401);
    expect(afterReuse.body.error.code).toBe('REFRESH_TOKEN_REUSE');
  });

  it('revokes the session on logout', async () => {
    const account = await login(app, SEEDED.merchant.phone);

    const logout = await postJson(app, '/api/v1/auth/logout', { refreshToken: account.refreshToken });
    expect(logout.status).toBe(200);
    expect(logout.body.revoked).toBe(true);

    const afterLogout = await postJson(app, '/api/v1/auth/refresh', { refreshToken: account.refreshToken });
    expect(afterLogout.status).toBe(401);

    const again = await postJson(app, '/api/v1/auth/logout', { refreshToken: account.refreshToken });
    expect(again.status).toBe(200);
    expect(again.body.revoked).toBe(false);
  });

  it('rejects missing, malformed and expired access tokens', async () => {
    const missing = await getJson(app, '/api/v1/auth/me');
    expect(missing.status).toBe(401);

    const malformed = await getJson(app, '/api/v1/auth/me', { token: 'not.a.jwt' });
    expect(malformed.status).toBe(401);

    const expired = createToken({ userId: SEEDED.customer.id, role: 'CUSTOMER', type: 'access' }, -10);
    const expiredResponse = await getJson(app, '/api/v1/auth/me', { token: expired });
    expect(expiredResponse.status).toBe(401);
    expect(expiredResponse.body.error.message).toMatch(/expired/i);

    // A refresh token is not accepted as an access token.
    const wrongType = await getJson(app, '/api/v1/auth/me', { token: customerSession.refreshToken });
    expect(wrongType.status).toBe(401);
  });

  it('throttles repeated OTP requests for the same number', async () => {
    const again = await postJson(app, '/api/v1/auth/otp/request', { phone: SEEDED.customer.phone });
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(again.body.error.message).toMatch(/wait/i);
  });

  it('rate limits a client that exceeds the configured window', async () => {
    const limitedDir = createTempDatabaseDir();
    const limited = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${limitedDir}/limited.sqlite`,
      rateLimit: { max: 3, windowMs: 60000 }
    });

    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const response = await postJson(limited, '/api/v1/orders/quote', {});
        statuses.push(response.status);
        if (response.status === 429) {
          expect(response.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
        }
      }
      expect(statuses).toEqual([401, 401, 401, 429]);

      const health = await getJson(limited, '/health');
      expect(health.status).toBe(200); // health checks are exempt from the limiter
    } finally {
      await limited.close();
      removeTempDatabaseDir(limitedDir);
    }
  });
});
