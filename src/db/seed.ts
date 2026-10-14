import { DatabaseClient, db as defaultDb } from './client.js';
import { createStorageDriver } from './storage.js';
import { env } from '../config/env.js';
import {
  UserRepository,
  AuthRepository,
  AddressRepository,
  MerchantRepository,
  CatalogRepository,
  OrderRepository,
  PaymentRepository,
  RiderProfileRepository,
  AuditLogRepository
} from './repositories.js';
import { logger } from '../core/logger.js';

export async function seedDatabase(client: DatabaseClient = defaultDb): Promise<void> {
  logger.info('Starting database seeding...');
  await client.migrate();

  const userRepo = new UserRepository(client);
  const authRepo = new AuthRepository(client);
  const addrRepo = new AddressRepository(client);
  const merchantRepo = new MerchantRepository(client);
  const catalogRepo = new CatalogRepository(client);
  const orderRepo = new OrderRepository(client);
  const paymentRepo = new PaymentRepository(client);
  const riderRepo = new RiderProfileRepository(client);
  const auditRepo = new AuditLogRepository(client);

  // 1. Seed Core Users (Admin, Merchant, Driver, Customer)
  const admin = await userRepo.create({
    id: 'usr_admin_001',
    email: 'admin@coxsbazar.delivery',
    phone: '+8801811000001',
    fullName: 'Cox Platform Administrator',
    role: 'ADMIN',
    isActive: true
  });

  const merchantUser = await userRepo.create({
    id: 'usr_merch_001',
    email: 'merchant@coxsbazar.delivery',
    phone: '+8801811000002',
    fullName: 'Jamil Ahmed (Seafood Express)',
    role: 'MERCHANT',
    isActive: true
  });

  const driver = await userRepo.create({
    id: 'usr_driv_001',
    email: 'driver@coxsbazar.delivery',
    phone: '+8801811000003',
    fullName: 'Rahim Uddin',
    role: 'DRIVER',
    isActive: true
  });

  const customer = await userRepo.create({
    id: 'usr_cust_001',
    email: 'customer@coxsbazar.delivery',
    phone: '+8801811000004',
    fullName: 'Ayesha Siddiqua',
    role: 'CUSTOMER',
    isActive: true
  });

  // 2. Seed Auth Credentials
  await authRepo.saveCredentials({
    id: 'cred_admin_001',
    userId: admin.id,
    passwordHash: 'sha256_mock_hash_admin',
    salt: 'salt_admin_123',
    mfaSecret: null,
    failedAttempts: 0,
    lockedUntil: null
  });

  await authRepo.saveCredentials({
    id: 'cred_cust_001',
    userId: customer.id,
    passwordHash: 'sha256_mock_hash_cust',
    salt: 'salt_cust_123',
    mfaSecret: null,
    failedAttempts: 0,
    lockedUntil: null
  });

  // 3. Seed Addresses
  const merchantAddr = await addrRepo.create({
    id: 'addr_merch_001',
    userId: merchantUser.id,
    label: 'Main Restaurant',
    streetAddress: 'Plot 14, Kolatoli Beach Road',
    area: 'Kolatoli',
    district: "Cox's Bazar",
    postalCode: '4700',
    latitude: 21.4172,
    longitude: 91.9802,
    isDefault: true,
    isPiiRestricted: false
  });

  const customerAddr = await addrRepo.create({
    id: 'addr_cust_001',
    userId: customer.id,
    label: 'Home',
    streetAddress: 'Flat 4B, Sugandha View, Hotel Motel Zone',
    area: 'Sugandha',
    district: "Cox's Bazar",
    postalCode: '4700',
    latitude: 21.4258,
    longitude: 91.9723,
    isDefault: true,
    isPiiRestricted: true
  });

  // 4. Seed Merchant Store
  const merchant = await merchantRepo.create({
    id: 'merch_store_001',
    ownerUserId: merchantUser.id,
    businessName: "Cox's Seafood & BBQ Express",
    tradeLicenseNumber: 'TRAD-CXB-2024-9981',
    description: 'Fresh Bay of Bengal seafood and traditional grill',
    category: 'Restaurant',
    addressId: merchantAddr.id,
    phone: '+8801811000002',
    isOpen: true,
    rating: 4.8
  });

  // 4b. Seed the pilot rider's profile
  // Approval is what creates a rider profile in the normal flow, and the pilot's driver was
  // seeded directly — which left the one rider the pilot has unable to hold a duty state at
  // all. Starting OFF_DUTY like every other approved rider: joining the roster is the rider's
  // own first decision, not something a seed should make for them.
  await riderRepo.create({
    userId: driver.id,
    nidNumber: '1990123456789',
    vehicleType: 'MOTORCYCLE',
    licenseNumber: 'DK-CXB-8811',
    zoneId: 'kolatoli',
    dutyStatus: 'OFF_DUTY'
  });

  // 5. Seed Catalog Items
  const item1 = await catalogRepo.create({
    id: 'cat_item_001',
    merchantId: merchant.id,
    name: 'Grilled Rupchanda (Silver Pomfret)',
    description: 'Fresh marinated Pomfret grilled with Cox special spices',
    category: 'Seafood',
    priceBdt: 750,
    isAvailable: true,
    sku: 'SEAFOOD-RUP-01',
    imageUrl: 'https://cdn.coxsbazar.delivery/items/rupchanda.jpg'
  });

  const item2 = await catalogRepo.create({
    id: 'cat_item_002',
    merchantId: merchant.id,
    name: 'Coral Fish Curry',
    description: 'Spicy coastal curry served with steamed rice portion',
    category: 'Seafood',
    priceBdt: 650,
    isAvailable: true,
    sku: 'SEAFOOD-COR-02',
    imageUrl: 'https://cdn.coxsbazar.delivery/items/coral-curry.jpg'
  });

  // 6. Seed Order & Order Items
  const orderData = await orderRepo.createOrder(
    {
      id: 'ord_001',
      orderNumber: 'CXB-2025-0001',
      customerId: customer.id,
      merchantId: merchant.id,
      driverId: driver.id,
      deliveryAddressId: customerAddr.id,
      status: 'CONFIRMED',
      subtotalBdt: 1400,
      deliveryFeeBdt: 60,
      discountBdt: 0,
      taxBdt: 0,
      totalBdt: 1460,
      specialInstructions: 'Please include extra lime and chutney.',
      cancellationReason: null
    },
    [
      {
        id: 'ord_item_001',
        orderId: 'ord_001',
        catalogItemId: item1.id,
        itemName: item1.name,
        quantity: 1,
        unitPriceBdt: 750,
        totalPriceBdt: 750,
        notes: 'Mild spicy'
      },
      {
        id: 'ord_item_002',
        orderId: 'ord_001',
        catalogItemId: item2.id,
        itemName: item2.name,
        quantity: 1,
        unitPriceBdt: 650,
        totalPriceBdt: 650,
        notes: null
      }
    ]
  );

  // 7. Seed Payment
  const payment = await paymentRepo.create({
    id: 'pay_001',
    orderId: orderData.order.id,
    transactionId: 'TXN_BKASH_8829104',
    provider: 'BKASH',
    method: 'BKASH',
    amountBdt: 1460,
    status: 'COMPLETED',
    rawGatewayResponse: JSON.stringify({ trxID: 'TXN_BKASH_8829104', status: 'Success' })
  });

  // 8. Seed Reconciliation
  await paymentRepo.createReconciliation({
    id: 'rec_001',
    paymentId: payment.id,
    orderId: orderData.order.id,
    gatewayReference: 'BKASH-GATEWAY-REF-001',
    expectedAmountBdt: 1460,
    receivedAmountBdt: 1460,
    status: 'MATCHED',
    notes: 'Auto-reconciled on seed',
    reconciledAt: new Date().toISOString()
  });

  // 9. Seed Audit Log
  await auditRepo.log({
    id: 'aud_001',
    userId: admin.id,
    action: 'SEED_INITIALIZATION',
    entityType: 'PLATFORM',
    entityId: 'SYSTEM',
    oldValues: null,
    newValues: JSON.stringify({ status: 'SEEDED_SUCCESS' }),
    ipAddress: '127.0.0.1',
    userAgent: 'seed-runner/1.0'
  });

  logger.info('Database seeded successfully with core entities');
}

