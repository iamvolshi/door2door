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
 * A merchant's own business profile.
 *
 * The store is created by approval from the onboarding answers, and until this existed every
 * one of them was frozen: renaming a shop, correcting its description, moving it or closing it
 * for the day all needed an administrator. What these tests hold is that the shopfront is the
 * merchant's — and that the terms they were approved on are not.
 */

let tempDir: string;
let app: RunningServer;
let adminToken: string;
let merchantToken: string;
/** Signed in once: a phone number affords one OTP request per cooldown, so tests share it. */
let customerToken: string;

const PENDING_PHONE = '+8801755550501';

/** An approved merchant the platform never built a store for, and one still awaiting review. */
const NO_STORE_ID = 'usr_fixture_nostore';
const NO_STORE_PHONE = '+8801755550601';
const SECOND_NO_STORE_ID = 'usr_fixture_nostore2';
const SECOND_NO_STORE_PHONE = '+8801755550602';
const PENDING_CREATE_PHONE = '+8801755550603';

function profile(token: string): Promise<ApiResponse> {
  return getJson(app, '/api/v1/merchant/profile', { token });
}

function openStore(token: string, body: unknown): Promise<ApiResponse> {
  return postJson(app, '/api/v1/merchant/profile', body, { token });
}

function edit(token: string, body: unknown): Promise<ApiResponse> {
  return patchJson(app, '/api/v1/merchant/profile', body, { token });
}

/** The stored row, read the way an operator would, so the reply is never the only evidence. */
async function storedMerchant(): Promise<{
  businessName: string;
  description: string | null;
  category: string;
  isOpen: number;
  tradeLicenseNumber: string;
  addressId: string;
}> {
  const row = await app.client.query<any>('SELECT * FROM merchants WHERE id = ?', [
    SEEDED.merchantId
  ]);
  return row.rows[0];
}

/** The merchant's own shop address row, reached through the store that points at it. */
async function storedAddress(): Promise<{
  id: string;
  streetAddress: string;
  area: string;
  label: string;
}> {
  const row = await app.client.query<any>(
    'SELECT a.* FROM addresses a JOIN merchants m ON m.addressId = a.id WHERE m.id = ?',
    [SEEDED.merchantId]
  );
  return row.rows[0];
}

/**
 * A merchant account inserted straight at the table, with the token a login would have given it.
 *
 * Approval builds the store, so an approved merchant *without* one cannot be produced through
 * the API at all — which is the state these tests are about, and the reason they need a fixture.
 */
