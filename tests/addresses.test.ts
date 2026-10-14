import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SEEDED,
  createTempDatabaseDir,
  deleteJson,
  getJson,
  login,
  patchJson,
  postJson,
  removeTempDatabaseDir,
  startServer,
  type RunningServer
} from './apiTestClient';

const NEW_CUSTOMER = '+8801715550001';

/**
 * Address management exists so a customer can finish onboarding alone: register, save where
 * they live, and order — with no seeded row doing the work for them.
 */
describe('Delivery addresses', () => {
  let tempDir: string;
  let app: RunningServer;
  let customerToken: string;
  let customerId: string;
  let otherCustomerToken: string;
  // Signed in once and shared: a second OTP request for one phone lands inside the rate-limit
  // window, and more than one case here needs to read an order as somebody other than the
  // customer it was placed for.
  let merchantToken: string;
  let adminToken: string;

  const authed = (token: string) => ({ token });
  const listAddresses = (token: string) => getJson(app, '/api/v1/addresses', authed(token));
  const createAddress = (token: string, body: unknown) =>
    postJson(app, '/api/v1/addresses', body, authed(token));

  // Every order needs its own key, and two orders can land in the same millisecond.
  let orderSeq = 0;
  const placeOrder = (token: string, deliveryAddressId: string) =>
    postJson(
      app,
      '/api/v1/orders',
      {
        merchantId: SEEDED.merchantId,
        deliveryAddressId,
        serviceArea: 'cox_bazar_sadar',
        distanceKm: 2,
        items: [{ itemId: SEEDED.coralId, quantity: 1 }]
      },
      { token, headers: { 'idempotency-key': `address-history-${Date.now()}-${(orderSeq += 1)}` } }
    );

  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({ port: 0, host: '127.0.0.1', databaseFile: `${tempDir}/addresses.sqlite` });

    // A brand-new customer: their code proves the phone, then registration creates the
    // account. Nothing about this account is seeded.
    const request = await postJson(app, '/api/v1/auth/otp/request', { phone: NEW_CUSTOMER });
    const register = await postJson(app, '/api/v1/auth/register', {
      phone: NEW_CUSTOMER,
      otp: request.body.devOtp,
      fullName: 'Nusrat Jahan',
      role: 'CUSTOMER'
    });
    expect(register.status).toBe(201);
    customerToken = register.body.tokens.accessToken;
    customerId = register.body.user.id;

    const other = await login(app, SEEDED.customer.phone);
    otherCustomerToken = other.accessToken;

    merchantToken = (await login(app, SEEDED.merchant.phone)).accessToken;
    adminToken = (await login(app, SEEDED.admin.phone)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  it('starts empty for a freshly registered customer', async () => {
    const listed = await listAddresses(customerToken);
    expect(listed.status).toBe(200);
    expect(listed.body.count).toBe(0);
    expect(listed.body.defaultAddressId).toBeNull();
  });

  it('saves an address and orders with it, with no fixture row involved', async () => {
    const created = await createAddress(customerToken, {
      streetAddress: 'House 12, Road 3, Kolatoli',
      area: 'Kolatoli',
      district: "Cox's Bazar",
      postalCode: '4700'
    });
    expect(created.status).toBe(201);
    expect(created.body.address.id).toMatch(/^addr_/);
    expect(created.body.address.isDefault).toBe(true);
    expect(created.body.address.postalCode).toBe('4700');

    // The order names that address, and the API accepts it because the customer owns it.
    const order = await postJson(
      app,
      '/api/v1/orders',
      {
        merchantId: SEEDED.merchantId,
        deliveryAddressId: created.body.address.id,
        serviceArea: 'cox_bazar_sadar',
        distanceKm: 3.2,
        items: [{ itemId: SEEDED.rupchandaId, quantity: 1 }]
      },
      { token: customerToken, headers: { 'idempotency-key': `addr-order-${Date.now()}` } }
    );

    expect(order.status).toBe(201);
    expect(order.body.order.deliveryAddressId).toBe(created.body.address.id);
    expect(order.body.order.customerId).toBe(customerId);
    expect(order.body.order.status).toBe('PENDING');

    const readBack = await getJson(app, `/api/v1/orders/${order.body.order.id}`, authed(customerToken));
    expect(readBack.status).toBe(200);
    expect(readBack.body.order.deliveryAddressId).toBe(created.body.address.id);
  });

  it('places an order without naming an address once one is saved', async () => {
    const order = await postJson(
      app,
      '/api/v1/orders',
      {
        merchantId: SEEDED.merchantId,
        serviceArea: 'cox_bazar_sadar',
        distanceKm: 1.1,
        items: [{ itemId: SEEDED.coralId, quantity: 2 }]
      },
      { token: customerToken, headers: { 'idempotency-key': `default-addr-${Date.now()}` } }
    );

    expect(order.status).toBe(201);

    const listed = await listAddresses(customerToken);
    expect(order.body.order.deliveryAddressId).toBe(listed.body.defaultAddressId);
  });

  it('keeps a second address, moves the default, and only ever has one', async () => {
    const created = await createAddress(customerToken, {
      label: 'Office',
      streetAddress: 'Shop 4, New Market Road',
      area: 'Jhawtala',
      district: "Cox's Bazar",
      isDefault: true
    });
    expect(created.status).toBe(201);
    expect(created.body.address.isDefault).toBe(true);

    const listed = await listAddresses(customerToken);
    expect(listed.body.count).toBe(2);
    expect(listed.body.defaultAddressId).toBe(created.body.address.id);
    expect(listed.body.addresses.filter((address: any) => address.isDefault)).toHaveLength(1);

    // The other one can be promoted back.
    const first = listed.body.addresses.find((address: any) => address.id !== created.body.address.id);
    const promoted = await patchJson(app, `/api/v1/addresses/${first.id}`, { isDefault: true }, authed(customerToken));
    expect(promoted.status).toBe(200);
    expect(promoted.body.address.isDefault).toBe(true);

    const after = await listAddresses(customerToken);
    expect(after.body.defaultAddressId).toBe(first.id);
    expect(after.body.addresses.filter((address: any) => address.isDefault)).toHaveLength(1);
  });

  it('edits and deletes only its own addresses', async () => {
    const created = await createAddress(customerToken, {
      label: 'Clinic',
      streetAddress: 'Hospital Road 7',
      area: 'Bazarghata',
      district: "Cox's Bazar"
    });
    const addressId = created.body.address.id;

    const updated = await patchJson(
      app,
      `/api/v1/addresses/${addressId}`,
      { label: 'Clinic (rear gate)', streetAddress: 'Hospital Road 9', postalCode: '4701' },
      authed(customerToken)
    );
    expect(updated.status).toBe(200);
    expect(updated.body.address.label).toBe('Clinic (rear gate)');
    expect(updated.body.address.streetAddress).toBe('Hospital Road 9');
    expect(updated.body.address.postalCode).toBe('4701');

    // Somebody else's id is not a resource this customer can see or touch.
    expect((await getJson(app, `/api/v1/addresses/${addressId}`, authed(otherCustomerToken))).status).toBe(404);
    expect(
      (await patchJson(app, `/api/v1/addresses/${addressId}`, { label: 'Stolen' }, authed(otherCustomerToken))).status
    ).toBe(404);
    expect((await deleteJson(app, `/api/v1/addresses/${addressId}`, authed(otherCustomerToken))).status).toBe(404);

    const removed = await deleteJson(app, `/api/v1/addresses/${addressId}`, authed(customerToken));
    expect(removed.status).toBe(200);
    expect(removed.body.deletedAddressId).toBe(addressId);
    expect((await getJson(app, `/api/v1/addresses/${addressId}`, authed(customerToken))).status).toBe(404);
  });

  it('takes an ordered-to address off the list without losing where the order went', async () => {
    const created = await createAddress(customerToken, {
      label: 'Ordered once',
      streetAddress: 'Sea Beach Road 5',
      area: 'Kolatoli',
      district: "Cox's Bazar"
    });
    const addressId = created.body.address.id;

    const order = await placeOrder(customerToken, addressId);
    expect(order.status).toBe(201);
    const orderId = order.body.order.id;

    // Where it went is part of the order from the moment it is placed.
    expect(order.body.order.deliveryAddress.streetAddress).toBe('Sea Beach Road 5');
    expect(order.body.order.deliveryAddress.area).toBe('Kolatoli');

    const removed = await deleteJson(app, `/api/v1/addresses/${addressId}`, authed(customerToken));
    expect(removed.status).toBe(200);
    expect(removed.body.deletedAddressId).toBe(addressId);
    // Kept for the order that names it, but gone as far as the customer is concerned.
    expect(removed.body.outcome).toBe('DETACHED');
    expect(removed.body.ordersKeepingIt).toBe(1);

    const listed = await listAddresses(customerToken);
    expect(listed.body.addresses.map((address: any) => address.id)).not.toContain(addressId);
    expect((await getJson(app, `/api/v1/addresses/${addressId}`, authed(customerToken))).status).toBe(404);
    expect(
      (await patchJson(app, `/api/v1/addresses/${addressId}`, { label: 'Home (moved)' }, authed(customerToken))).status
    ).toBe(404);
    expect((await placeOrder(customerToken, addressId)).status).toBe(404);

    // And the delivery it belongs to still says where it was sent.
    const after = await getJson(app, `/api/v1/orders/${orderId}`, authed(customerToken));
    expect(after.status).toBe(200);
    expect(after.body.order.deliveryAddress.streetAddress).toBe('Sea Beach Road 5');
  });

  it('still deletes an address no order was delivered to', async () => {
    const created = await createAddress(customerToken, {
      label: 'Never used',
      streetAddress: 'Jhawtala Bypass 12',
      area: 'Jhawtala',
      district: "Cox's Bazar"
    });
    const addressId = created.body.address.id;

    const removed = await deleteJson(app, `/api/v1/addresses/${addressId}`, authed(customerToken));
    expect(removed.status).toBe(200);
    expect(removed.body.outcome).toBe('DELETED');
    expect(removed.body.ordersKeepingIt).toBe(0);
    expect((await getJson(app, `/api/v1/addresses/${addressId}`, authed(customerToken))).status).toBe(404);
  });

  it('records where an order went, not where that address is now', async () => {
    const created = await createAddress(customerToken, {
      label: 'Will move',
      streetAddress: 'Ghat Road 3',
      area: 'Kolatoli',
      district: "Cox's Bazar"
    });
    const addressId = created.body.address.id;

    const order = await placeOrder(customerToken, addressId);
    expect(order.status).toBe(201);

    // The customer corrects the street they live on. The delivery they already had does not
    // move with them.
    const edited = await patchJson(
      app,
      `/api/v1/addresses/${addressId}`,
      { streetAddress: 'Ghat Road 9' },
      authed(customerToken)
    );
    expect(edited.status).toBe(200);
    expect(edited.body.address.streetAddress).toBe('Ghat Road 9');

    const read = await getJson(app, `/api/v1/orders/${order.body.order.id}`, authed(customerToken));
    expect(read.body.order.deliveryAddress.streetAddress).toBe('Ghat Road 3');
    // The row it names is still named, so an operator can follow the id through to today's row.
    expect(read.body.order.deliveryAddressId).toBe(addressId);
  });

  it('shows where an order went to the customer and to an operator, not to the store', async () => {
    const created = await createAddress(customerToken, {
      label: 'Private door',
      streetAddress: 'Sugandha Lane 7',
      area: 'Sugandha',
      district: "Cox's Bazar"
    });

    const order = await placeOrder(customerToken, created.body.address.id);
    expect(order.status).toBe(201);

    // The store selling the order can read the order, but the customer's door is not part of
    // the sale.
    const asStore = await getJson(app, `/api/v1/orders/${order.body.order.id}`, authed(merchantToken));
    expect(asStore.status).toBe(200);
    expect(asStore.body.order.deliveryAddress).toBeUndefined();

    // An operator acting on a delivery does see it.
    const asOperator = await getJson(app, `/api/v1/orders/${order.body.order.id}`, authed(adminToken));
    expect(asOperator.status).toBe(200);
    expect(asOperator.body.order.deliveryAddress.streetAddress).toBe('Sugandha Lane 7');
  });

  it('hands the default over when the default address is deleted', async () => {
    // A clean pair for this test, so it does not lean on what earlier cases left behind.
    const first = await createAddress(customerToken, {
      label: 'Green View 1',
      streetAddress: 'Green View, Block A',
      area: 'Kolatoli',
      district: "Cox's Bazar",
      isDefault: true
    });
    const second = await createAddress(customerToken, {
      label: 'Green View 2',
      streetAddress: 'Green View, Block B',
      area: 'Kolatoli',
      district: "Cox's Bazar"
    });
    expect(first.body.address.isDefault).toBe(true);
    expect(second.body.address.isDefault).toBe(false);

    const removed = await deleteJson(app, `/api/v1/addresses/${first.body.address.id}`, authed(customerToken));
    expect(removed.status).toBe(200);
    expect(removed.body.defaultAddressId).toBe(second.body.address.id);

    const after = await listAddresses(customerToken);
    expect(after.body.defaultAddressId).toBe(second.body.address.id);
    expect(after.body.addresses.filter((address: any) => address.isDefault)).toHaveLength(1);
  });

  it('validates the payload before anything is written', async () => {
    const cases: Array<[unknown, string]> = [
      [{ area: 'Kolatoli', district: "Cox's Bazar" }, 'streetAddress'],
      [{ streetAddress: 'A', area: 'Kolatoli', district: "Cox's Bazar" }, 'streetAddress'],
      [{ streetAddress: 'House 1, Road 1', district: "Cox's Bazar" }, 'area'],
      [{ streetAddress: 'House 1, Road 1', area: 'Kolatoli' }, 'district'],
      [{ streetAddress: 'House 1, Road 1', area: 'Kolatoli', district: "Cox's Bazar", postalCode: '47' }, 'postalCode'],
      // A lone half names the half that is missing.
      [{ streetAddress: 'House 1, Road 1', area: 'Kolatoli', district: "Cox's Bazar", latitude: 21.4 }, 'longitude'],
      [{ streetAddress: 'House 1, Road 1', area: 'Kolatoli', district: "Cox's Bazar", latitude: 95, longitude: 91.9 }, 'latitude'],
      [{ streetAddress: 'House 1, Road 1', area: 'Kolatoli', district: "Cox's Bazar", isDefault: 'yes' }, 'isDefault']
    ];

    for (const [body, field] of cases) {
      const response = await createAddress(customerToken, body);
      expect(response.status, `body ${JSON.stringify(body)}`).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details?.field).toBe(field);
    }

    expect((await patchJson(app, '/api/v1/addresses/addr_whatever', {}, authed(customerToken))).status).toBe(400);
  });

  it('accepts a coordinates pair and rejects a stray half in an update', async () => {
    const created = await createAddress(customerToken, {
      streetAddress: 'Beach View Condo 3',
      area: 'Sugandha',
      district: "Cox's Bazar",
      latitude: 21.4258,
      longitude: 91.9723
    });
    expect(created.status).toBe(201);
    expect(created.body.address.latitude).toBeCloseTo(21.4258);
    expect(created.body.address.longitude).toBeCloseTo(91.9723);

    const stray = await patchJson(app, `/api/v1/addresses/${created.body.address.id}`, { latitude: 21.5 }, authed(customerToken));
    expect(stray.status).toBe(400);
    expect(stray.body.error.details?.field).toBe('longitude');
  });

  it('refuses a customer with no address at all, and other roles entirely', async () => {
    const request = await postJson(app, '/api/v1/auth/otp/request', { phone: '+8801715550002' });
    const fresh = await postJson(app, '/api/v1/auth/register', {
      phone: '+8801715550002',
      otp: request.body.devOtp,
      fullName: 'Rakib Hasan',
      role: 'CUSTOMER'
    });
    const freshToken = fresh.body.tokens.accessToken;

    const order = await postJson(
      app,
      '/api/v1/orders',
      {
        merchantId: SEEDED.merchantId,
        serviceArea: 'cox_bazar_sadar',
        distanceKm: 1,
        items: [{ itemId: SEEDED.coralId, quantity: 1 }]
      },
      { token: freshToken, headers: { 'idempotency-key': `no-address-${Date.now()}` } }
    );
    expect(order.status).toBe(400);
    expect(order.body.error.details?.field).toBe('deliveryAddressId');

    expect((await createAddress(merchantToken, {
      streetAddress: 'Market stall 1',
      area: 'Jhawtala',
      district: "Cox's Bazar"
    })).status).toBe(403);
    expect((await listAddresses(merchantToken)).status).toBe(403);
    expect((await getJson(app, '/api/v1/addresses')).status).toBe(401);
  });

  it('caps how many addresses one customer can keep', async () => {
    // Filled up rather than counted precisely, so this test does not depend on how many
    // addresses the earlier cases happened to leave behind.
    let listed = await listAddresses(customerToken);
    let created = 0;
    while (listed.body.count < 10 && created < 20) {
      const response = await createAddress(customerToken, {
        streetAddress: `Warehouse unit ${created}, Link Road`,
        area: 'Kolatoli',
        district: "Cox's Bazar"
      });
      expect(response.status, `address ${created}`).toBe(201);
      created += 1;
      listed = await listAddresses(customerToken);
    }

    expect(listed.body.count).toBe(10);

    const overflow = await createAddress(customerToken, {
      streetAddress: 'One too many, Link Road',
      area: 'Kolatoli',
      district: "Cox's Bazar"
    });
    expect(overflow.status).toBe(409);
    expect(overflow.body.error.code).toBe('CONFLICT');

    // An address kept only for the history of a delivery is not one of the customer's
    // addresses, so it does not hold a place in the cap: taking one off the list makes room.
    const ordered = await placeOrder(customerToken, listed.body.addresses[0].id);
    expect(ordered.status).toBe(201);
    const detached = await deleteJson(
      app,
      `/api/v1/addresses/${listed.body.addresses[0].id}`,
      authed(customerToken)
    );
    expect(detached.body.outcome).toBe('DETACHED');

    const replacement = await createAddress(customerToken, {
      streetAddress: 'Room freed up, Link Road',
      area: 'Kolatoli',
      district: "Cox's Bazar"
    });
    expect(replacement.status).toBe(201);
    const after = await listAddresses(customerToken);
    expect(after.body.count).toBe(10);
  });
});
