import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * The review queue as a worklist: which applications cannot be approved as filed.
 *
 * Registration now refuses an incomplete application outright, so a row that cannot be
 * approved is one that skipped those checks — filed before a requirement existed, written by
 * a seed or a migration, or holding a trade licence another store has since taken. The queue
 * is where an operator meets them, and until this existed the only place that failure
 * surfaced was the `400` an approval answered with. These tests hold the two to each other:
 * every application the queue flags is one the real approve route refuses, naming the same
 * field, and every one it calls approvable is one the route accepts.
 */

let tempDir: string;
let app: RunningServer;
let adminToken: string;

const SHOP_ADDRESS = {
  streetAddress: 'Shop 7, Beach Road',
  area: 'Kolatoli',
  district: "Cox's Bazar",
  postalCode: '4700'
} as const;

/** Phone numbers used once each: a number affords one OTP request per resend cooldown. */
const PHONE = {
  blockedMerchant: '+8801726660201',
  legacyMerchant: '+8801726660202',
  licenceClash: '+8801726660203',
  blockedRider: '+8801726660204',
  invalidVehicle: '+8801726660205',
  goodMerchant: '+8801726660206'
} as const;

function queue(token: string, query = ''): Promise<ApiResponse> {
  return getJson(app, `/api/v1/admin/registrations${query}`, { token });
}

/**
 * Inserts an application directly, which is the only way to reach a state the registration
 * route would have refused — exactly the rows this view exists to find.
 */
async function insertApplication(
  phone: string,
  role: 'MERCHANT' | 'DRIVER',
  fullName: string,
  registrationDetails: Record<string, string> | null
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
      'PENDING',
      null,
      registrationDetails ? JSON.stringify(registrationDetails) : null,
      now,
      now
    ]
  );
  return id;
}

function entryFor(listing: ApiResponse, userId: string) {
  return listing.body.registrations.find((entry: any) => entry.userId === userId);
}

