import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionService } from '../src/auth/sessionService';
import { UserRepository } from '../src/db/repositories';
import type { OrderStatus } from '../src/db/schema';
import {
  SEEDED,
  createTempDatabaseDir,
  getJson,
  login,
  removeTempDatabaseDir,
  startServer,
  type ApiResponse,
  type RunningServer
} from './apiTestClient';

/**
 * The deliveries a rider carries, and how much of the customer's door they may read.
 *
 * Dispatch could see who was on duty and nothing could yet tell a rider where they were going:
 * an assignment lived in the `orders` table and nowhere in the API, so the one fact a rider
 * needs to do the job was reachable only by asking an administrator to read the database. This
 * is that read, scoped to the caller's own assignments.
 *
 * It is also where the platform's PII rule has to hold: the delivery address is served through
 * `maskAddress` — the same function every other viewer goes through — rather than being
 * serialized again beside it, so the answer to "may this rider read this door?" comes from the
 * rule and not from whoever wrote this route.
 *
 * The seeded pilot order is already assigned to the pilot rider, so much of this file is one
 * account reading one delivery. The rest is the boundary: a second rider's deliveries and their
 * addresses are not in it, an order nobody has accepted is not in it, and a caller who does not
 * hold the rider grant gets nothing at all.
 */

const SEEDED_ORDER = {
  id: 'ord_001',
  orderNumber: 'CXB-2025-0001',
  status: 'CONFIRMED',
  totalBdt: 1460,
  deliveryFeeBdt: 60
} as const;

/** What the rule defines for an assigned rider: the door, and the customer's note for it. */
const SEEDED_DELIVERY = {
  label: 'Home',
  streetAddress: 'Flat 4B, Sugandha View, Hotel Motel Zone',
  area: 'Sugandha',
  city: "Cox's Bazar",
  latitude: 21.4258,
  longitude: 91.9723,
  deliveryInstructions: 'Please include extra lime and chutney.'
} as const;

/** A door only one rider's list is ever allowed to mention, so a leak has somewhere to show. */
const OTHER_RIDER_ID = 'usr_fixture_rider7';
const PENDING_RIDER_ID = 'usr_fixture_rider8';
const OTHER_ORDER_ID = 'ord_fixture_other';
const OTHER_STREET = 'Secret Door 999, Marine Drive';
const UNASSIGNED_ORDER_ID = 'ord_fixture_unassigned';

let tempDir: string;
let app: RunningServer;
let driverToken: string;
let otherRiderToken: string;
let pendingRiderToken: string;
let customerToken: string;
let merchantToken: string;

function myOrders(token: string, query = ''): Promise<ApiResponse> {
  return getJson(app, `/api/v1/drivers/me/orders${query}`, { token });
}

async function insertRider(
  id: string,
  phone: string,
  approvalStatus: 'PENDING' | 'APPROVED',
  withProfile: boolean
): Promise<void> {
  const now = new Date().toISOString();
  await app.client.query(
    `INSERT INTO users (id, email, phone, fullName, role, isActive, approvalStatus, approvalReason, registrationDetails, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, `${phone.slice(-7)}@fixture.coxsbazar.delivery`, phone, `Fixture ${id}`, 'DRIVER', 1, approvalStatus, null, null, now, now]
  );

  if (withProfile) {
    await app.client.query(
      `INSERT INTO rider_profiles (userId, nidNumber, vehicleType, licenseNumber, zoneId, dutyStatus, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, '1991112223334', 'BICYCLE', null, 'kolatoli', 'OFF_DUTY', now, now]
    );
  }
}

/** An address the fixtures' orders point at, so each rider's list has a different door in it. */
async function insertAddress(id: string, streetAddress: string, area: string): Promise<void> {
  const now = new Date().toISOString();
  await app.client.query(
    `INSERT INTO addresses (id, userId, label, streetAddress, area, district, postalCode, latitude, longitude, isDefault, isPiiRestricted, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, SEEDED.customer.id, 'Fixture', streetAddress, area, "Cox's Bazar", '4700', null, null, 0, 1, now, now]
  );
}

/**
 * An order written straight at the table, the way dispatch would assign one: the API has no
 * route that assigns a rider, which is why `ON_DELIVERY` is likewise only reachable in tests.
 * `createdAt` is supplied rather than defaulted, so the ordering of the list is a fact the test
 * states rather than one the clock happens to agree with.
 */
async function insertOrder(order: {
  id: string;
  orderNumber: string;
  driverId: string | null;
  addressId: string;
  status: OrderStatus;
  createdAt: string;
}): Promise<void> {
  await app.client.query(
    `INSERT INTO orders (id, orderNumber, customerId, merchantId, driverId, deliveryAddressId, status, subtotalBdt, deliveryFeeBdt, discountBdt, taxBdt, totalBdt, specialInstructions, cancellationReason, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      order.id,
      order.orderNumber,
      SEEDED.customer.id,
      SEEDED.merchantId,
      order.driverId,
      order.addressId,
      order.status,
      300,
      40,
      0,
      0,
      340,
      null,
      null,
      order.createdAt,
      order.createdAt
    ]
  );
}

