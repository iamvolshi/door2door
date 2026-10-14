import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * The help desk's lever on a stuck login.
 *
 * The resend cooldown is the only thing between a customer on the phone and a fresh code, and
 * it cannot be waited out on somebody else's behalf — so an operator lifts it, and may ask the
 * platform to send the code while the caller is still on the line. Everything else about the
 * challenge is left alone on purpose: the code already in the customer's hand stays valid, and
 * no reset ever signs anybody in. The act is an administrator's, and it is audited.
 *
 * The numbers here have no accounts on purpose. A code is a credential for a number, not for an
 * account — registration is one of the things it authorises — so the help desk's number is
 * whichever number is stuck.
 */
describe('Admin OTP challenge reset', () => {
  let tempDir: string;
  let app: RunningServer;
  let adminToken: string;
  let merchantToken: string;

  /** One number for the cases that need a challenge to already exist. */
  const PHONE = '+8801716100001';

  const reset = (token: string, body: unknown) =>
    postJson(app, '/api/v1/admin/otp-challenges/reset', body, token === '' ? {} : { token });
  const requestCode = (phone: string) => postJson(app, '/api/v1/auth/otp/request', { phone });
  const verifyCode = (phone: string, otp: string) =>
    postJson(app, '/api/v1/auth/otp/verify', { phone, otp });

  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${tempDir}/otp-challenge-reset.sqlite`,
      // This file asks one phone for several codes, which is the point; the request limiter
      // must not be what answers.
      rateLimit: { max: 5000, windowMs: 60000 }
    });

    adminToken = (await login(app, SEEDED.admin.phone)).accessToken;
    merchantToken = (await login(app, SEEDED.merchant.phone)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  it('is an administrator action and nobody else’s', async () => {
    const anonymous = await reset('', { phone: PHONE, reason: 'help desk' });
    expect(anonymous.status).toBe(401);

    const refused = await reset(merchantToken, { phone: PHONE, reason: 'help desk' });
    expect(refused.status).toBe(403);
    // Named, so an operator reading a refusal knows which power is missing rather than
    // whether they are an administrator at all.
    expect(String(refused.body.error.message)).toContain('otp:manage');
  });

  it('lifts a running cooldown without retiring the code the customer already has', async () => {
    const first = await requestCode(PHONE);
    expect(first.status).toBe(200);
    const heldOtp = first.body.devOtp;
    expect(typeof heldOtp).toBe('string');

    // The state the desk is called about: the customer has a code and cannot ask for another.
    const tooSoon = await requestCode(PHONE);
    expect(tooSoon.status).toBe(429);
    expect(String(tooSoon.body.error.message)).toMatch(/wait/i);

    const cleared = await reset(adminToken, { phone: PHONE, reason: 'caller says no code arrived' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.success).toBe(true);
    expect(cleared.body.phone).toBe(PHONE);
    expect(cleared.body.cleared.hadChallenge).toBe(true);
    expect(cleared.body.cleared.cooldownSecondsRemaining).toBeGreaterThan(0);
    expect(cleared.body.cleared.cooldownReleased).toBe(true);
    // Nothing was texted: this is the quieter half of the action, and it says so.
    expect(cleared.body.code).toBeNull();
    expect(cleared.body.cleared.codeRetired).toBe(false);
    expect(cleared.body.challenge.codeLive).toBe(true);
    expect(cleared.body.challenge.resendAllowedAt).toBeNull();
    expect(cleared.body.challenge.secondsUntilResend).toBe(0);

    // The code the customer is holding still works. This is the whole reason the wait is lifted
    // rather than the challenge deleted: a reset must not invalidate the code in their hand.
    const proved = await verifyCode(PHONE, heldOtp);
    expect(proved.status).toBe(200);
    expect(proved.body.registrationRequired).toBe(true);

    // And the wait is genuinely gone: their own request is answered now.
    const again = await requestCode(PHONE);
    expect(again.status).toBe(200);
  });

  it('sends one more code when asked, and says what happened to the one it replaced', async () => {
    // Its own number, so this case starts from a challenge it created rather than from the
    // cooldown the previous case left running.
    const phone = '+8801716100006';
    const held = await requestCode(phone);
    expect(held.status).toBe(200);
    expect((await requestCode(phone)).status).toBe(429);

    const forced = await reset(adminToken, {
      phone,
      reason: 'reading the code to the caller',
      send: true
    });
    expect(forced.status).toBe(200);
    expect(forced.body.code.sent).toBe(true);
    // A live code was replaced, which the desk has to say out loud: the customer holding the
    // old one will find it refused.
    expect(forced.body.cleared.codeRetired).toBe(true);

    // No gateway is configured in this environment, so the attempt is made and reported
    // honestly rather than pretended; the development concession is the same one the number's
    // own request makes, which is what lets the operator read a code out at all.
    expect(forced.body.code.delivered).toBe(false);
    expect(typeof forced.body.code.failure.code).toBe('string');
    expect(forced.body.code.devOtp).toMatch(/^\d{6}$/);

    // The code just sent is the live one, and the wrong guesses that got the caller stuck are
    // gone with it.
    const proved = await verifyCode(phone, forced.body.code.devOtp);
    expect(proved.status).toBe(200);
    expect(forced.body.challenge.attempts).toBe(0);

    // A fresh code is a fresh code: it carries its own cooldown, which is the same rule the
    // customer would have had.
    expect(forced.body.challenge.secondsUntilResend).toBeGreaterThan(0);

    // The forced send is on the delivery trail, so the operator view that answers "did the code
    // go out?" sees it like any other attempt.
    const deliveries = await getJson(
      app,
      `/api/v1/admin/otp-deliveries?phone=${encodeURIComponent(phone)}`,
      { token: adminToken }
    );
    expect(deliveries.status).toBe(200);
    expect(deliveries.body.deliveries.length).toBeGreaterThan(0);
    expect(deliveries.body.deliveries[0].phone).toBe(phone);
    expect(deliveries.body.deliveries[0].delivered).toBe(false);
  });

  it('answers honestly for a number no code was ever requested for', async () => {
    const untouched = await reset(adminToken, {
      phone: '+8801716100002',
      reason: 'caller confused about the flow'
    });
    expect(untouched.status).toBe(200);
    expect(untouched.body.cleared.hadChallenge).toBe(false);
    expect(untouched.body.cleared.cooldownReleased).toBe(false);
    expect(untouched.body.cleared.cooldownSecondsRemaining).toBe(0);
    expect(untouched.body.challenge.hasChallenge).toBe(false);
    expect(untouched.body.code).toBeNull();

    // Still able to text a number that never asked: somebody whose very first code never
    // arrived is exactly who calls the desk.
    const sent = await reset(adminToken, {
      phone: '+8801716100003',
      reason: 'first code never arrived',
      send: true
    });
    expect(sent.status).toBe(200);
    expect(sent.body.cleared.hadChallenge).toBe(false);
    expect(sent.body.code.sent).toBe(true);
    expect(sent.body.code.devOtp).toMatch(/^\d{6}$/);
  });

  it('finds the challenge behind the number as the caller read it out', async () => {
    const created = await requestCode('+8801716100004');
    expect(created.status).toBe(200);

    // The desk is read a local number; the login path stored the international one. Both name
    // the same challenge, which is what makes this usable on a call.
    const cleared = await reset(adminToken, { phone: '01716100004', reason: 'read out on the call' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.phone).toBe('+8801716100004');
    expect(cleared.body.cleared.hadChallenge).toBe(true);
    expect(cleared.body.cleared.cooldownSecondsRemaining).toBeGreaterThan(0);
  });

  it('refuses a reset with no reason, an unreadable number or a non-boolean send', async () => {
    const noReason = await reset(adminToken, { phone: PHONE });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.details?.field).toBe('reason');

    const badPhone = await reset(adminToken, { phone: 'not a phone', reason: 'help desk' });
    expect(badPhone.status).toBe(400);
    expect(badPhone.body.error.code).toBe('VALIDATION_ERROR');

    const badSend = await reset(adminToken, { phone: PHONE, reason: 'help desk', send: 'yes' });
    expect(badSend.status).toBe(400);
    expect(badSend.body.error.details?.field).toBe('send');
  });

  it('writes one audit row naming the administrator and what was cleared', async () => {
    const auditedPhone = '+8801716100005';
    const held = await requestCode(auditedPhone);
    expect(held.status).toBe(200);

    const cleared = await reset(adminToken, { phone: auditedPhone, reason: 'no code arrived' });
    expect(cleared.status).toBe(200);
    expect(typeof cleared.body.auditLogId).toBe('string');

    const rows = await app.client.query<Record<string, unknown>>(
      `SELECT userId, action, entityType, entityId, oldValues, newValues, sessionId
         FROM audit_logs WHERE action = 'OTP_CHALLENGE_RESET' AND entityId = ?`,
      [auditedPhone]
    );
    expect(rows.rows.length).toBe(1);

    const row = rows.rows[0];
    // Who did it, from the token rather than the body, and through which login.
    expect(row.userId).toBe(SEEDED.admin.id);
    expect(row.entityType).toBe('OTP_CHALLENGE');
    expect(typeof row.sessionId).toBe('string');

    const oldValues = JSON.parse(String(row.oldValues)) as Record<string, unknown>;
    const newValues = JSON.parse(String(row.newValues)) as Record<string, unknown>;
    expect(oldValues.cooldownSecondsRemaining).toBeGreaterThan(0);
    expect(oldValues.hadChallenge).toBe(true);
    expect(newValues.reason).toBe('no code arrived');
    expect(newValues.cooldownReleased).toBe(true);
    expect(newValues.sent).toBe(false);

    // The row carries flags and counts, never the challenge's own state: a code or the hash it
    // is stored as would be a credential on a table read by auditors.
    expect(Object.keys(newValues).sort()).toEqual(
      ['codeLiveAfter', 'cooldownReleased', 'delivered', 'previousCodeRetired', 'provider', 'reason', 'sent'].sort()
    );
  });
});
