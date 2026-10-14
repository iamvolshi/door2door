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
  type RunningServer
} from './apiTestClient';

/**
 * A rider's duty state, and the roster dispatch works from.
 *
 * An approved rider's profile is created `OFF_DUTY` and, until this endpoint existed, nothing
 * could move it: the state dispatch depends on was reachable only by editing the database. So
 * these tests are about the two things that makes true — a rider can put themselves on and off
 * the roster, and an operator can see who is on it — and about the one transition a rider must
 * not be able to make for themselves: leaving a delivery they are carrying.
 */

let tempDir: string;
let app: RunningServer;
let adminToken: string;
let driverToken: string;

const RIDER_PHONE = SEEDED.driver.phone;

function duty(token: string): Promise<ApiResponse> {
  return getJson(app, '/api/v1/drivers/me/duty', { token });
}

function setDuty(token: string, status: unknown): Promise<ApiResponse> {
  return patchJson(app, '/api/v1/drivers/me/duty', { status }, { token });
}

function roster(token: string, query = ''): Promise<ApiResponse> {
  return getJson(app, `/api/v1/drivers/roster${query}`, { token });
}

/** The seeded database state of one rider's duty row, read the way an operator would. */
async function storedDuty(userId: string): Promise<string | null> {
  const row = await app.client.query<{ dutyStatus: string }>(
    'SELECT dutyStatus FROM rider_profiles WHERE userId = ?',
    [userId]
  );
  return row.rows[0]?.dutyStatus ?? null;
}

/** Inserts a rider with a profile, for rosters and accounts the API cannot build quickly. */
async function insertRider(
  id: string,
  phone: string,
  fullName: string,
  approvalStatus: 'PENDING' | 'APPROVED',
  profile: {
    vehicleType: string;
    zoneId: string;
    dutyStatus: string;
    isActive?: number;
  } | null
): Promise<void> {
  const now = new Date().toISOString();
  await app.client.query(
    `INSERT INTO users (id, email, phone, fullName, role, isActive, approvalStatus, approvalReason, registrationDetails, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      `${phone.slice(-4)}@fixture.coxsbazar.delivery`,
      phone,
      fullName,
      'DRIVER',
      profile?.isActive ?? 1,
      approvalStatus,
      null,
      null,
      now,
      now
    ]
  );

  if (profile) {
    await app.client.query(
      `INSERT INTO rider_profiles (userId, nidNumber, vehicleType, licenseNumber, zoneId, dutyStatus, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        '1991112223334',
        profile.vehicleType,
        null,
        profile.zoneId,
        profile.dutyStatus,
        now,
        now
      ]
    );
  }
}

async function signIn(userId: string): Promise<string> {
  const user = await new UserRepository(app.client).findById(userId);
  expect(user, 'the account under test must exist').toBeTruthy();
  return (await new SessionService(app.client).startSession(user!)).accessToken;
}

