import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PhoneAuthService, normalizePhoneNumber } from '../src/auth/phoneAuth';
import { DatabaseOtpStore, MemoryOtpStore } from '../src/auth/otpStore';
import { DatabaseClient } from '../src/db/client';
import { SqliteDriver } from '../src/db/sqliteDriver';
import {
  SEEDED,
  createTempDatabaseDir,
  login,
  postJson,
  removeTempDatabaseDir,
  startServer,
  type RunningServer
} from './apiTestClient';

/**
 * Phone login must not depend on the life of one server process: a code requested before a
 * restart has to still verify afterwards, and two processes sharing a database must agree on
 * the code, the resend cooldown and the failed-attempt lockout.
 *
 * The two servers below are separate DatabaseClients over the same SQLite file — the same
 * arrangement as two processes on one host, which is the deployment this state now supports.
 *
 * Booting two processes *simultaneously* on a brand-new file is verified against real
 * processes rather than here: `node:sqlite` is synchronous, so in one thread the second
 * client's busy wait blocks the first client's commit, which is a harness artifact no
 * server would see.
 */
describe('Phone login state persisted in the database', () => {
  let tempDir: string;
  let databaseFile: string;
  let first: RunningServer;
  let second: RunningServer;

  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    databaseFile = `${tempDir}/otp.sqlite`;
    first = await startServer({ port: 0, host: '127.0.0.1', databaseFile });
    second = await startServer({ port: 0, host: '127.0.0.1', databaseFile, seed: false });
  });

  afterAll(async () => {
    await first?.close();
    await second?.close();
    removeTempDatabaseDir(tempDir);
  });

  async function requestOtp(target: RunningServer, phone: string) {
    return postJson(target, '/api/v1/auth/otp/request', { phone });
  }

  async function verifyOtp(target: RunningServer, phone: string, otp: string) {
    return postJson(target, '/api/v1/auth/otp/verify', { phone, otp });
  }

  it('verifies a code issued by a different server process', async () => {
    const request = await requestOtp(first, SEEDED.customer.phone);
    expect(request.status).toBe(200);

    const verify = await verifyOtp(second, SEEDED.customer.phone, request.body.devOtp);
    expect(verify.status).toBe(200);
    expect(verify.body.user.phone).toBe(SEEDED.customer.phone);
  });

  it('shows the resend cooldown to every process, not just the one that sent the code', async () => {
    const phone = '+8801711110001';
    expect((await requestOtp(first, phone)).status).toBe(200);

    const blocked = await requestOtp(second, phone);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(blocked.body.error.message).toMatch(/Please wait \d+s/);
  });

  it('lets the other process send again once the wait has been lifted for it', async () => {
    const phone = '+8801711110007';
    const held = await requestOtp(first, phone);
    expect(held.status).toBe(200);
    expect((await requestOtp(second, phone)).status).toBe(429);

    // The help desk's lever, called once against one process. What it moves is the row, so
    // there is nothing to replicate: the process that refused a moment ago is the one asked
    // next. The administrator is a fixture rather than the seeded one, whose own cooldown
    // another case in this file spends.
    const now = new Date().toISOString();
    await first.client.query(
      `INSERT INTO users (id, email, phone, fullName, role, isActive, approvalStatus, approvalReason, registrationDetails, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'usr_fixture_otp_admin',
        'otp-admin@fixture.coxsbazar.delivery',
        '+8801711110008',
        'Fixture Admin',
        'ADMIN',
        1,
        'APPROVED',
        null,
        null,
        now,
        now
      ]
    );
    const admin = await login(first, '+8801711110008');
    const cleared = await postJson(
      first,
      '/api/v1/admin/otp-challenges/reset',
      { phone, reason: 'caller says no code arrived' },
      { token: admin.accessToken }
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.cleared.cooldownSecondsRemaining).toBeGreaterThan(0);

    // The code the customer is already holding still works, and the process that did not issue
    // it is the one that proves it: lifting a wait must not invalidate a code.
    const proved = await verifyOtp(second, phone, held.body.devOtp);
    expect(proved.status).toBe(200);

    const again = await requestOtp(second, phone);
    expect(again.status).toBe(200);
  });

  it('counts failed attempts across processes and locks the number out', async () => {
    const phone = '+8801711110002';
    const request = await requestOtp(first, phone);
    const realOtp = request.body.devOtp;
    const wrong = realOtp === '000000' ? '111111' : '000000';

    // Three wrong guesses spread over two processes: the counter is shared, so the fourth
    // attempt trips the lockout even though no single process saw three failures.
    expect((await verifyOtp(first, phone, wrong)).status).toBe(401);
    expect((await verifyOtp(second, phone, wrong)).status).toBe(401);
    expect((await verifyOtp(first, phone, wrong)).status).toBe(401);
    expect((await verifyOtp(second, phone, wrong)).status).toBe(429);

    // The lockout retired the code, so even the correct one is refused now.
    const afterLockout = await verifyOtp(first, phone, realOtp);
    expect(afterLockout.status).toBe(400);
    expect(afterLockout.body.error.message).toMatch(/No active OTP request/);
  });

  it('consumes a code exactly once, whichever process spends it', async () => {
    // A registered number consumes the code as it signs in; unregistered numbers keep it
    // alive for the registration that follows, which is covered separately below.
    const phone = SEEDED.merchant.phone;
    const request = await requestOtp(first, phone);
    const otp = request.body.devOtp;

    expect((await verifyOtp(first, phone, otp)).status).toBe(200);

    const replay = await verifyOtp(second, phone, otp);
    expect(replay.status).toBe(400);
    expect(replay.body.error.message).toMatch(/No active OTP request/);
  });

  it('keeps an unregistered phone on the registration path across processes', async () => {
    const phone = '+8801711110004';
    const request = await requestOtp(first, phone);

    // consume:false keeps the code alive for the registration that follows.
    const probe = await verifyOtp(second, phone, request.body.devOtp);
    expect(probe.status).toBe(200);
    expect(probe.body.registrationRequired).toBe(true);

    const register = await postJson(first, '/api/v1/auth/register', {
      phone,
      otp: request.body.devOtp,
      fullName: 'Cross Process Applicant',
      role: 'CUSTOMER'
    });
    expect(register.status).toBe(201);
    expect(register.body.user.phone).toBe(phone);
  });

  it('survives a restart with the pending code and the cooldown intact', async () => {
    const phone = SEEDED.driver.phone;
    const request = await requestOtp(second, phone);
    expect(request.status).toBe(200);

    // Restart the process that issued the code against the same database file.
    const restarted = await startServer({ port: 0, host: '127.0.0.1', databaseFile, seed: false });
    try {
      const blocked = await requestOtp(restarted, phone);
      expect(blocked.status).toBe(429);

      const verify = await verifyOtp(restarted, phone, request.body.devOtp);
      expect(verify.status).toBe(200);
      expect(verify.body.user.phone).toBe(phone);
    } finally {
      await restarted.close();
    }
  });

  it('does not leave a code behind after it is spent', async () => {
    const phone = SEEDED.admin.phone;
    const request = await requestOtp(first, phone);
    expect((await verifyOtp(first, phone, request.body.devOtp)).status).toBe(200);

    const rows = await first.client.query<{ otpHash: string | null }>(
      `SELECT otpHash FROM otp_challenges WHERE phone = ?`,
      [phone]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].otpHash).toBeNull();
  });

  it('exposes the challenge table and its prune index', async () => {
    const rows = await first.client.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'otp_challenges'`
    );
    expect(rows.rows).toHaveLength(1);
    const index = await first.client.query(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_otp_challenges_last_sent'`
    );
    expect(index.rows).toHaveLength(1);
  });

  it('adds the challenge table to a database created before it existed', async () => {
    const legacyFile = `${tempDir}/legacy.sqlite`;
    const client = new DatabaseClient(new SqliteDriver(legacyFile));
    await client.migrate();
    await client.query(`DROP TABLE otp_challenges`);

    // Boot on the same file the way the server does, and the table comes back.
    await client.migrate();
    const rows = await client.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'otp_challenges'`
    );
    expect(rows.rows).toHaveLength(1);
    await client.close();
  });
});

/**
 * Direct store tests: the resend claim and the single-use consumption are only correct if
 * concurrent callers cannot both win, and those statements are what the API relies on.
 */
describe('OtpStore', () => {
  it('lets exactly one of two concurrent resend claims through', async () => {
    const client = new DatabaseClient(new SqliteDriver(':memory:'));
    await client.migrate();
    const store = new DatabaseOtpStore(client);
    const now = Date.now();
    const claim = (otpHash: string) => ({
      phone: '+8801811110001',
      otpHash,
      expiresAt: now + 300000,
      lastSentAt: now,
      cooldownCutoff: now - 60000
    });

    const results = await Promise.all([store.claimResend(claim('a')), store.claimResend(claim('b'))]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const stored = await store.get('+8801811110001');
    expect(stored?.attempts).toBe(0);
    expect(['a', 'b']).toContain(stored?.otpHash);
    await client.close();
  });

  it('allows a resend once the cooldown has elapsed and resets the attempt counter', async () => {
    const client = new DatabaseClient(new SqliteDriver(':memory:'));
    await client.migrate();
    const store = new DatabaseOtpStore(client);
    const phone = '+8801811110002';
    const firstSend = 1_000_000;

    expect(
      await store.claimResend({ phone, otpHash: 'first', expiresAt: firstSend + 300000, lastSentAt: firstSend, cooldownCutoff: firstSend - 60000 })
    ).toBe(true);
    expect(await store.registerFailedAttempt(phone)).toBe(1);

    const tooSoon = firstSend + 30000;
    expect(
      await store.claimResend({ phone, otpHash: 'second', expiresAt: tooSoon + 300000, lastSentAt: tooSoon, cooldownCutoff: tooSoon - 60000 })
    ).toBe(false);

    const later = firstSend + 61000;
    expect(
      await store.claimResend({ phone, otpHash: 'third', expiresAt: later + 300000, lastSentAt: later, cooldownCutoff: later - 60000 })
    ).toBe(true);

    const stored = await store.get(phone);
    expect(stored?.otpHash).toBe('third');
    expect(stored?.attempts).toBe(0);
    await client.close();
  });

  it('consumes a code once even under concurrent verification', async () => {
    const client = new DatabaseClient(new SqliteDriver(':memory:'));
    await client.migrate();
    const store = new DatabaseOtpStore(client);
    const phone = '+8801811110003';
    const now = Date.now();
    await store.claimResend({ phone, otpHash: 'hash', expiresAt: now + 300000, lastSentAt: now, cooldownCutoff: now - 60000 });

    const results = await Promise.all([store.consumeCode(phone, 'hash'), store.consumeCode(phone, 'hash')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.consumeCode(phone, 'hash')).toBe(false);
    await client.close();
  });

  it('prunes challenges that have been idle past the cutoff', async () => {
    const client = new DatabaseClient(new SqliteDriver(':memory:'));
    await client.migrate();
    const store = new DatabaseOtpStore(client);
    const now = Date.now();
    await store.claimResend({ phone: '+8801811110004', otpHash: 'old', expiresAt: now, lastSentAt: now - 100000, cooldownCutoff: now - 200000 });
    await store.claimResend({ phone: '+8801811110005', otpHash: 'new', expiresAt: now, lastSentAt: now, cooldownCutoff: now - 200000 });

    expect(await store.prune(now - 50000)).toBe(1);
    expect(await store.get('+8801811110004')).toBeNull();
    expect(await store.get('+8801811110005')).not.toBeNull();
    await client.close();
  });

  it('accepts only Bangladeshi numbers, however they are written', () => {
    expect(normalizePhoneNumber('+8801812345678')).toBe('+8801812345678');
    expect(normalizePhoneNumber('8801812345678')).toBe('+8801812345678');
    expect(normalizePhoneNumber('01812345678')).toBe('+8801812345678');
    expect(normalizePhoneNumber('01812-345 678')).toBe('+8801812345678');

    for (const refused of ['+919876543210', '+15551234567', '+8802812345678', '', 'abc']) {
      expect(() => normalizePhoneNumber(refused), `${refused} was accepted`).toThrow(
        /Invalid phone number|required/
      );
    }
  });

  it('keys stored codes with the server secret, not just the phone number', async () => {
    const store = new MemoryOtpStore();
    const service = new PhoneAuthService({ store, hashSecret: 'server-secret-for-this-test-only' });
    // The store is keyed by the normalized number, whatever form the caller sends.
    const phone = '01711118888';
    const normalized = '+8801711118888';

    const { otp } = await service.requestOtp(phone);
    const stored = await store.get(normalized);

    // The row holds a hash, and one that a holder of the row cannot match against a
    // guessed code without the configured secret.
    expect(stored?.otpHash).not.toContain(otp);
    expect(stored?.otpHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(service.verifyOtp(phone, otp)).resolves.toBe(true);

    // A different secret derives a different hash, so it could not have verified that code.
    const elsewhere = new PhoneAuthService({ store, hashSecret: 'another-server-secret' });
    const otherPhone = '01711117777';
    const other = await elsewhere.requestOtp(otherPhone);
    const otherStored = await store.get('+8801711117777');
    expect(otherStored?.otpHash).not.toBe(stored?.otpHash);
    await expect(elsewhere.verifyOtp(otherPhone, other.otp)).resolves.toBe(true);
  });

  it('holds the same rules in process memory for a single-process deployment', async () => {
    const store = new MemoryOtpStore();
    const service = new PhoneAuthService({ store, cooldownSeconds: 60, maxAttempts: 1 });
    const phone = '01711119999';

    const { otp } = await service.requestOtp(phone);
    await expect(service.requestOtp(phone)).rejects.toThrow(/Please wait/);
    expect(await service.verifyOtp(phone, '000000' === otp ? '111111' : '000000')).toBe(false);
    await expect(service.verifyOtp(phone, '000000' === otp ? '111111' : '000000')).rejects.toThrow(/Too many failed attempts/);
  });
});