describe('The review queue flags applications that cannot be approved as filed', () => {
  let blockedMerchantId: string;
  let legacyMerchantId: string;
  let blockedRiderId: string;
  let invalidVehicleId: string;
  let goodMerchantId: string;

  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${tempDir}/readiness.sqlite`,
      rateLimit: { max: 5000, windowMs: 60000 }
    });
    adminToken = (await login(app, SEEDED.admin.phone)).accessToken;

    // A merchant that never stated a shop address, and one that did.
    blockedMerchantId = await insertApplication(PHONE.blockedMerchant, 'MERCHANT', 'No Address Store', {
      businessName: 'No Address Store',
      tradeLicenseNumber: 'TRAD-7001'
    });
    goodMerchantId = await insertApplication(PHONE.goodMerchant, 'MERCHANT', 'Complete Store', {
      businessName: 'Complete Store',
      tradeLicenseNumber: 'TRAD-7002',
      ...SHOP_ADDRESS
    });
    // Filed before merchants had to name a licence at all.
    legacyMerchantId = await insertApplication(PHONE.legacyMerchant, 'MERCHANT', 'No Licence Store', {
      businessName: 'No Licence Store',
      ...SHOP_ADDRESS
    });
    // A rider with no identity on file, and one whose vehicle is not one the platform runs.
    blockedRiderId = await insertApplication(PHONE.blockedRider, 'DRIVER', 'No Identity Rider', {
      zoneId: 'kolatoli'
    });
    invalidVehicleId = await insertApplication(PHONE.invalidVehicle, 'DRIVER', 'Van Rider', {
      nidNumber: '1995123456789',
      vehicleType: 'VAN'
    });
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  it('lists a blocked application with the field that has to be supplied', async () => {
    const listed = await queue(adminToken);
    expect(listed.status).toBe(200);

    const merchant = entryFor(listed, blockedMerchantId);
    expect(merchant.readiness.approvable).toBe(false);
    expect(merchant.readiness.blockedBy).toEqual([
      expect.objectContaining({
        code: 'SHOP_ADDRESS_MISSING',
        field: 'address',
        fixableByReviewer: true
      })
    ]);
    // The remedy names the actual fix, not just the problem.
    expect(merchant.readiness.blockedBy[0].remedy).toMatch(/address.*approve body/i);

    const rider = entryFor(listed, blockedRiderId);
    expect(rider.readiness.approvable).toBe(false);
    expect(rider.readiness.blockedBy.map((blocker: any) => blocker.code).sort()).toEqual([
      'NID_MISSING',
      'VEHICLE_MISSING'
    ]);
    expect(rider.readiness.blockedBy.every((blocker: any) => blocker.fixableByReviewer)).toBe(true);
    // Each names its own field, so an operator knows which piece of paperwork to ask for.
    expect(rider.readiness.blockedBy.map((blocker: any) => blocker.field).sort()).toEqual([
      'details.nidNumber',
      'details.vehicleType'
    ]);

    // An application filed without a licence cannot be approved, and no reviewer input fixes
    // that: the queue says so rather than offering a remedy that would not work.
    const legacy = entryFor(listed, legacyMerchantId);
    expect(legacy.readiness.blockedBy).toEqual([
      expect.objectContaining({ code: 'TRADE_LICENCE_MISSING', fixableByReviewer: false })
    ]);

    // A vehicle the platform does not dispatch is blocked too, and is fixable in place.
    const van = entryFor(listed, invalidVehicleId);
    expect(van.readiness.blockedBy).toEqual([
      expect.objectContaining({ code: 'VEHICLE_INVALID', fixableByReviewer: true })
    ]);

    // And a complete application is not flagged at all — the flag has to mean something.
    const good = entryFor(listed, goodMerchantId);
    expect(good.readiness).toEqual({ approvable: true, blockedBy: [] });

    // The summary describes the whole review set, whatever the list was narrowed to.
    expect(listed.body.summary).toMatchObject({ count: 5, approvable: 1, blocked: 4 });
  });

  it('answers ?approvable=false with exactly the applications that would fail', async () => {
    const blocked = await queue(adminToken, '?approvable=false');
    expect(blocked.status).toBe(200);
    expect(blocked.body.count).toBe(4);
    expect(
      blocked.body.registrations.map((entry: any) => entry.userId).sort()
    ).toEqual([blockedMerchantId, blockedRiderId, invalidVehicleId, legacyMerchantId].sort());
    expect(blocked.body.registrations.every((entry: any) => entry.readiness.approvable === false)).toBe(
      true
    );
    // Narrowing the list does not narrow the ratio beside it.
    expect(blocked.body.summary).toMatchObject({ count: 5, approvable: 1, blocked: 4 });

    const workable = await queue(adminToken, '?approvable=true');
    expect(workable.body.count).toBe(1);
    expect(workable.body.registrations[0].userId).toBe(goodMerchantId);

    // The filter composes with role: a reviewer working riders sees only rider problems.
    const blockedRiders = await queue(adminToken, '?approvable=false&role=DRIVER');
    expect(blockedRiders.body.count).toBe(2);
    expect(
      blockedRiders.body.registrations.every((entry: any) => entry.role === 'DRIVER')
    ).toBe(true);
    expect(blockedRiders.body.summary).toMatchObject({ count: 2, approvable: 0, blocked: 2 });

    const all = await queue(adminToken, '?approvable=ALL');
    expect(all.body.count).toBe(5);
  });

  it('agrees with the approval it is warning about, field for field', async () => {
    // The anti-drift check: each flagged application is handed to the real approve route, and
    // the refusal names the field the queue named. A flag that disagreed with the route would
    // be worse than no flag, so this is asserted rather than assumed.
    const flagged = await queue(adminToken, '?approvable=false');
    expect(flagged.body.count).toBe(4);

    for (const entry of flagged.body.registrations) {
      const refused = await postJson(
        app,
        `/api/v1/admin/registrations/${entry.userId}/approve`,
        {},
        { token: adminToken }
      );

      expect(refused.status, `${entry.role} ${entry.userId}`).toBe(400);
      // The refusal names one of the fields the queue flagged. Fixable or not, the two have
      // to be talking about the same thing.
      expect(
        entry.readiness.blockedBy.map((blocker: any) => blocker.field),
        `${entry.userId} was refused on a field the queue did not flag`
      ).toContain(refused.body.error.details.field);

      // Nothing half-done: a refused approval leaves the application pending, and the queue
      // keeps listing it.
      const user = await app.client.query<{ approvalStatus: string }>(
        'SELECT approvalStatus FROM users WHERE id = ?',
        [entry.userId]
      );
      expect(user.rows[0].approvalStatus).toBe('PENDING');
    }

    // And nothing the queue called approvable is refused by the route either.
    const workable = await postJson(
      app,
      `/api/v1/admin/registrations/${goodMerchantId}/approve`,
      { address: SHOP_ADDRESS },
      { token: adminToken }
    );
    expect(workable.status).toBe(200);
    expect(workable.body.profile).toMatchObject({ role: 'MERCHANT', tradeLicenseNumber: 'TRAD-7002' });
  });

  it('clears a blocked application once the reviewer supplies what was flagged', async () => {
    // The shop address, exactly as the blocker's remedy says.
    const merchant = await postJson(
      app,
      `/api/v1/admin/registrations/${blockedMerchantId}/approve`,
      { address: SHOP_ADDRESS },
      { token: adminToken }
    );
    expect(merchant.status).toBe(200);
    expect(merchant.body.profile).toMatchObject({ role: 'MERCHANT', tradeLicenseNumber: 'TRAD-7001' });

    // The rider's identity, taken down by the reviewer, field by field.
    const partial = await postJson(
      app,
      `/api/v1/admin/registrations/${blockedRiderId}/approve`,
      { rider: { vehicleType: 'motorcycle' } },
      { token: adminToken }
    );
    // The missing NID still blocks, and now it is the only thing that does.
    expect(partial.status).toBe(400);
    expect(partial.body.error.message).toMatch(/NID/i);
    expect(partial.body.error.details.field).toBe('details.nidNumber');

    const rider = await postJson(
      app,
      `/api/v1/admin/registrations/${blockedRiderId}/approve`,
      { rider: { nidNumber: '1997112233445', vehicleType: 'motorcycle', licenseNumber: 'DK-7788' } },
      { token: adminToken }
    );
    expect(rider.status).toBe(200);
    expect(rider.body.profile).toMatchObject({
      role: 'DRIVER',
      nidNumber: '1997112233445',
      // Normalized the way registration normalizes it, so the operator can read it off the
      // paperwork in whatever case it is written.
      vehicleType: 'MOTORCYCLE',
      licenseNumber: 'DK-7788',
      dutyStatus: 'OFF_DUTY'
    });

    const stored = await app.client.query<{ nidNumber: string; vehicleType: string }>(
      'SELECT nidNumber, vehicleType FROM rider_profiles WHERE userId = ?',
      [blockedRiderId]
    );
    expect(stored.rows[0]).toEqual({ nidNumber: '1997112233445', vehicleType: 'MOTORCYCLE' });

    // Both now read as approvable, and the worklist has shrunk by two.
    const after = await queue(adminToken, '?approvable=false');
    expect(after.body.count).toBe(2);
    expect(entryFor(after, blockedMerchantId)).toBeUndefined();
    expect(entryFor(after, blockedRiderId)).toBeUndefined();

    // The reviewer's input is on the audit trail as field names, and the identity number is
    // not copied into the log.
    const audit = await app.client.query<{ newValues: string }>(
      "SELECT newValues FROM audit_logs WHERE entityId = ? AND action = 'REGISTRATION_APPROVE' ORDER BY rowid DESC LIMIT 1",
      [blockedRiderId]
    );
    const recorded = JSON.parse(audit.rows[0].newValues);
    expect(recorded.suppliedByReviewer).toEqual([
      'rider.nidNumber',
      'rider.vehicleType',
      'rider.licenseNumber'
    ]);
    expect(audit.rows[0].newValues).not.toContain('1997112233445');
  });

  it('flags a licence another store has since taken, which approval refuses outright', async () => {
    // Approved after this application was filed, so its licence is spoken for by the time the
    // second one is reviewed — the conflict registration would have refused up front.
    const clashId = await insertApplication(PHONE.licenceClash, 'MERCHANT', 'Clashing Store', {
      businessName: 'Clashing Store',
      tradeLicenseNumber: 'TRAD-7001',
      ...SHOP_ADDRESS
    });

    const listed = await queue(adminToken, '?approvable=false');
    const clash = entryFor(listed, clashId);
    expect(clash.readiness.approvable).toBe(false);
    expect(clash.readiness.blockedBy).toEqual([
      expect.objectContaining({ code: 'TRADE_LICENCE_IN_USE', fixableByReviewer: false })
    ]);
    // The remedy is a decision, not a field: nothing the reviewer can pass in clears it.
    expect(clash.readiness.blockedBy[0].remedy).toMatch(/reject/i);

    const refused = await postJson(
      app,
      `/api/v1/admin/registrations/${clashId}/approve`,
      {},
      { token: adminToken }
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/licence/i);

    // Supplying the address it already has changes nothing: the conflict is the licence.
    const stillRefused = await postJson(
      app,
      `/api/v1/admin/registrations/${clashId}/approve`,
      { address: SHOP_ADDRESS },
      { token: adminToken }
    );
    expect(stillRefused.status).toBe(409);
  });

  it('refuses a malformed filter or override instead of guessing', async () => {
    const refused: ApiResponse[] = [
      await queue(adminToken, '?approvable=maybe'),
      await queue(adminToken, '?limit=0'),
      await queue(adminToken, '?limit=1000'),
      await postJson(
        app,
        `/api/v1/admin/registrations/${invalidVehicleId}/approve`,
        { rider: { vehicleType: 'HOVERBOARD' } },
        { token: adminToken }
      ),
      await postJson(
        app,
        `/api/v1/admin/registrations/${invalidVehicleId}/approve`,
        { rider: { nidNumber: '1' } },
        { token: adminToken }
      ),
      await postJson(
        app,
        `/api/v1/admin/registrations/${invalidVehicleId}/approve`,
        { rider: 'NID-1234' },
        { token: adminToken }
      ),
      await postJson(
        app,
        `/api/v1/admin/registrations/${invalidVehicleId}/approve`,
        { rider: {} },
        { token: adminToken }
      )
    ];

    for (const response of refused) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('reports the page as bounded rather than pretending the worklist is complete', async () => {
    // Three applications are still pending and blocked here, so a page of two is a page: the
    // summary describes what was assessed, and says that more may match. An operator reading
    // a worklist has to be able to tell a complete answer from a bounded one.
    const page = await queue(adminToken, '?approvable=false&limit=2');
    expect(page.body.count).toBe(2);
    expect(page.body.summary).toMatchObject({ count: 2, approvable: 0, blocked: 2 });
    expect(page.body.summary.possiblyTruncated).toBe(true);

    // The same question asked without a page returns all of them, and says so.
    const whole = await queue(adminToken, '?approvable=false&limit=100');
    expect(whole.body.summary.possiblyTruncated).toBe(false);
    expect(whole.body.count).toBe(3);
    expect(whole.body.summary).toMatchObject({ count: 3, approvable: 0, blocked: 3 });
  });

  it('keeps the queue to operators who review registrations', async () => {
    const outsider = await login(app, SEEDED.customer.phone);
    const forbidden = await queue(outsider.accessToken, '?approvable=false');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');

    const anonymous = await getJson(app, '/api/v1/admin/registrations?approvable=false');
    expect(anonymous.status).toBe(401);
  });
});