/**
 * Seeds the pilot dataset only when the target database has no users yet.
 * Shared by the server bootstrap and the `db:seed` script so both honour the
 * same "seed once" policy.
 *
 * The emptiness check runs inside a write transaction, so when two processes boot at
 * the same moment against a fresh database they serialise: the first seeds, the second
 * waits for the lock, then finds the rows and skips. Checking outside the transaction
 * let both decide to seed, and the loser died on a duplicate row.
 */
export async function seedIfEmpty(client: DatabaseClient = defaultDb): Promise<boolean> {
  return client.transaction(async (tx) => {
    const existing = await tx.query<{ id: string }>('SELECT id FROM users LIMIT 1');
    if (existing.rows.length > 0) {
      logger.info('Database already contains users; skipping pilot seed');
      return false;
    }
    await seedDatabase(tx);
    return true;
  });
}

if (require.main === module) {
  // Seeded through the same backend selection the API boots with, so `db:seed` cannot fill one
  // database while the server reads another.
  createStorageDriver({
    backend: env.DB_DRIVER,
    sqliteFile: env.SQLITE_STORAGE_PATH,
    databaseUrl: env.DATABASE_URL,
    poolMax: env.PG_POOL_MAX,
    connectionTimeoutMs: env.PG_CONNECTION_TIMEOUT_MS
  })
    .then((storage) => seedIfEmpty(new DatabaseClient(storage.driver)))
    .then((seeded) => {
      logger.info(seeded ? 'Seeding script finished successfully' : 'Database already seeded; nothing to do');
      process.exit(0);
    })
    .catch((err) => {
      logger.error('Failed to seed database', err);
      process.exit(1);
    });
}
