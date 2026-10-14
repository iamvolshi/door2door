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
  type ApiResponse,
  type RunningServer
} from './apiTestClient';

/**
 * A merchant's own catalogue.
 *
 * The point of the feature is one sentence long: an approved store starts with an empty
 * catalogue, and until it can stock its own shelf nothing can be ordered from it. So the tests
 * hold both halves — that an item can be added, changed, taken off the menu and removed by its
 * owner alone, and that the first item is what turns an approved account into a store that
 * takes an order.
 */

let tempDir: string;
let app: RunningServer;
let adminToken: string;
let merchantToken: string;
let customerToken: string;
/** An approved store that has never had an item: the state every new merchant starts in. */
let newStore: { token: string; merchantId: string };

const NEW_STORE_PHONE = '+8801755550601';

function list(token: string): Promise<ApiResponse> {
  return getJson(app, '/api/v1/merchant/catalog', { token });
}

function add(token: string, body: unknown): Promise<ApiResponse> {
  return postJson(app, '/api/v1/merchant/catalog', body, { token });
}

function one(token: string, itemId: string): Promise<ApiResponse> {
  return getJson(app, `/api/v1/merchant/catalog/${itemId}`, { token });
}

function edit(token: string, itemId: string, body: unknown): Promise<ApiResponse> {
  return patchJson(app, `/api/v1/merchant/catalog/${itemId}`, body, { token });
}

function remove(token: string, itemId: string): Promise<ApiResponse> {
  return deleteJson(app, `/api/v1/merchant/catalog/${itemId}`, { token });
}

/** Places a real order for one item, the way a customer's app would. */
function orderFor(
  merchantId: string,
  itemId: string,
  key: string,
  claimedUnitPrice?: number
): Promise<ApiResponse> {
  return postJson(
    app,
    '/api/v1/orders',
    {
      merchantId,
      deliveryAddressId: SEEDED.addressId,
      serviceArea: 'cox_bazar_sadar',
      distanceKm: 3,
      items: [
        { itemId, quantity: 1, ...(claimedUnitPrice === undefined ? {} : { claimedUnitPrice }) }
      ]
    },
    { token: customerToken, headers: { 'idempotency-key': key } }
  );
}

/** The stored row, read the way an operator would, so a reply is never the only evidence. */
async function storedItem(itemId: string): Promise<{
  name: string;
  priceBdt: number;
  isAvailable: number;
  sku: string;
  merchantId: string;
} | null> {
  const row = await app.client.query<any>('SELECT * FROM catalog_items WHERE id = ?', [itemId]);
  return row.rows[0] ?? null;
}

