import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ValidationError } from '../src/core/errors';
import { serviceAreaManager } from '../src/modules/areas/serviceAreaManager';
import {
  assertDeliverableCoordinates,
  checkDeliveryCoordinates
} from '../src/services/serviceAreaRules';
import {
  createTempDatabaseDir,
  getJson,
  patchJson,
  postJson,
  removeTempDatabaseDir,
  startServer,
  type RunningServer
} from './apiTestClient';

/**
 * The fleet's reach, applied where a customer says where they live.
 *
 * `ServiceAreaManager` has held the ten pilot zones — their bounding boxes, their status, and the
 * restrictions on the two island ones — since the pilot was configured, and nothing consulted it:
 * an address saved in Dhaka was as acceptable as one in Kolatoli, and the failure only surfaced
 * when a rider could not get there. These tests are about the gate that now stands in front of
 * the address rows, and about the boundary of it: coordinates are optional, so the gate judges
 * the coordinates it is given and says so rather than pretending to judge the ones it is not.
 */

const NEW_CUSTOMER = '+8801716660001';

/** Kolatoli: inside Cox's Bazar Sadar's box. */
const KOLATOLI = { latitude: 21.4258, longitude: 91.9723 };
/** Dhaka: no zone contains it, and no zone centre is within the fallback radius. */
const DHAKA = { latitude: 23.8103, longitude: 90.4125 };
/** Inside no bounding box, but ~14 km from Cox's Bazar Sadar's centre — the manager's own fallback. */
const NEAR_SADAR = { latitude: 21.3, longitude: 91.99 };
/** Saint Martin's Island, which is `RESTRICTED` rather than suspended. */
const SAINT_MARTINS = { latitude: 20.6272, longitude: 92.3225 };

