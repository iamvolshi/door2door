import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SEEDED,
  createTempDatabaseDir,
  getJson,
  login,
  postJson,
  removeTempDatabaseDir,
  startServer,
  type LoggedInAccount,
  type RunningServer
} from './apiTestClient';

// Cox's Bazar Sadar tier: base 30 BDT + 10 BDT/km, free over 1000 BDT subtotal.
// 1 x Coral Fish Curry (650) => 650 + 32.50 tax + 60 delivery = 742.50 BDT
const EXPECTED_TOTAL = 742.5;

let tempDir: string;
let app: RunningServer;
let customer: LoggedInAccount;
let merchant: LoggedInAccount;
let driver: LoggedInAccount;

function orderPayload() {
  return {
    customerId: SEEDED.customer.id,
    merchantId: SEEDED.merchantId,
    deliveryAddressId: SEEDED.addressId,
    serviceArea: 'cox_bazar_sadar',
    distanceKm: 3,
    items: [{ itemId: SEEDED.coralId, quantity: 1 }]
  };
}

function placeOrder(key: string) {
  return postJson(app, '/api/v1/orders', orderPayload(), {
    token: customer.accessToken,
    headers: { 'idempotency-key': key }
  });
}

describe('Order flow over the HTTP API', () => {
  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({ port: 0, host: '127.0.0.1', databaseFile: `${tempDir}/flow.sqlite` });
    customer = await login(app, SEEDED.customer.phone);
    merchant = await login(app, SEEDED.merchant.phone);
    driver = await login(app, SEEDED.driver.phone);
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  it('reports real database health', async () => {
    const response = await getJson(app, '/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.database.ok).toBe(true);
  });

  it('lists the seeded merchant menu publicly', async () => {
    const response = await getJson(app, `/api/v1/merchants/${SEEDED.merchantId}/menu`);
    expect(response.status).toBe(200);
    expect(response.body.merchant.id).toBe(SEEDED.merchantId);
    expect(response.body.items.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining([SEEDED.rupchandaId, SEEDED.coralId])
    );
  });

  it('quotes using server-side prices and ignores a tampered client price', async () => {
    const payload = { ...orderPayload(), items: [{ itemId: SEEDED.coralId, quantity: 1, claimedUnitPrice: 1 }] };

    const response = await postJson(app, '/api/v1/orders/quote', payload, { token: customer.accessToken });
    expect(response.status).toBe(200);

    const quote = response.body.quote;
    expect(quote.items[0].unitPrice).toBe(650);
    expect(quote.itemsSubtotal).toBe(650);
    expect(quote.taxTotal).toBe(32.5);
    expect(quote.deliveryFee).toBe(60);
    expect(quote.finalPayableAmount).toBe(EXPECTED_TOTAL);
  });

  it('places an order, replays it idempotently and returns its status', async () => {
    const key = `flow-${Date.now()}`;
    const first = await placeOrder(key);
    expect(first.status).toBe(201);
    expect(first.body.order.status).toBe('PENDING');
    expect(first.body.order.customerId).toBe(SEEDED.customer.id);
    expect(first.body.order.pricing.totalBdt).toBe(EXPECTED_TOTAL);

    const replay = await placeOrder(key);
    expect(replay.status).toBe(201);
    expect(replay.body.order.id).toBe(first.body.order.id);

    const status = await getJson(app, `/api/v1/orders/${first.body.order.id}`, { token: customer.accessToken });
    expect(status.status).toBe(200);
    expect(status.body.order.id).toBe(first.body.order.id);
    expect(status.body.order.items).toHaveLength(1);
    expect(status.body.order.pricing.totalBdt).toBe(EXPECTED_TOTAL);
  });

  it('lets the merchant that fulfils the order read it, but not the driver', async () => {
    const created = await placeOrder(`flow-visibility-${Date.now()}`);
    const orderId = created.body.order.id;

    const asMerchant = await getJson(app, `/api/v1/orders/${orderId}`, { token: merchant.accessToken });
    expect(asMerchant.status).toBe(200);
    expect(asMerchant.body.order.id).toBe(orderId);

    const asDriver = await getJson(app, `/api/v1/orders/${orderId}`, { token: driver.accessToken });
    expect(asDriver.status).toBe(403);
  });

  it('requires authentication and the customer role to touch orders', async () => {
    const anonymous = await postJson(app, '/api/v1/orders/quote', orderPayload());
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHORIZED');

    const wrongRole = await postJson(app, '/api/v1/orders/quote', orderPayload(), { token: merchant.accessToken });
    expect(wrongRole.status).toBe(403);
    expect(wrongRole.body.error.code).toBe('FORBIDDEN');

    const driverPlace = await postJson(app, '/api/v1/orders', orderPayload(), {
      token: driver.accessToken,
      headers: { 'idempotency-key': `driver-${Date.now()}` }
    });
    expect(driverPlace.status).toBe(403);
  });

  it('refuses to order for another customer even with a valid token', async () => {
    const response = await postJson(
      app,
      '/api/v1/orders/quote',
      { ...orderPayload(), customerId: SEEDED.admin.id },
      { token: customer.accessToken }
    );
    expect(response.status).toBe(403);
    expect(response.body.error.message).toMatch(/customerId/);
  });

  it('rejects a missing idempotency key and unknown items', async () => {
    const missingKey = await postJson(app, '/api/v1/orders', orderPayload(), { token: customer.accessToken });
    expect(missingKey.status).toBe(400);
    expect(missingKey.body.error.code).toBe('VALIDATION_ERROR');

    const unknownItem = await postJson(
      app,
      '/api/v1/orders/quote',
      { ...orderPayload(), items: [{ itemId: 'cat_item_does_not_exist', quantity: 1 }] },
      { token: customer.accessToken }
    );
    expect(unknownItem.status).toBe(404);
  });

  it(
    'persists orders across a process restart without re-seeding',
    async () => {
      const file = `${tempDir}/restart.sqlite`;
      const first = await startServer({ port: 0, host: '127.0.0.1', databaseFile: file });
      let orderId = '';
      let session: LoggedInAccount;

      try {
        // A token is bound to a session row in this database, so it is minted here rather
        // than reused from the suite's own instance (which has its own database file).
        session = await login(first, SEEDED.customer.phone);
        const created = await postJson(first, '/api/v1/orders', orderPayload(), {
          token: session.accessToken,
          headers: { 'idempotency-key': `restart-${Date.now()}` }
        });
        expect(created.status).toBe(201);
        orderId = created.body.order.id;
      } finally {
        await first.close();
      }

      const second = await startServer({ port: 0, host: '127.0.0.1', databaseFile: file });
      try {
        // Both the signing secret and the session row outlive the process, so the token
        // minted before the restart still opens the order afterwards.
        const status = await getJson(second, `/api/v1/orders/${orderId}`, { token: session!.accessToken });
        expect(status.status).toBe(200);
        expect(status.body.order.id).toBe(orderId);
        expect(status.body.order.pricing.totalBdt).toBe(EXPECTED_TOTAL);

        // A second start must not re-run the seeder (unique columns would collide).
        const menu = await getJson(second, `/api/v1/merchants/${SEEDED.merchantId}/menu`);
        expect(menu.body.items).toHaveLength(2);
      } finally {
        await second.close();
      }
    },
    20000
  );
});