describe('Rider duty state and the dispatch roster', () => {
  const secondRiderId = 'usr_fixture_rider2';
  const noProfileId = 'usr_fixture_rider3';
  const pendingRiderId = 'usr_fixture_rider4';

  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${tempDir}/rider-duty.sqlite`,
      rateLimit: { max: 5000, windowMs: 60000 }
    });
    adminToken = (await login(app, SEEDED.admin.phone)).accessToken;
    driverToken = (await login(app, RIDER_PHONE)).accessToken;

    // A second rider on duty in another zone, so the roster has something to order and filter.
    await insertRider(secondRiderId, '+8801740000402', 'Zahid Karim', 'APPROVED', {
      vehicleType: 'BICYCLE',
      zoneId: 'sugandha',
      dutyStatus: 'AVAILABLE'
    });
    // A driver account with no rider profile at all, and one still waiting on review.
    await insertRider(noProfileId, '+8801740000403', 'No Profile Rider', 'APPROVED', null);
    await insertRider(pendingRiderId, '+8801740000404', 'Pending Rider', 'PENDING', null);
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  it('starts the seeded rider off duty, with the state readable before it is changed', async () => {
    const mine = await duty(driverToken);
    expect(mine.status).toBe(200);
    expect(mine.body.duty).toMatchObject({
      userId: SEEDED.driver.id,
      dutyStatus: 'OFF_DUTY',
      available: false,
      vehicleType: 'MOTORCYCLE',
      zoneId: 'kolatoli'
    });
    // The states the rider owns, and what each means, so a client need not hardcode either.
    expect(mine.body.duty.settable).toEqual(['AVAILABLE', 'ON_BREAK', 'OFF_DUTY']);
    expect(mine.body.duty.meaning).toMatch(/not on the roster/i);

    // A rider who is off duty is not on the roster a dispatcher opens.
    const working = await roster(adminToken);
    expect(
      working.body.riders.some((entry: { userId: string }) => entry.userId === SEEDED.driver.id)
    ).toBe(false);
  });

  it('puts the rider on the roster, and dispatch can see them there', async () => {
    const onDuty = await setDuty(driverToken, 'AVAILABLE');
    expect(onDuty.status).toBe(200);
    expect(onDuty.body).toMatchObject({
      changed: true,
      duty: { dutyStatus: 'AVAILABLE', available: true }
    });
    expect(await storedDuty(SEEDED.driver.id)).toBe('AVAILABLE');

    const working = await roster(adminToken);
    expect(working.status).toBe(200);
    expect(working.body.count).toBe(2);
    // Available first, alphabetically within a state: the head of the list is who to call.
    expect(working.body.riders.map((entry: { fullName: string }) => entry.fullName)).toEqual([
      'Rahim Uddin',
      'Zahid Karim'
    ]);
    const me = working.body.riders.find(
      (entry: { userId: string }) => entry.userId === SEEDED.driver.id
    );
    expect(me).toMatchObject({
      phone: RIDER_PHONE,
      vehicleType: 'MOTORCYCLE',
      zoneId: 'kolatoli',
      dutyStatus: 'AVAILABLE',
      available: true
    });
    expect(me.meaning).toMatch(/ready to be given work/i);
    expect(typeof me.since).toBe('string');
    // The roster is who to send, not who they are: identity documents stay out of it.
    expect(JSON.stringify(me)).not.toMatch(/nid|1990/i);
  });

  it('answers going on duty twice with what actually changed', async () => {
    const again = await setDuty(driverToken, 'AVAILABLE');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ changed: false, duty: { dutyStatus: 'AVAILABLE' } });
  });

  it('refuses the states a rider does not own, and says what to send instead', async () => {
    const refused: Array<{ response: ApiResponse; expect: RegExp }> = [
      // The state dispatch sets while an order is in the rider's hands.
      { response: await setDuty(driverToken, 'ON_DELIVERY'), expect: /dispatch sets and clears/i },
      // The platform's word for "on duty" is AVAILABLE, and a caller who guesses otherwise is
      // told so rather than left to infer it from a list.
      { response: await setDuty(driverToken, 'ON_DUTY'), expect: /on duty is AVAILABLE/i },
      { response: await setDuty(driverToken, 'WORKING'), expect: /must be one of/i },
      { response: await setDuty(driverToken, ''), expect: /is required/i },
      { response: await patchJson(app, '/api/v1/drivers/me/duty', {}, { token: driverToken }), expect: /is required/i },
      { response: await patchJson(app, '/api/v1/drivers/me/duty', { status: 7 }, { token: driverToken }), expect: /is required/i }
    ];

    for (const { response, expect: expected } of refused) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(String(response.body.error.message)).toMatch(expected);
      expect(response.body.error.details.field).toBe('status');
    }

    // Nothing above changed the state they were in.
    expect(await storedDuty(SEEDED.driver.id)).toBe('AVAILABLE');
  });

  it('takes breaks, and comes off the roster without being asked twice', async () => {
    const onBreak = await setDuty(driverToken, 'ON_BREAK');
    expect(onBreak.body).toMatchObject({ changed: true, duty: { dutyStatus: 'ON_BREAK' } });

    // On break is still on duty: dispatch can see them, but must not hand them work.
    const working = await roster(adminToken);
    expect(working.body.count).toBe(2);
    const me = working.body.riders.find(
      (entry: { userId: string }) => entry.userId === SEEDED.driver.id
    );
    expect(me).toMatchObject({ dutyStatus: 'ON_BREAK', available: false });

    // Lower case is accepted: the states are case-insensitive input, and the row stores the
    // platform's spelling.
    const off = await setDuty(driverToken, 'off_duty');
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ changed: true, duty: { dutyStatus: 'OFF_DUTY' } });
    expect(await storedDuty(SEEDED.driver.id)).toBe('OFF_DUTY');

    const afterOff = await roster(adminToken);
    expect(afterOff.body.count).toBe(1);
    expect(afterOff.body.riders[0].userId).toBe(secondRiderId);
  });

  it('shows the off duty riders only when they are asked for', async () => {
    const everyone = await roster(adminToken, '?dutyStatus=ALL');
    expect(everyone.body.count).toBe(2);
    expect(everyone.body.query).toMatchObject({ dutyStatus: 'ALL', includeOffDuty: true });
    expect(everyone.body.riders.map((entry: { fullName: string }) => entry.fullName)).toEqual([
      'Zahid Karim',
      'Rahim Uddin'
    ]);

    const offOnly = await roster(adminToken, '?dutyStatus=OFF_DUTY');
    expect(offOnly.body.count).toBe(1);
    expect(offOnly.body.riders[0].userId).toBe(SEEDED.driver.id);

    const byZone = await roster(adminToken, '?zoneId=sugandha&dutyStatus=ALL');
    expect(byZone.body.count).toBe(1);
    expect(byZone.body.riders[0].userId).toBe(secondRiderId);

    const nobody = await roster(adminToken, '?zoneId=inani');
    expect(nobody.body.count).toBe(0);
    expect(nobody.body.query).toMatchObject({ zoneId: 'inani', dutyStatus: null, includeOffDuty: false });
  });

  it('leaves the roster the moment the account is suspended', async () => {
    const suspended = await postJson(
      app,
      `/api/v1/admin/users/${secondRiderId}/suspend`,
      { reason: 'Vehicle documents expired' },
      { token: adminToken }
    );
    expect(suspended.status).toBe(200);

    const working = await roster(adminToken);
    expect(working.body.count).toBe(0);
    // Still registered, so an operator auditing the fleet can still find them.
    const everyone = await roster(adminToken, '?dutyStatus=ALL');
    expect(everyone.body.count).toBe(1);
    expect(everyone.body.riders[0].userId).toBe(SEEDED.driver.id);
  });

  it('refuses to leave a delivery in progress', async () => {
    // Dispatch owns ON_DELIVERY, so the only way to reach the state this guard is about is the
    // way dispatch would write it.
    await app.client.query(`UPDATE rider_profiles SET dutyStatus = 'ON_DELIVERY' WHERE userId = ?`, [
      SEEDED.driver.id
    ]);

    const refused = await setDuty(driverToken, 'OFF_DUTY');
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CONFLICT');
    expect(String(refused.body.error.message)).toMatch(/carrying a delivery/i);
    // A conflict, not a refusal of the caller's entitlement: they may make this request.
    expect(await storedDuty(SEEDED.driver.id)).toBe('ON_DELIVERY');

    // Nothing a rider sends moves them, not even the state they are already in.
    const sameState = await setDuty(driverToken, 'ON_DELIVERY');
    expect(sameState.status).toBe(400);
    expect(await storedDuty(SEEDED.driver.id)).toBe('ON_DELIVERY');

    // Cleaned up the way dispatch would, so the rest of the file reads a working rider.
    await app.client.query(`UPDATE rider_profiles SET dutyStatus = 'OFF_DUTY' WHERE userId = ?`, [
      SEEDED.driver.id
    ]);
  });

  it('tells an approved driver with no profile apart from one still under review', async () => {
    // The account holds the grant and has no rider record: there is no state to read or write.
    const noProfile = await signIn(noProfileId);
    const missing = await duty(noProfile);
    expect(missing.status).toBe(404);
    expect(String(missing.body.error.message)).toMatch(/rider profile/i);

    const refused = await setDuty(noProfile, 'AVAILABLE');
    expect(refused.status).toBe(404);
    expect(refused.body.error.code).toBe('NOT_FOUND');

    // An account still awaiting review never reaches either handler: the review gate answers
    // first, so a pending rider cannot put themselves on the roster before approval.
    const pendingToken = await signIn(pendingRiderId);
    const gated = await duty(pendingToken);
    expect(gated.status).toBe(403);
    expect(gated.body.error.code).toBe('ACCOUNT_NOT_APPROVED');
    expect((await setDuty(pendingToken, 'AVAILABLE')).status).toBe(403);
  });

  it('keeps the roster and another rider’s duty out of a rider’s reach', async () => {
    const customer = await login(app, SEEDED.customer.phone);
    for (const response of [
      await duty(customer.accessToken),
      await setDuty(customer.accessToken, 'AVAILABLE'),
      await roster(customer.accessToken)
    ]) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    }
    expect(String((await roster(customer.accessToken)).body.error.message)).toContain('rider:read:all');

    // No token at all is the router's gate, not a handler's.
    expect((await duty('')).status).toBe(401);
    expect((await roster('')).status).toBe(401);
  });

  it('refuses a malformed roster query instead of answering a different one', async () => {
    const refused: ApiResponse[] = [
      await roster(adminToken, '?dutyStatus=ON_DUTY'),
      await roster(adminToken, '?dutyStatus=working'),
      await roster(adminToken, '?limit=0'),
      await roster(adminToken, '?limit=1000')
    ];

    for (const response of refused) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});