describe('Delivery coverage', () => {
  let tempDir: string;
  let app: RunningServer;
  let customerToken: string;

  const authed = (token: string) => ({ token });
  const listAddresses = (token: string) => getJson(app, '/api/v1/addresses', authed(token));
  const createAddress = (token: string, body: unknown) =>
    postJson(app, '/api/v1/addresses', body, authed(token));

  /** A street address with the pilot's required fields, so only the coordinates vary. */
  function addressAt(coordinates: { latitude: number; longitude: number } | {}, area = 'Kolatoli') {
    return {
      streetAddress: 'House 12, Road 3',
      area,
      district: "Cox's Bazar",
      ...coordinates
    };
  }

  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${tempDir}/coverage.sqlite`,
      rateLimit: { max: 5000, windowMs: 60000 }
    });

    const request = await postJson(app, '/api/v1/auth/otp/request', { phone: NEW_CUSTOMER });
    const register = await postJson(app, '/api/v1/auth/register', {
      phone: NEW_CUSTOMER,
      otp: request.body.devOtp,
      fullName: 'Shahida Akter',
      role: 'CUSTOMER'
    });
    expect(register.status).toBe(201);
    customerToken = register.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  it('saves an address inside a serviced zone, with its coordinates kept', async () => {
    const created = await createAddress(customerToken, addressAt(KOLATOLI));

    expect(created.status).toBe(201);
    expect(created.body.address.latitude).toBeCloseTo(KOLATOLI.latitude);
    expect(created.body.address.longitude).toBeCloseTo(KOLATOLI.longitude);
  });

  it('refuses coordinates outside every zone, and writes nothing', async () => {
    const before = await listAddresses(customerToken);

    const refused = await createAddress(customerToken, addressAt(DHAKA, 'Dhaka'));

    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_ERROR');
    // The field a form highlights, and the pair itself, so a client can show what it refused.
    expect(refused.body.error.details).toMatchObject({
      field: 'latitude',
      latitude: DHAKA.latitude,
      longitude: DHAKA.longitude,
      // No zone at all is a different answer from a zone that is suspended, hence `null`.
      serviceArea: null
    });
    expect(String(refused.body.error.message)).toContain('outside every serviced area');
    // The zones the platform does serve are named, so the refusal says where it *does* go.
    expect(String(refused.body.error.message)).toContain('Cox\'s Bazar Sadar');

    // Nothing was written: not the row, and not the default it would have taken.
    const after = await listAddresses(customerToken);
    expect(after.body.count).toBe(before.body.count);
    expect(after.body.defaultAddressId).toBe(before.body.defaultAddressId);
  });

  it('refuses a point in a zone the platform has suspended, naming the zone', async () => {
    // Suspension is the manager's own switch, so the rule follows it rather than a second copy
    // of "which zones are open" living in the address route.
    try {
      serviceAreaManager.deactivateArea('area-cxb-sadar', 'Pilot suspension under test');

      const refused = await createAddress(customerToken, addressAt(KOLATOLI));

      expect(refused.status).toBe(400);
      expect(refused.body.error.details).toMatchObject({ serviceArea: 'CXB_SADAR' });
      expect(String(refused.body.error.message)).toMatch(/suspended/i);
    } finally {
      serviceAreaManager.activateArea('area-cxb-sadar');
    }

    // Restored: the same point is accepted again, so the refusal above was the status and not
    // something about the coordinates.
    const accepted = await createAddress(customerToken, addressAt(KOLATOLI, 'Sugandha'));
    expect(accepted.status).toBe(201);
  });

  it('refuses an update that moves an address out of coverage, leaving the row where it was', async () => {
    const created = await createAddress(customerToken, addressAt(KOLATOLI, 'Laboni'));
    expect(created.status).toBe(201);
    const addressId = created.body.address.id;

    const refused = await patchJson(
      app,
      `/api/v1/addresses/${addressId}`,
      { latitude: DHAKA.latitude, longitude: DHAKA.longitude },
      authed(customerToken)
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error.details?.field).toBe('latitude');

    // The row is untouched, which is the difference between refusing a move and half-making one.
    const readBack = await getJson(app, `/api/v1/addresses/${addressId}`, authed(customerToken));
    expect(readBack.body.address.latitude).toBeCloseTo(KOLATOLI.latitude);
    expect(readBack.body.address.longitude).toBeCloseTo(KOLATOLI.longitude);

    // And a move the fleet *can* make still goes through: the gate is about the destination,
    // not about updates.
    const moved = await patchJson(
      app,
      `/api/v1/addresses/${addressId}`,
      { latitude: 21.4189, longitude: 91.9802 },
      authed(customerToken)
    );
    expect(moved.status).toBe(200);
    expect(moved.body.address.latitude).toBeCloseTo(21.4189);
  });

  it('still saves an address that carries no coordinates', async () => {
    // The honest boundary of the gate: it judges coordinates, and an address that has none is
    // one it cannot judge. Refusing to save it would take the pilot's whole onboarding flow with
    // it — coordinates are optional everywhere they are accepted — so the limit is recorded
    // rather than hidden.
    const created = await createAddress(customerToken, addressAt({}, 'Jhawtala'));

    expect(created.status).toBe(201);
    expect(created.body.address.latitude).toBeNull();
    expect(created.body.address.longitude).toBeNull();
  });

  describe('the rule it asks', () => {
    it('places a serviced point in its zone', () => {
      const verdict = checkDeliveryCoordinates(KOLATOLI.latitude, KOLATOLI.longitude);
      expect(verdict).toMatchObject({ deliverable: true, area: { code: 'CXB_SADAR' } });
    });

    it('answers nothing for a point in no zone', () => {
      const verdict = checkDeliveryCoordinates(DHAKA.latitude, DHAKA.longitude);
      expect(verdict.deliverable).toBe(false);
      expect(verdict.area).toBeNull();
      expect(verdict.reason).toMatch(/outside the registered/i);
    });

    it('serves a point just outside every box, because the manager itself does', () => {
      // Not a naive bounding-box test, and deliberately so: the manager falls back to any zone
      // centre within 25 km, which is what keeps addresses along the beach road — outside the
      // Sadar box, well inside the fleet's reach — orderable. The gate follows that rule rather
      // than tightening it, so this asserts the behaviour instead of leaving it to be discovered.
      const verdict = checkDeliveryCoordinates(NEAR_SADAR.latitude, NEAR_SADAR.longitude);
      expect(verdict).toMatchObject({ deliverable: true, area: { code: 'CXB_SADAR' } });
    });

    it('serves a restricted island zone, with the restriction beside it', () => {
      // `RESTRICTED` is not `INACTIVE`: the platform's own answer is that Saint Martin's is
      // served through its maritime courier window, so an address there is accepted and the
      // reasons travel with the verdict.
      const verdict = checkDeliveryCoordinates(SAINT_MARTINS.latitude, SAINT_MARTINS.longitude);
      expect(verdict).toMatchObject({ deliverable: true, area: { code: 'SAINT_MARTINS' } });
      expect(verdict.reason).toMatch(/restrictions/i);
    });

    it('throws for a point it will not serve, and returns quietly for one it will', () => {
      expect(assertDeliverableCoordinates(KOLATOLI.latitude, KOLATOLI.longitude)).toMatchObject({
        deliverable: true
      });

      expect(() => assertDeliverableCoordinates(DHAKA.latitude, DHAKA.longitude)).toThrow(
        ValidationError
      );
    });
  });
});
