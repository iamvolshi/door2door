import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseClient } from '../src/db/client.js';
import { SqliteDriver } from '../src/db/sqliteDriver.js';
import {
  AddressRepository,
  MerchantRepository,
  OrderRepository,
  UserRepository
} from '../src/db/repositories.js';
import type { AddressRecord } from '../src/db/schema.js';
import { parseDeliveryAddressSnapshot, snapshotDeliveryAddress } from '../src/services/addressRules.js';

/**
 * Delivery history, against the same file-backed engine the server runs.
 *
 * The in-memory test driver in `db.test.ts` interprets a useful subset of SQL and ignores
 * exactly the parts these rules are made of — `IS NULL`, the second and later `AND`, and
 * `COUNT(*)` — so a rule like "a detached address is not in the list" cannot be told from its
 * absence there. Everything asserted here is asserted against real SQLite.
 */
describe('Delivery address history', () => {
  let client: DatabaseClient | null = null;

  async function openDatabase(): Promise<DatabaseClient> {
    DatabaseClient.resetInstance();
    const opened = new DatabaseClient(new SqliteDriver(':memory:'));
    await opened.migrate();
    client = opened;
    return opened;
  }

  afterEach(async () => {
    await client?.close();
    client = null;
  });

  /** A customer, a store with its own shop address, and the repositories that drive them. */
  async function seedWorld(db: DatabaseClient) {
    const users = new UserRepository(db);
    const addresses = new AddressRepository(db);
    const merchants = new MerchantRepository(db);
    const orders = new OrderRepository(db);

    await users.create({
      id: 'u_cust',
      email: 'cust@coxs.com',
      phone: '+8801715500100',
      fullName: 'History Customer',
      role: 'CUSTOMER',
      isActive: true
    });
    await users.create({
      id: 'u_owner',
      email: 'owner@coxs.com',
      phone: '+8801715500101',
      fullName: 'History Merchant',
      role: 'MERCHANT',
      isActive: true
    });

    const shop = await addresses.create({
      id: 'addr_shop',
      userId: 'u_owner',
      label: 'Shop',
      streetAddress: 'Market Road 2',
      area: 'Jhawtala',
      district: "Cox's Bazar",
      postalCode: '4700',
      latitude: null,
      longitude: null,
      isDefault: false,
      isPiiRestricted: false
    });
    const merchant = await merchants.create({
      id: 'm_hist',
      ownerUserId: 'u_owner',
      businessName: 'History Store',
      tradeLicenseNumber: 'LIC-HIST-1',
      description: null,
      category: 'Cafe',
      addressId: shop.id,
      phone: '+8801715500101',
      isOpen: true,
      rating: 5
    });

    return { users, addresses, merchants, orders, merchantId: merchant.id };
  }

  /** Where the customer lives, with something in it a test can recognise. */
  function homeFields(): Omit<AddressRecord, 'id' | 'userId' | 'isDefault' | 'createdAt' | 'updatedAt'> {
    return {
      label: 'Home',
      streetAddress: 'Old Road 1',
      area: 'Kolatoli',
      district: "Cox's Bazar",
      postalCode: '4700',
      latitude: 21.42,
      longitude: 91.97,
      isPiiRestricted: true
    };
  }

  async function placeOrder(
    orders: OrderRepository,
    merchantId: string,
    address: AddressRecord,
    id = 'ord_hist'
  ): Promise<{ deliveryAddressSnapshot?: string | null }> {
    const { order } = await orders.createOrder(
      {
        id,
        orderNumber: `CXB-${id}`,
        customerId: 'u_cust',
        merchantId,
        deliveryAddressId: address.id,
        status: 'PENDING',
        subtotalBdt: 100,
        deliveryFeeBdt: 20,
        discountBdt: 0,
        taxBdt: 0,
        totalBdt: 120,
        // Taken at placement, which is what makes the delivery survive the row changing.
        deliveryAddressSnapshot: JSON.stringify(snapshotDeliveryAddress(address))
      },
      []
    );
    return order;
  }

  it('takes an ordered-to address off its owner’s list while both the row and the delivery stay', async () => {
    const db = await openDatabase();
    const { addresses, orders, merchantId } = await seedWorld(db);

    const home = await addresses.create({ id: 'addr_home', userId: 'u_cust', isDefault: true, ...homeFields() });
    const order = await placeOrder(orders, merchantId, home);

    // The order carries the address itself, not only an id that can be edited out from under it.
    expect(parseDeliveryAddressSnapshot(order.deliveryAddressSnapshot)?.streetAddress).toBe('Old Road 1');
    expect(await orders.countByDeliveryAddressId(home.id)).toBe(1);

    expect(await addresses.markRemoved(home.id, 'u_cust', new Date().toISOString())).toBe(true);

    // Still on file, for the delivery that names it…
    const kept = await addresses.findById(home.id);
    expect(kept).not.toBeNull();
    expect(kept?.removedAt).not.toBeNull();
    expect(kept?.isDefault).toBe(false);
    expect(await orders.countByDeliveryAddressId(home.id)).toBe(1);

    // …and gone from every question its owner can ask about their own addresses.
    expect(await addresses.findByUserId('u_cust')).toHaveLength(0);
    expect(await addresses.findDefaultByUserId('u_cust')).toBeNull();
    expect(await addresses.countByUserId('u_cust')).toBe(0);

    // Including editing it, which is what stops a detached address being quietly brought back.
    expect(await addresses.updateOwned(home.id, 'u_cust', { streetAddress: 'New Road 9' })).toBeNull();
    expect((await addresses.findById(home.id))?.streetAddress).toBe('Old Road 1');

    // A second request is a no-op rather than another detachment with a new timestamp, and
    // somebody else's account cannot detach it at all.
    expect(await addresses.markRemoved(home.id, 'u_cust', new Date().toISOString())).toBe(false);
    expect(await addresses.markRemoved(home.id, 'u_owner', new Date().toISOString())).toBe(false);
  });

  it('deletes an address no order names, and lets the next one take over as default', async () => {
    const db = await openDatabase();
    const { addresses, orders } = await seedWorld(db);

    const first = await addresses.create({ id: 'addr_first', userId: 'u_cust', isDefault: true, ...homeFields() });
    const second = await addresses.create({
      id: 'addr_second',
      userId: 'u_cust',
      isDefault: false,
      ...homeFields(),
      label: 'Work',
      streetAddress: 'Clinic Road 4'
    });

    // Nothing needs this row, so it goes — unlike the address a delivery was sent to.
    expect(await orders.countByDeliveryAddressId(first.id)).toBe(0);
    expect(await addresses.removeOwned(first.id, 'u_cust')).toBe(true);
    expect(await addresses.findById(first.id)).toBeNull();
    expect(await addresses.findDefaultByUserId('u_cust')).toBeNull();

    // What the delete handler does with the loss of the default: hand it to the next one.
    const promoted = await addresses.markDefault(second.id, 'u_cust');
    expect(promoted?.isDefault).toBe(true);
    expect((await addresses.findDefaultByUserId('u_cust'))?.id).toBe(second.id);
  });

  it('gives a database created before these columns what it needs to keep a delivery', async () => {
    const db = await openDatabase();

    // The state of an existing deployment: the tables are there and these columns are not.
    await db.query('ALTER TABLE addresses DROP COLUMN removedAt');
    await db.query('ALTER TABLE orders DROP COLUMN deliveryAddressSnapshot');

    await db.migrate();

    const { addresses, orders, merchantId } = await seedWorld(db);
    const home = await addresses.create({ id: 'addr_home', userId: 'u_cust', isDefault: true, ...homeFields() });

    // Both columns are back, and both are usable: the snapshot round-trips, and a detachment —
    // which writes `removedAt` and filters on it — takes effect.
    const order = await placeOrder(orders, merchantId, home);
    expect(parseDeliveryAddressSnapshot(order.deliveryAddressSnapshot)?.streetAddress).toBe('Old Road 1');
    expect(await addresses.markRemoved(home.id, 'u_cust', new Date().toISOString())).toBe(true);
    expect(await addresses.findByUserId('u_cust')).toHaveLength(0);
  });
});