async function insertMerchantAccount(
  id: string,
  phone: string,
  approvalStatus: 'APPROVED' | 'PENDING'
): Promise<string> {
  const now = new Date().toISOString();
  await app.client.query(
    `INSERT INTO users (id, email, phone, fullName, role, isActive, approvalStatus, approvalReason, registrationDetails, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      `${id}@fixture.coxsbazar.delivery`,
      phone,
      'Fixture Store Owner',
      'MERCHANT',
      1,
      approvalStatus,
      null,
      null,
      now,
      now
    ]
  );

  const user = await new UserRepository(app.client).findById(id);
  expect(user, 'the fixture account must exist').toBeTruthy();
  return (await new SessionService(app.client).startSession(user!)).accessToken;
}

/** How many rows an account owns, read directly: a refusal has to leave none behind. */
async function ownedRows(userId: string): Promise<{ stores: number; addresses: number }> {
  const stores = await app.client.query<{ total: number }>(
    'SELECT COUNT(*) AS total FROM merchants WHERE ownerUserId = ?',
    [userId]
  );
  const addresses = await app.client.query<{ total: number }>(
    'SELECT COUNT(*) AS total FROM addresses WHERE userId = ?',
    [userId]
  );
  return {
    stores: Number(stores.rows[0].total),
    addresses: Number(addresses.rows[0].total)
  };
}

describe('A merchant editing its own business profile', () => {
  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${tempDir}/merchant-profile.sqlite`,
      rateLimit: { max: 5000, windowMs: 60000 }
    });
    adminToken = (await login(app, SEEDED.admin.phone)).accessToken;
    merchantToken = (await login(app, SEEDED.merchant.phone)).accessToken;
    customerToken = (await login(app, SEEDED.customer.phone)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  it('shows the merchant its shopfront, and what of it is editable', async () => {
    const mine = await profile(merchantToken);
    expect(mine.status).toBe(200);
    expect(mine.body.merchant).toMatchObject({
      id: SEEDED.merchantId,
      businessName: "Cox's Seafood & BBQ Express",
      category: 'Restaurant',
      isOpen: true,
      // Visible but not editable, and named as such rather than hidden.
      tradeLicenseNumber: 'TRAD-CXB-2024-9981',
      phone: SEEDED.merchant.phone,
      rating: 4.8,
      editable: ['businessName', 'description', 'category', 'isOpen', 'address']
    });
    // The shop address is the row the store points at, not the customer's own address: a
    // merchant's delivery address and their shop's are different rows with different owners.
    const shop = await storedAddress();
    expect(mine.body.merchant.address).toMatchObject({
      id: shop.id,
      label: 'Main Restaurant',
      area: 'Kolatoli',
      // A shop is a public place, so its address is not PII-restricted.
      isPiiRestricted: false
    });
    expect(shop.id).not.toBe(SEEDED.addressId);
  });

  it('renames the shop, rewrites what it says about itself, and shows the change', async () => {
    const edited = await edit(merchantToken, {
      businessName: 'Seafood Express (Kolatoli)',
      description: 'Bay of Bengal seafood, grilled to order',
      category: 'Seafood & Grill'
    });

    expect(edited.status).toBe(200);
    expect(edited.body.changed).toEqual(['businessName', 'description', 'category']);
    expect(edited.body.merchant).toMatchObject({
      businessName: 'Seafood Express (Kolatoli)',
      description: 'Bay of Bengal seafood, grilled to order',
      category: 'Seafood & Grill'
    });

    // Stored, not merely echoed: the public storefront reads the same thing.
    expect(await storedMerchant()).toMatchObject({
      businessName: 'Seafood Express (Kolatoli)',
      description: 'Bay of Bengal seafood, grilled to order',
      category: 'Seafood & Grill'
    });
    const menu = await getJson(app, `/api/v1/merchants/${SEEDED.merchantId}/menu`);
    expect(menu.body.merchant.businessName).toBe('Seafood Express (Kolatoli)');

    // The licence the shop trades under is untouched by any of it.
    expect((await storedMerchant()).tradeLicenseNumber).toBe('TRAD-CXB-2024-9981');
  });

  it('answers a request that changes nothing with an empty change list', async () => {
    const same = await edit(merchantToken, { businessName: 'Seafood Express (Kolatoli)' });
    expect(same.status).toBe(200);
    expect(same.body.changed).toEqual([]);
  });

  it('moves the shop by editing the address in place', async () => {
    const moved = await edit(merchantToken, {
      address: {
        streetAddress: 'Plot 22, Kolatoli Beach Road',
        postalCode: '4700',
        latitude: 21.4189,
        longitude: 91.9795
      }
    });

    expect(moved.status).toBe(200);
    expect(moved.body.changed).toEqual(['address']);
    expect(moved.body.merchant.address).toMatchObject({
      id: (await storedAddress()).id,
      streetAddress: 'Plot 22, Kolatoli Beach Road',
      latitude: 21.4189
    });
    // The row riders collect from is the same row: orders already naming it still point at the
    // place they were placed for, and it keeps the platform's label.
    expect(await storedAddress()).toMatchObject({
      streetAddress: 'Plot 22, Kolatoli Beach Road',
      label: 'Main Restaurant'
    });
  });

  it('closes the shop, and the platform stops taking orders for it', async () => {
    const closed = await edit(merchantToken, { isOpen: false });
    expect(closed.status).toBe(200);
    expect(closed.body.changed).toEqual(['isOpen']);
    expect(closed.body.merchant.isOpen).toBe(false);
    expect((await storedMerchant()).isOpen).toBe(0);

    // The opening state is not decorative: this is what it is for.
    const refused = await postJson(
      app,
      '/api/v1/orders',
      {
        merchantId: SEEDED.merchantId,
        deliveryAddressId: SEEDED.addressId,
        serviceArea: 'cox_bazar_sadar',
        distanceKm: 3,
        items: [{ itemId: SEEDED.rupchandaId, quantity: 1 }]
      },
      { token: customerToken, headers: { 'idempotency-key': 'closed-shop-1' } }
    );
    expect(refused.status).toBe(400);
    expect(String(refused.body.error.message)).toMatch(/not accepting orders/i);

    // And a merchant reopens when it is ready.
    const reopened = await edit(merchantToken, { isOpen: true });
    expect(reopened.body).toMatchObject({ changed: ['isOpen'], merchant: { isOpen: true } });
  });

  it('refuses the terms the store was approved on, naming each one', async () => {
    const refused: Array<{ response: ApiResponse; field: string; expect: RegExp }> = [
      {
        response: await edit(merchantToken, { tradeLicenseNumber: 'TRAD-SELF-0001' }),
        field: 'tradeLicenseNumber',
        expect: /licensing decision/i
      },
      {
        response: await edit(merchantToken, { phone: '+8801700000000' }),
        field: 'phone',
        expect: /signs in with/i
      },
      {
        response: await edit(merchantToken, { rating: 5 }),
        field: 'rating',
        expect: /belongs to the customers/i
      },
      {
        response: await edit(merchantToken, { address: { label: 'Cheap Rent' } }),
        field: 'address.label',
        expect: /labelled by the platform/i
      },
      {
        response: await edit(merchantToken, { address: { isDefault: true } }),
        field: 'address.isDefault',
        expect: /not a default pickup point/i
      }
    ];

    for (const { response, field, expect: expected } of refused) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details.field).toBe(field);
      expect(String(response.body.error.message)).toMatch(expected);
    }

    // A refusal is a refusal: nothing above landed, licence included.
    const stored = await storedMerchant();
    expect(stored.tradeLicenseNumber).toBe('TRAD-CXB-2024-9981');
  });

  it('refuses a malformed edit instead of answering a different one', async () => {
    const refused: ApiResponse[] = [
      // Nothing to change is a mistake, not a no-op to report as success.
      await edit(merchantToken, {}),
      await edit(merchantToken, { businessName: 'A' }),
      await edit(merchantToken, { businessName: 42 }),
      await edit(merchantToken, { category: '' }),
      await edit(merchantToken, { description: 42 }),
      await edit(merchantToken, { isOpen: 'yes' }),
      await edit(merchantToken, { address: 'Kolatoli' }),
      await edit(merchantToken, { address: {} }),
      // A shop address cannot be emptied: riders have to be able to find the place.
      await edit(merchantToken, { address: { area: '' } }),
      await edit(merchantToken, { address: { latitude: 21.4 } })
    ];

    for (const response of refused) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('lets a merchant clear a description it no longer wants to show', async () => {
    const cleared = await edit(merchantToken, { description: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ changed: ['description'], merchant: { description: null } });
    expect((await storedMerchant()).description).toBeNull();
    expect((await profile(merchantToken)).body.merchant.description).toBeNull();
  });

  it('records who changed what, with the shop’s location rather than the store id alone', async () => {
    await edit(merchantToken, { businessName: 'Seafood Express', description: 'Fresh daily catch' });

    const rows = await app.client.query<{ newValues: string; oldValues: string; userId: string }>(
      "SELECT * FROM audit_logs WHERE entityId = ? AND action = 'MERCHANT_PROFILE_UPDATE' ORDER BY rowid DESC LIMIT 1",
      [SEEDED.merchantId]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].userId).toBe(SEEDED.merchant.id);

    const before = JSON.parse(rows.rows[0].oldValues);
    const after = JSON.parse(rows.rows[0].newValues);
    expect(after.changed).toEqual(['businessName', 'description']);
    expect(before.businessName).toBe('Seafood Express (Kolatoli)');
    expect(after.businessName).toBe('Seafood Express');
    // The location is in the record: "where was this store then?" is answerable from it.
    expect(after.address.streetAddress).toBe('Plot 22, Kolatoli Beach Road');
    expect(after.address.district).toMatch(/Cox/);
  });

  it('keeps the profile to the merchant that owns it', async () => {
    // Another role cannot reach it at all, and the store is found by owner rather than by an id
    // a caller supplies, so there is nothing to point at somebody else's shop.
    const refused = [await profile(customerToken), await edit(customerToken, { isOpen: false })];
    for (const response of refused) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(String(response.body.error.message)).toContain('merchant:manage:own');
    }
    expect((await profile('')).status).toBe(401);

    // An approved merchant with no store is a 404, not a 403: the account holds the grant and
    // simply has nothing to edit. Administrators hold the grant too, and have no store either.
    const adminView = await profile(adminToken);
    expect(adminView.status).toBe(404);
    expect(String(adminView.body.error.message)).toMatch(/merchant profile/i);

    // And a merchant still awaiting review never reaches the handler: the review gate does.
    const request = await postJson(app, '/api/v1/auth/otp/request', { phone: PENDING_PHONE });
    const applicant = await postJson(app, '/api/v1/auth/register', {
      phone: PENDING_PHONE,
      otp: request.body.devOtp,
      fullName: 'Pending Store',
      role: 'MERCHANT',
      details: {
        businessName: 'Pending Store',
        tradeLicenseNumber: 'TRAD-PENDING-01',
        streetAddress: 'Shop 1, Main Road',
        area: 'Sugandha',
        district: "Cox's Bazar"
      }
    });
    expect(applicant.status).toBe(201);
    expect(applicant.body.approvalRequired).toBe(true);

    const gated = await edit(applicant.body.tokens.accessToken, { businessName: 'Renamed Already' });
    expect(gated.status).toBe(403);
    expect(gated.body.error.code).toBe('ACCOUNT_NOT_APPROVED');
    expect((await profile(applicant.body.tokens.accessToken)).status).toBe(403);
  });

  /**
   * The store an approval would have built, built by the merchant instead.
   *
   * Approval creates the store in the same transaction that approves the account, so "approved
   * with no store" is a state this API cannot reach on its own — which is exactly why it needed
   * a way out: the account holds the grant, the read answers `404`, and before this there was
   * nothing to call next.
   */
  describe('opening a store that approval never created', () => {
    let ownerToken: string;
    let secondOwnerToken: string;
    let openedStoreId: string;

    const NEW_STORE = {
      businessName: 'Kolatoli Kitchen',
      tradeLicenseNumber: 'TRAD-CXB-2026-4471',
      category: 'Restaurant',
      description: 'Coastal grill, charcoal and cold drinks.',
      address: {
        streetAddress: 'Plot 7, Kolatoli Beach Road',
        area: 'Kolatoli',
        district: "Cox's Bazar",
        postalCode: '4700'
      }
    };

    beforeAll(async () => {
      ownerToken = await insertMerchantAccount(NO_STORE_ID, NO_STORE_PHONE, 'APPROVED');
      secondOwnerToken = await insertMerchantAccount(
        SECOND_NO_STORE_ID,
        SECOND_NO_STORE_PHONE,
        'APPROVED'
      );
    });

    it('is a 404 to read until the merchant opens one, and a 201 when it does', async () => {
      const before = await profile(ownerToken);
      expect(before.status).toBe(404);
      expect(String(before.body.error.message)).toMatch(/merchant profile/i);

      const created = await openStore(ownerToken, NEW_STORE);
      expect(created.status).toBe(201);

      const merchant = created.body.merchant;
      openedStoreId = merchant.id;
      expect(merchant).toMatchObject({
        businessName: 'Kolatoli Kitchen',
        category: 'Restaurant',
        description: 'Coastal grill, charcoal and cold drinks.',
        isOpen: true,
        tradeLicenseNumber: 'TRAD-CXB-2026-4471',
        // The number the account signs in with, taken from the account and never the body.
        phone: NO_STORE_PHONE,
        rating: 5,
        editable: ['businessName', 'description', 'category', 'isOpen', 'address']
      });
      expect(merchant.id).toMatch(/^merch_/);
      // A shop is a public place, and the label is the platform's: both exactly as approval
      // leaves them, so a store opened here is the same shape downstream.
      expect(merchant.address).toMatchObject({
        label: 'Shop',
        streetAddress: 'Plot 7, Kolatoli Beach Road',
        area: 'Kolatoli',
        district: "Cox's Bazar",
        postalCode: '4700',
        isDefault: true,
        isPiiRestricted: false
      });

      // The rows, read the way an operator would, so the reply is never the only evidence.
      const stored = await app.client.query<any>('SELECT * FROM merchants WHERE ownerUserId = ?', [
        NO_STORE_ID
      ]);
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0].businessName).toBe('Kolatoli Kitchen');
      expect(stored.rows[0].phone).toBe(NO_STORE_PHONE);
      expect(stored.rows[0].isOpen).toBe(1);

      const storedAddress = await app.client.query<any>('SELECT * FROM addresses WHERE id = ?', [
        stored.rows[0].addressId
      ]);
      expect(storedAddress.rows).toHaveLength(1);
      expect(storedAddress.rows[0].userId).toBe(NO_STORE_ID);
      expect(storedAddress.rows[0].isPiiRestricted).toBe(0);

      // And the read that answered 404 a moment ago now answers.
      const after = await profile(ownerToken);
      expect(after.status).toBe(200);
      expect(after.body.merchant.id).toBe(openedStoreId);

      // Opening a store is a write, so it leaves a trail row naming the session that did it.
      const trail = await app.client.query<any>(
        `SELECT * FROM audit_logs WHERE action = 'MERCHANT_PROFILE_CREATE' AND entityId = ?`,
        [openedStoreId]
      );
      expect(trail.rows).toHaveLength(1);
      expect(trail.rows[0].userId).toBe(NO_STORE_ID);
      expect(trail.rows[0].sessionId).toBeTruthy();
      expect(trail.rows[0].oldValues).toBeNull();
      expect(String(trail.rows[0].newValues)).toContain('Kolatoli Kitchen');
    });

    it('is the store the profile then edits, with no second way to set it up', async () => {
      const renamed = await edit(ownerToken, { businessName: 'Kolatoli Kitchen & Grill' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.changed).toEqual(['businessName']);
      expect(renamed.body.merchant.id).toBe(openedStoreId);

      // The terms it opened under are refused by the edit, just as for an approved store.
      const refused = await edit(ownerToken, { tradeLicenseNumber: 'TRAD-CXB-2026-0000' });
      expect(refused.status).toBe(400);
      expect(refused.body.error.details.field).toBe('tradeLicenseNumber');
    });

    it('refuses a second store for the same account, naming the one it has', async () => {
      const before = await ownedRows(NO_STORE_ID);

      const again = await openStore(ownerToken, {
        ...NEW_STORE,
        tradeLicenseNumber: 'TRAD-CXB-2026-9999'
      });

      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('CONFLICT');
      expect(String(again.body.error.message)).toContain(openedStoreId);
      expect(String(again.body.error.message)).toMatch(/already has a store/i);

      // Nothing half-written: the refusal comes before an address row is made.
      expect(await ownedRows(NO_STORE_ID)).toEqual(before);
    });

    it('refuses a licence another store already holds, and writes nothing at all', async () => {
      const before = await ownedRows(SECOND_NO_STORE_ID);

      // The seeded pilot store's licence, which is unique platform-wide.
      const refused = await openStore(secondOwnerToken, {
        ...NEW_STORE,
        tradeLicenseNumber: 'TRAD-CXB-2024-9981'
      });

      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('CONFLICT');
      expect(String(refused.body.error.message)).toContain('TRAD-CXB-2024-9981');

      // One transaction, so a refused store is not an orphaned shop address either.
      expect(await ownedRows(SECOND_NO_STORE_ID)).toEqual({ stores: 0, addresses: 0 });
      expect(await ownedRows(SECOND_NO_STORE_ID)).toEqual(before);
    });

    it('refuses the fields the platform owns, and a body with no store in it', async () => {
      const refused: Array<[Record<string, unknown>, string]> = [
        [{ ...NEW_STORE, phone: '+8801700000000' }, 'phone'],
        [{ ...NEW_STORE, rating: 4.5 }, 'rating'],
        [{ ...NEW_STORE, id: 'merch_mine' }, 'id'],
        [{ ...NEW_STORE, ownerUserId: NO_STORE_ID }, 'ownerUserId'],
        [{ ...NEW_STORE, address: { ...NEW_STORE.address, label: 'Home' } }, 'address.label'],
        [{ ...NEW_STORE, address: { ...NEW_STORE.address, isDefault: false } }, 'address.isDefault'],
        [{ ...NEW_STORE, businessName: undefined }, 'businessName'],
        [{ ...NEW_STORE, tradeLicenseNumber: undefined }, 'tradeLicenseNumber'],
        [{ ...NEW_STORE, address: undefined }, 'address'],
        // A shop address is a required set of fields, not an optional one: a store riders
        // cannot be sent to is not a store.
        [{ ...NEW_STORE, address: { area: 'Kolatoli', district: "Cox's Bazar" } }, 'streetAddress'],
        [{}, 'businessName'],
        [{ ...NEW_STORE, category: '' }, 'category'],
        [{ ...NEW_STORE, isOpen: 'yes' }, 'isOpen']
      ];

      for (const [body, field] of refused) {
        const response = await openStore(secondOwnerToken, body);
        expect(response.status, `body ${JSON.stringify(body)}`).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(response.body.error.details?.field, `body ${JSON.stringify(body)}`).toBe(field);
      }

      // None of them wrote anything, not even an address row for the attempt.
      expect(await ownedRows(SECOND_NO_STORE_ID)).toEqual({ stores: 0, addresses: 0 });
    });

    it('leaves opening a store to approved merchants, and stops everybody else at the gate', async () => {
      const asCustomer = await openStore(customerToken, NEW_STORE);
      expect(asCustomer.status).toBe(403);
      expect(asCustomer.body.error.code).toBe('FORBIDDEN');
      expect(String(asCustomer.body.error.message)).toContain('merchant:manage:own');
      expect((await openStore('', NEW_STORE)).status).toBe(401);

      // An account still under review holds no role permissions yet: the gate answers first, so
      // a store cannot be opened before anybody has approved the merchant that asked.
      const pendingToken = await insertMerchantAccount(
        'usr_fixture_pending_create',
        PENDING_CREATE_PHONE,
        'PENDING'
      );
      const gated = await openStore(pendingToken, NEW_STORE);
      expect(gated.status).toBe(403);
      expect(gated.body.error.code).toBe('ACCOUNT_NOT_APPROVED');
      expect(await ownedRows('usr_fixture_pending_create')).toEqual({ stores: 0, addresses: 0 });
    });
  });
});