describe('A merchant stocking its own catalogue', () => {
  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${tempDir}/catalog-items.sqlite`,
      rateLimit: { max: 5000, windowMs: 60000 }
    });

    adminToken = (await login(app, SEEDED.admin.phone)).accessToken;
    merchantToken = (await login(app, SEEDED.merchant.phone)).accessToken;
    customerToken = (await login(app, SEEDED.customer.phone)).accessToken;

    // A second merchant, registered and approved the way a real one is, so the tests can
    // separate "my own shelf" from "somebody else's" and start from an empty catalogue.
    const request = await postJson(app, '/api/v1/auth/otp/request', { phone: NEW_STORE_PHONE });
    const applicant = await postJson(app, '/api/v1/auth/register', {
      phone: NEW_STORE_PHONE,
      otp: request.body.devOtp,
      fullName: 'Nusrat Jahan',
      role: 'MERCHANT',
      details: {
        businessName: 'Sultana General Store',
        tradeLicenseNumber: 'TRAD-CATALOG-01',
        streetAddress: 'Shop 9, Main Road',
        area: 'Sugandha',
        district: "Cox's Bazar"
      }
    });
    expect(applicant.status).toBe(201);
    expect(applicant.body.approvalRequired).toBe(true);

    const approved = await postJson(
      app,
      `/api/v1/admin/registrations/${applicant.body.user.id}/approve`,
      {},
      { token: adminToken }
    );
    expect(approved.status).toBe(200);

    newStore = {
      token: applicant.body.tokens.accessToken,
      merchantId: approved.body.profile.merchantId
    };
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  it('shows the store its own menu, and what of each item is editable', async () => {
    const mine = await list(merchantToken);
    expect(mine.status).toBe(200);
    expect(mine.body.count).toBe(2);
    expect(mine.body.store).toMatchObject({ id: SEEDED.merchantId, isOpen: true });

    const ids = mine.body.items.map((item: { id: string }) => item.id);
    expect(ids).toEqual(expect.arrayContaining([SEEDED.rupchandaId, SEEDED.coralId]));
    for (const item of mine.body.items) {
      expect(item.merchantId).toBe(SEEDED.merchantId);
      expect(typeof item.sku).toBe('string');
      expect(item.sku.length).toBeGreaterThan(0);
      expect(item.editable).toEqual([
        'name',
        'description',
        'category',
        'priceBdt',
        'isAvailable',
        'imageUrl'
      ]);
    }
  });

  it('adds an item, defaulting the category to the store’s own and the SKU to the platform’s', async () => {
    const created = await add(merchantToken, {
      name: 'Chittagong Mezban Beef',
      priceBdt: 320.5,
      description: 'Slow-cooked beef in the Mezban style'
    });

    expect(created.status).toBe(201);
    expect(created.body.item).toMatchObject({
      name: 'Chittagong Mezban Beef',
      description: 'Slow-cooked beef in the Mezban style',
      // Nothing was said about a category, so the store's own was used.
      category: 'Restaurant',
      priceBdt: 320.5,
      isAvailable: true,
      imageUrl: null,
      merchantId: SEEDED.merchantId
    });

    const stored = await storedItem(created.body.item.id);
    expect(stored).toMatchObject({ priceBdt: 320.5, isAvailable: 1, merchantId: SEEDED.merchantId });
    // The SKU is the platform's, and no two items share one.
    expect(stored!.sku).toMatch(/^CXB-[0-9A-F]{10}$/);
    const second = await add(merchantToken, { name: 'Borhani 500ml', priceBdt: 60 });
    expect(second.status).toBe(201);
    expect(second.body.item.sku).not.toBe(stored!.sku);

    // And the storefront the customer browses shows what the merchant stocked.
    const menu = await getJson(app, `/api/v1/merchants/${SEEDED.merchantId}/menu`);
    expect(menu.body.items.map((item: { name: string }) => item.name)).toEqual(
      expect.arrayContaining(['Chittagong Mezban Beef', 'Borhani 500ml'])
    );

    // Reading one back is the same object the list shows.
    const read = await one(merchantToken, created.body.item.id);
    expect(read.status).toBe(200);
    expect(read.body.item.id).toBe(created.body.item.id);
  });

  it('prices, renames and takes an item off the menu, and the order path obeys each change', async () => {
    const created = await add(merchantToken, { name: 'Shrimp Malai Curry', priceBdt: 400 });
    const itemId = created.body.item.id;

    const repriced = await edit(merchantToken, itemId, {
      priceBdt: 425.25,
      description: 'Prawns in coconut milk'
    });
    expect(repriced.status).toBe(200);
    expect(repriced.body.changed).toEqual(['description', 'priceBdt']);
    expect(repriced.body.item).toMatchObject({ priceBdt: 425.25 });

    // A rename that changes nothing reports nothing, rather than pretending otherwise.
    const same = await edit(merchantToken, itemId, { name: 'Shrimp Malai Curry' });
    expect(same.status).toBe(200);
    expect(same.body.changed).toEqual([]);

    // Sold out: the item stays on the merchant's own list but leaves the orderable menu.
    const unavailable = await edit(merchantToken, itemId, { isAvailable: false });
    expect(unavailable.status).toBe(200);
    expect(unavailable.body.changed).toEqual(['isAvailable']);
    expect((await storedItem(itemId))!.isAvailable).toBe(0);
    expect((await list(merchantToken)).body.items.some((i: { id: string }) => i.id === itemId)).toBe(
      true
    );

    const refused = await orderFor(SEEDED.merchantId, itemId, 'catalog-out-of-stock');
    expect(refused.status).toBe(400);
    expect(String(refused.body.error.message)).toMatch(/out of stock/i);

    // Back on sale, and the new price is what the order is priced at — the server's number,
    // not one the client claimed.
    expect((await edit(merchantToken, itemId, { isAvailable: true })).status).toBe(200);
    const placed = await orderFor(SEEDED.merchantId, itemId, 'catalog-on-sale', 1);
    expect(placed.status).toBe(201);
    expect(placed.body.order.pricing.subtotalBdt).toBe(425.25);
    expect(placed.body.order.items[0]).toMatchObject({ unitPriceBdt: 425.25 });
  });

  it('refuses the fields the platform owns, naming each one', async () => {
    const created = await add(merchantToken, { name: 'Loitta Fry', priceBdt: 180 });
    const itemId = created.body.item.id;
    const realSku = created.body.item.sku;

    const refused: Array<{ response: ApiResponse; field: string; expect: RegExp }> = [
      {
        response: await add(merchantToken, { name: 'Squid Rings', priceBdt: 200, sku: realSku }),
        field: 'sku',
        expect: /unique across every store/i
      },
      {
        response: await add(merchantToken, {
          name: 'Squid Rings',
          priceBdt: 200,
          merchantId: newStore.merchantId
        }),
        field: 'merchantId',
        expect: /store an item belongs to/i
      },
      {
        response: await add(merchantToken, { name: 'Squid Rings', priceBdt: 200, id: 'cat_fixed' }),
        field: 'id',
        expect: /item id is the platform/i
      },
      {
        response: await edit(merchantToken, itemId, { sku: 'MINE-01' }),
        field: 'sku',
        expect: /unique across every store/i
      },
      {
        response: await edit(merchantToken, itemId, { createdAt: '2020-01-01T00:00:00.000Z' }),
        field: 'createdAt',
        expect: /platform keeps these timestamps/i
      }
    ];

    for (const { response, field, expect: expected } of refused) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details.field).toBe(field);
      expect(String(response.body.error.message)).toMatch(expected);
    }

    // A refusal is a refusal: the SKU above never changed.
    expect((await storedItem(itemId))!.sku).toBe(realSku);
  });

  it('refuses a malformed item instead of answering a different one', async () => {
    const created = await add(merchantToken, { name: 'Crab Masala', priceBdt: 900 });
    const itemId = created.body.item.id;

    const refused: ApiResponse[] = [
      await add(merchantToken, { priceBdt: 100 }),
      await add(merchantToken, { name: 'A', priceBdt: 100 }),
      await add(merchantToken, { name: 'Dried Fish', priceBdt: 0 }),
      await add(merchantToken, { name: 'Dried Fish', priceBdt: -50 }),
      await add(merchantToken, { name: 'Dried Fish', priceBdt: 12.345 }),
      await add(merchantToken, { name: 'Dried Fish', priceBdt: '120' }),
      await add(merchantToken, { name: 'Dried Fish', priceBdt: 1_000_001 }),
      await add(merchantToken, { name: 'Dried Fish', priceBdt: 120, isAvailable: 'yes' }),
      // A picture is only fetched by other people's browsers, so only http(s) is one.
      await add(merchantToken, {
        name: 'Dried Fish',
        priceBdt: 120,
        imageUrl: 'javascript:alert(1)'
      }),
      await add(merchantToken, { name: 'Dried Fish', priceBdt: 120, imageUrl: 'not-a-url' }),
      // Nothing to change is a mistake, not a no-op to report as success.
      await edit(merchantToken, itemId, {}),
      await edit(merchantToken, itemId, { priceBdt: 0 }),
      await edit(merchantToken, itemId, { isAvailable: 'no' })
    ];

    for (const response of refused) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }

    // Rounding is refused rather than silent: the item still costs what it was created at.
    expect((await storedItem(itemId))!.priceBdt).toBe(900);
  });

  it('clears a description and an image the merchant no longer wants to show', async () => {
    const created = await add(merchantToken, {
      name: 'Fish Finger Basket',
      priceBdt: 250,
      description: 'With tartare sauce',
      imageUrl: 'https://cdn.coxsbazar.delivery/items/fish-fingers.jpg'
    });
    const itemId = created.body.item.id;

    const cleared = await edit(merchantToken, itemId, { description: null, imageUrl: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.changed).toEqual(['description', 'imageUrl']);
    expect(cleared.body.item).toMatchObject({ description: null, imageUrl: null });
    expect((await storedItem(itemId))!.name).toBe('Fish Finger Basket');
  });

  it('deletes an item nobody has ordered, and keeps one that was', async () => {
    const neverOrdered = await add(merchantToken, { name: 'Seasonal Special', priceBdt: 111 });
    const removals: ApiResponse[] = [
      await remove(merchantToken, neverOrdered.body.item.id),
      await one(merchantToken, neverOrdered.body.item.id)
    ];
    expect(removals[0].status).toBe(200);
    expect(removals[0].body.deletedItemId).toBe(neverOrdered.body.item.id);
    // Gone, not hidden.
    expect(removals[1].status).toBe(404);
    expect(await storedItem(neverOrdered.body.item.id)).toBeNull();

    // An item a customer has ordered is part of that order's history, so it is refused with
    // the switch that does what the merchant meant instead of a database error.
    const ordered = await add(merchantToken, { name: 'Beef Tehari', priceBdt: 210 });
    expect((await orderFor(SEEDED.merchantId, ordered.body.item.id, 'catalog-ordered')).status).toBe(
      201
    );

    const refused = await remove(merchantToken, ordered.body.item.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CONFLICT');
    expect(String(refused.body.error.message)).toMatch(/mark it unavailable/i);
    expect(await storedItem(ordered.body.item.id)).not.toBeNull();

    // The alternative works: off the menu, still in the trail.
    expect((await edit(merchantToken, ordered.body.item.id, { isAvailable: false })).status).toBe(200);
  });

  it('records who changed what, and only for the changes that landed', async () => {
    const created = await add(merchantToken, { name: 'Prawn Tempura', priceBdt: 480 });
    const itemId = created.body.item.id;
    await edit(merchantToken, itemId, { priceBdt: 500 });
    await remove(merchantToken, itemId);

    const rows = await app.client.query<{ action: string; userId: string; oldValues: string; newValues: string }>(
      'SELECT * FROM audit_logs WHERE entityId = ? ORDER BY rowid',
      [itemId]
    );
    expect(rows.rows.map((row) => row.action)).toEqual([
      'CATALOG_ITEM_CREATE',
      'CATALOG_ITEM_UPDATE',
      'CATALOG_ITEM_DELETE'
    ]);
    expect(rows.rows.every((row) => row.userId === SEEDED.merchant.id)).toBe(true);

    const created2 = JSON.parse(rows.rows[0].newValues);
    expect(created2).toMatchObject({
      name: 'Prawn Tempura',
      priceBdt: 480,
      merchantId: SEEDED.merchantId
    });
    const updated = JSON.parse(rows.rows[1].newValues);
    expect(updated.priceBdt).toBe(500);
    expect(updated.changed).toEqual(['priceBdt']);
    expect(JSON.parse(rows.rows[1].oldValues).priceBdt).toBe(480);
    // The delete keeps what was removed, so the row is not the only record of it.
    expect(JSON.parse(rows.rows[2].oldValues).priceBdt).toBe(500);
    expect(rows.rows[2].newValues).toBeNull();

    // Editing what is no longer there is a 404, and it writes nothing: the trail has the one
    // update that landed and the delete that ended the item, not a row per attempt.
    const refusedEdit = await edit(merchantToken, itemId, { priceBdt: 999 });
    expect(refusedEdit.status).toBe(404);
    const after = await app.client.query<{ action: string }>(
      'SELECT action FROM audit_logs WHERE entityId = ? ORDER BY rowid',
      [itemId]
    );
    expect(after.rows.map((row) => row.action)).toEqual([
      'CATALOG_ITEM_CREATE',
      'CATALOG_ITEM_UPDATE',
      'CATALOG_ITEM_DELETE'
    ]);
  });

  it('keeps a shelf to the store that owns it', async () => {
    // A customer cannot reach a catalogue at all, and the refusal names the grant.
    const asCustomer = await list(customerToken);
    expect(asCustomer.status).toBe(403);
    expect(asCustomer.body.error.code).toBe('FORBIDDEN');
    expect(String(asCustomer.body.error.message)).toContain('catalog:manage:merchant');
    expect((await add(customerToken, { name: 'Nothing', priceBdt: 10 })).status).toBe(403);
    expect((await list('')).status).toBe(401);

    // And a merchant cannot reach into another store's shelf: the ids are somebody else's, so
    // they answer 404 rather than confirming what that store sells.
    const otherItem = (await list(merchantToken)).body.items[0].id;
    const foreign: ApiResponse[] = [
      await one(newStore.token, otherItem),
      await edit(newStore.token, otherItem, { priceBdt: 1 }),
      await remove(newStore.token, otherItem)
    ];
    for (const response of foreign) {
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    }
    expect((await storedItem(otherItem))!.merchantId).toBe(SEEDED.merchantId);

    // An approved merchant holds the grant and simply has nothing to edit until it stocks.
    const emptyButApproved = await list(newStore.token);
    expect(emptyButApproved.status).toBe(200);
    expect(emptyButApproved.body.count).toBe(0);
    expect(emptyButApproved.body.items).toEqual([]);
  });

  it('cannot take an order until its first item exists, and can the moment it does', async () => {
    // Empty: the storefront lists nothing and the order path says so rather than pricing a
    // basket from nowhere.
    const emptyMenu = await getJson(app, `/api/v1/merchants/${newStore.merchantId}/menu`);
    expect(emptyMenu.status).toBe(200);
    expect(emptyMenu.body.items).toEqual([]);

    const beforeAnyItem = await orderFor(newStore.merchantId, 'cat_item_001', 'new-store-empty');
    expect(beforeAnyItem.status).toBe(404);
    expect(String(beforeAnyItem.body.error.message)).toMatch(/catalog/i);

    // One item is the whole difference.
    const first = await add(newStore.token, {
      name: 'Miniket Rice 5kg',
      priceBdt: 480,
      category: 'Grocery'
    });
    expect(first.status).toBe(201);
    expect(first.body.item).toMatchObject({
      category: 'Grocery',
      merchantId: newStore.merchantId,
      isAvailable: true
    });

    const menu = await getJson(app, `/api/v1/merchants/${newStore.merchantId}/menu`);
    expect(menu.body.items).toHaveLength(1);

    const accepted = await orderFor(newStore.merchantId, first.body.item.id, 'new-store-stocked');
    expect(accepted.status).toBe(201);
    expect(accepted.body.order).toMatchObject({ merchantId: newStore.merchantId });
    expect(accepted.body.order.pricing.subtotalBdt).toBe(480);
  });

  it('bounds a catalogue before it is added to', async () => {
    // Filled directly: the cap is about the two-hundred-and-first item, and two hundred round
    // trips would only make the test slower than the behaviour it is checking. Whatever the
    // store already lists counts — it cannot be cleared to make room, because the item the
    // test above sold is named by an order.
    const now = new Date().toISOString();
    const listed = await app.client.query<{ total: number }>(
      'SELECT COUNT(*) AS total FROM catalog_items WHERE merchantId = ?',
      [newStore.merchantId]
    );
    const alreadyThere = Number(listed.rows[0]?.total ?? 0);
    expect(alreadyThere).toBeGreaterThan(0);

    for (let index = 0; index < 200 - alreadyThere; index += 1) {
      await app.client.query(
        `INSERT INTO catalog_items (id, merchantId, name, description, category, priceBdt, isAvailable, sku, imageUrl, createdAt, updatedAt)
         VALUES (?, ?, ?, NULL, 'Grocery', 10, 1, ?, NULL, ?, ?)`,
        [
          `cat_bulk_${index}`,
          newStore.merchantId,
          `Bulk Item ${index}`,
          `SKU-BULK-${index}`,
          now,
          now
        ]
      );
    }

    const refused = await add(newStore.token, { name: 'One Too Many', priceBdt: 10 });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CONFLICT');
    expect(String(refused.body.error.message)).toMatch(/at most 200 items/i);
  });
});