/** A live token for a fixture account, minted the way a login would. */
async function tokenFor(userId: string): Promise<string> {
  const user = await new UserRepository(app.client).findById(userId);
  expect(user, 'the fixture account must exist').toBeTruthy();
  return (await new SessionService(app.client).startSession(user!)).accessToken;
}

describe('The deliveries assigned to a rider', () => {
  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${tempDir}/driver-orders.sqlite`,
      rateLimit: { max: 5000, windowMs: 60000 }
    });

    driverToken = (await login(app, SEEDED.driver.phone)).accessToken;
    customerToken = (await login(app, SEEDED.customer.phone)).accessToken;
    merchantToken = (await login(app, SEEDED.merchant.phone)).accessToken;

    // A second rider with a delivery of their own, at a door the first rider must never see.
    await insertRider(OTHER_RIDER_ID, '+8801740000701', 'APPROVED', true);
    otherRiderToken = await tokenFor(OTHER_RIDER_ID);
    await insertAddress('addr_fixture_other', OTHER_STREET, 'Inani');
    await insertOrder({
      id: OTHER_ORDER_ID,
      orderNumber: 'CXB-2025-9001',
      driverId: OTHER_RIDER_ID,
      addressId: 'addr_fixture_other',
      status: 'OUT_FOR_DELIVERY',
      createdAt: '2026-09-01T10:00:00.000Z'
    });

    // An order nobody has accepted: unassigned is not the same as assigned to whoever asks.
    await insertOrder({
      id: UNASSIGNED_ORDER_ID,
      orderNumber: 'CXB-2025-9002',
      driverId: null,
      addressId: 'addr_fixture_other',
      status: 'PENDING',
      createdAt: '2026-09-02T10:00:00.000Z'
    });

    await insertRider(PENDING_RIDER_ID, '+8801740000702', 'PENDING', false);
    pendingRiderToken = await tokenFor(PENDING_RIDER_ID);
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  it('lists the caller’s own deliveries, with the store to collect from', async () => {
    const response = await myOrders(driverToken);

    expect(response.status).toBe(200);
    expect(response.body.count).toBe(1);
    // Echoed back, because "nothing is assigned to you" and "nothing of yours is CONFIRMED"
    // are different answers that an empty list tells apart by nothing at all.
    expect(response.body.query).toEqual({ status: null, limit: 100 });

    const order = response.body.orders[0];
    expect(order).toMatchObject({
      id: SEEDED_ORDER.id,
      orderNumber: SEEDED_ORDER.orderNumber,
      status: SEEDED_ORDER.status,
      merchant: { id: SEEDED.merchantId, businessName: "Cox's Seafood & BBQ Express" },
      totalBdt: SEEDED_ORDER.totalBdt,
      deliveryFeeBdt: SEEDED_ORDER.deliveryFeeBdt
    });

    // The rider is told whose door and which store, and not who the customer is: no account ids
    // belong in a delivery, and `customerId` is not among the fields served.
    expect(order).not.toHaveProperty('customerId');
    expect(JSON.stringify(response.body)).not.toContain(SEEDED.customer.id);
  });

  it('serves the door itself, because the rule already grants it to the assigned rider', async () => {
    const response = await myOrders(driverToken);
    const address = response.body.orders[0].deliveryAddress;

    // Read out of `maskAddress` for this viewer, not assembled here. The platform's rule says an
    // assigned rider reads the street they are delivering to, so that is what comes back — and
    // the customer's note travels as the address's own `deliveryInstructions`, so it is exposed
    // for exactly as long as the address it belongs to is.
    expect(address).toMatchObject(SEEDED_DELIVERY);

    // The masking rule copies a `userId` when the caller hands it one. This route never does,
    // because an address does not include whose account it belongs to.
    expect(address).not.toHaveProperty('userId');
  });

  it('keeps another rider’s deliveries, and their addresses, out of the list', async () => {
    const mine = await myOrders(driverToken, '?limit=200');
    expect(mine.status).toBe(200);

    const ids = mine.body.orders.map((order: { id: string }) => order.id);
    expect(ids).toEqual([SEEDED_ORDER.id]);
    // The other rider's delivery is not merely absent from the list: its door is nowhere in the
    // answer at all, and neither is the order nobody has accepted.
    expect(ids).not.toContain(OTHER_ORDER_ID);
    expect(ids).not.toContain(UNASSIGNED_ORDER_ID);
    expect(JSON.stringify(mine.body)).not.toContain(OTHER_STREET);

    // The other rider's own read is exactly the opposite way round: their delivery, at their
    // door, and none of the first rider's.
    const theirs = await myOrders(otherRiderToken, '?limit=200');
    expect(theirs.status).toBe(200);
    expect(theirs.body.count).toBe(1);
    expect(theirs.body.orders[0].id).toBe(OTHER_ORDER_ID);
    expect(theirs.body.orders[0].deliveryAddress.streetAddress).toBe(OTHER_STREET);
    expect(JSON.stringify(theirs.body)).not.toContain(SEEDED_DELIVERY.streetAddress);
  });

  it('narrows to one state instead of answering a different question', async () => {
    const confirmed = await myOrders(driverToken, '?status=CONFIRMED');
    expect(confirmed.body.count).toBe(1);
    expect(confirmed.body.query).toMatchObject({ status: 'CONFIRMED' });

    // Nothing of the caller's is DELIVERED: an empty list, and the reply says which question was
    // asked, so a client can tell "you have no deliveries" from "none of yours is delivered".
    const delivered = await myOrders(driverToken, '?status=DELIVERED');
    expect(delivered.status).toBe(200);
    expect(delivered.body.count).toBe(0);
    expect(delivered.body.query).toMatchObject({ status: 'DELIVERED' });

    // Case-insensitive input, the platform's spelling back.
    const lower = await myOrders(driverToken, '?status=out_for_delivery');
    expect(lower.status).toBe(200);
    expect(lower.body.query).toMatchObject({ status: 'OUT_FOR_DELIVERY' });
  });

  it('refuses a state or a page size the platform does not have', async () => {
    const badState = await myOrders(driverToken, '?status=PREPARING_BURNT');
    expect(badState.status).toBe(400);
    expect(badState.body.error.code).toBe('VALIDATION_ERROR');
    expect(badState.body.error.details.field).toBe('status');
    // A refusal has to name the real states, or a caller cannot correct the request.
    expect(String(badState.body.error.message)).toContain('OUT_FOR_DELIVERY');

    for (const query of ['?limit=0', '?limit=1000', '?limit=abc', '?limit=1.5']) {
      const refused = await myOrders(driverToken, query);
      expect(refused.status, query).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_ERROR');
      expect(refused.body.error.details.field).toBe('limit');
    }
  });

  it('bounds the page and keeps the newest delivery at its head', async () => {
    // One older than the seeded order and one newer, both assigned to this rider.
    await insertOrder({
      id: 'ord_fixture_old',
      orderNumber: 'CXB-2025-9003',
      driverId: SEEDED.driver.id,
      addressId: SEEDED.addressId,
      status: 'DELIVERED',
      createdAt: '2020-01-01T00:00:00.000Z'
    });
    await insertOrder({
      id: 'ord_fixture_new',
      orderNumber: 'CXB-2025-9004',
      driverId: SEEDED.driver.id,
      addressId: SEEDED.addressId,
      status: 'PREPARING',
      createdAt: '2030-01-01T00:00:00.000Z'
    });

    const page = await myOrders(driverToken, '?limit=1');
    expect(page.status).toBe(200);
    expect(page.body.count).toBe(1);
    expect(page.body.query).toMatchObject({ limit: 1 });
    // The head of the list is the delivery about to be made, not the oldest one a limit kept.
    expect(page.body.orders[0].id).toBe('ord_fixture_new');

    const all = await myOrders(driverToken, '?limit=200');
    expect(all.body.count).toBe(3);
    expect(all.body.orders.map((order: { id: string }) => order.id)).toEqual([
      'ord_fixture_new',
      SEEDED_ORDER.id,
      'ord_fixture_old'
    ]);

    // Nothing above asked for a limit: the default page is bounded too, so a rider with more
    // history than either of these numbers still cannot ask for all of it at once.
    const byDefault = await myOrders(driverToken);
    expect(byDefault.body.query).toMatchObject({ limit: 100 });
  });

  it('leaves the delivery list to riders, and stops everybody else at the gate', async () => {
    for (const [label, token] of [
      ['customer', customerToken],
      ['merchant', merchantToken]
    ] as const) {
      const refused = await myOrders(token, '?limit=200');
      expect(refused.status, label).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN');
      expect(String(refused.body.error.message), label).toContain('order:read:driver');
      // Neither role is told anything about the deliveries it was refused.
      expect(JSON.stringify(refused.body), label).not.toContain(SEEDED_DELIVERY.streetAddress);
    }

    // No token is the router's own gate rather than a handler's.
    const anonymous = await myOrders('');
    expect(anonymous.status).toBe(401);

    // An account still awaiting review holds no rider grant yet: the review gate answers first,
    // so a pending rider cannot read the platform's deliveries before anybody has approved them.
    const pending = await myOrders(pendingRiderToken);
    expect(pending.status).toBe(403);
    expect(pending.body.error.code).toBe('ACCOUNT_NOT_APPROVED');
  });
});
