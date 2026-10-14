import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseClient, MemoryDatabaseDriver } from '../src/db/client.js';
import {
  UserRepository,
  AuthRepository,
  AddressRepository,
  MerchantRepository,
  CatalogRepository,
  OrderRepository,
  PaymentRepository,
  IdempotencyRepository,
  AuditLogRepository
} from '../src/db/repositories.js';
import { seedDatabase } from '../src/db/seed.js';

describe('Database Schema & Repository Layer', () => {
  let client: DatabaseClient;

  beforeEach(() => {
    DatabaseClient.resetInstance();
    client = new DatabaseClient(new MemoryDatabaseDriver());
  });

  it('migrates schema and creates all tables cleanly', async () => {
    await client.migrate();
    const health = await client.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.timestamp).toBeDefined();
  });

  it('executes user repository CRUD operations', async () => {
    await client.migrate();
    const userRepo = new UserRepository(client);

    const user = await userRepo.create({
      id: 'u_1',
      email: 'test@coxs.com',
      phone: '+8801700000000',
      fullName: 'Test User',
      role: 'CUSTOMER',
      isActive: true
    });

    expect(user.id).toBe('u_1');
    expect(user.email).toBe('test@coxs.com');
    expect(user.createdAt).toBeDefined();

    const fetched = await userRepo.findById('u_1');
    expect(fetched).not.toBeNull();
    expect(fetched?.fullName).toBe('Test User');

    const byEmail = await userRepo.findByEmail('test@coxs.com');
    expect(byEmail).not.toBeNull();
    expect(byEmail?.id).toBe('u_1');

    const updated = await userRepo.updateStatus('u_1', false);
    expect(updated.isActive).toBe(false);
  });

  it('manages auth credentials and sessions', async () => {
    await client.migrate();
    const authRepo = new AuthRepository(client);

    await authRepo.saveCredentials({
      id: 'cred_1',
      userId: 'u_1',
      passwordHash: 'hash123',
      salt: 'salt123',
      mfaSecret: null,
      failedAttempts: 0,
      lockedUntil: null
    });

    const creds = await authRepo.getCredentialsByUserId('u_1');
    expect(creds?.passwordHash).toBe('hash123');

    const session = await authRepo.createSession({
      id: 'sess_1',
      userId: 'u_1',
      tokenHash: 'tok_abc_123',
      ipAddress: '192.168.1.1',
      userAgent: 'Jest/Test',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      isRevoked: false
    });

    expect(session.isRevoked).toBe(false);
    const fetchedSession = await authRepo.getSessionByTokenHash('tok_abc_123');
    expect(fetchedSession?.userId).toBe('u_1');

    // The id both of a session's tokens name is what a bearer request is checked against.
    const byId = await authRepo.getSessionById('sess_1');
    expect(byId?.tokenHash).toBe('tok_abc_123');
    expect(byId?.isRevoked).toBe(false);
    expect(await authRepo.getSessionById('sess_missing')).toBeNull();
  });

  it('supports orders, catalog items, payments and idempotency keys', async () => {
    await client.migrate();
    const addrRepo = new AddressRepository(client);
    const merchRepo = new MerchantRepository(client);
    const catRepo = new CatalogRepository(client);
    const orderRepo = new OrderRepository(client);
    const payRepo = new PaymentRepository(client);
    const idemRepo = new IdempotencyRepository(client);
    const auditRepo = new AuditLogRepository(client);

    const address = await addrRepo.create({
      id: 'addr_test',
      userId: 'u_1',
      label: 'Office',
      streetAddress: 'Laboni Beach Point',
      area: 'Laboni',
      district: "Cox's Bazar",
      postalCode: '4700',
      latitude: 21.43,
      longitude: 91.97,
      isDefault: true,
      isPiiRestricted: true
    });
    expect(address.isPiiRestricted).toBe(true);

    const merchant = await merchRepo.create({
      id: 'm_1',
      ownerUserId: 'u_1',
      businessName: 'Sea View Cafe',
      tradeLicenseNumber: 'LIC-100',
      description: 'Beach cafe',
      category: 'Cafe',
      addressId: address.id,
      phone: '+8801800000000',
      isOpen: true,
      rating: 5.0
    });
    expect(merchant.businessName).toBe('Sea View Cafe');

    const item = await catRepo.create({
      id: 'itm_1',
      merchantId: merchant.id,
      name: 'Cold Coffee',
      category: 'Beverage',
      priceBdt: 120,
      isAvailable: true,
      sku: 'BEV-CC-1'
    });
    expect(item.priceBdt).toBe(120);

    const { order, items } = await orderRepo.createOrder(
      {
        id: 'ord_100',
        orderNumber: 'CXB-100',
        customerId: 'u_1',
        merchantId: merchant.id,
        deliveryAddressId: address.id,
        status: 'PENDING',
        subtotalBdt: 120,
        deliveryFeeBdt: 30,
        discountBdt: 0,
        taxBdt: 0,
        totalBdt: 150
      },
      [
        {
          id: 'item_100',
          orderId: 'ord_100',
          catalogItemId: item.id,
          itemName: item.name,
          quantity: 1,
          unitPriceBdt: 120,
          totalPriceBdt: 120
        }
      ]
    );
    expect(order.totalBdt).toBe(150);
    expect(items.length).toBe(1);

    const updatedOrder = await orderRepo.updateStatus('ord_100', 'PREPARING');
    expect(updatedOrder.status).toBe('PREPARING');

    const payment = await payRepo.create({
      id: 'pay_100',
      orderId: order.id,
      transactionId: 'TXN_100',
      provider: 'NAGAD',
      method: 'NAGAD',
      amountBdt: 150,
      status: 'PENDING'
    });
    expect(payment.status).toBe('PENDING');

    const updatedPayment = await payRepo.updateStatus('pay_100', 'COMPLETED');
    expect(updatedPayment.status).toBe('COMPLETED');

    const idem = await idemRepo.save({
      id: 'idem_1',
      idempotencyKey: 'key_abc_xyz',
      endpoint: '/orders',
      requestHash: 'hash_abc',
      expiresAt: new Date(Date.now() + 60000).toISOString()
    });
    expect(idem.idempotencyKey).toBe('key_abc_xyz');
    const fetchedIdem = await idemRepo.findByKey('key_abc_xyz');
    expect(fetchedIdem?.requestHash).toBe('hash_abc');

    const audit = await auditRepo.log({
      id: 'aud_1',
      userId: 'u_1',
      action: 'ORDER_PLACED',
      entityType: 'ORDER',
      entityId: order.id,
      newValues: JSON.stringify({ status: 'PENDING' })
    });
    expect(audit.action).toBe('ORDER_PLACED');
  });

  it('seeds sample database fixtures completely without errors', async () => {
    await seedDatabase(client);
    const userRepo = new UserRepository(client);
    const admin = await userRepo.findById('usr_admin_001');
    expect(admin).not.toBeNull();
    expect(admin?.role).toBe('ADMIN');

    const orderRepo = new OrderRepository(client);
    const order = await orderRepo.findById('ord_001');
    expect(order).not.toBeNull();
    expect(order?.orderNumber).toBe('CXB-2025-0001');
  });
});
