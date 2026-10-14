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
  type LoggedInAccount,
  type RunningServer
} from './apiTestClient';

/**
 * Each phone number is used for exactly one OTP request: resends are throttled to one
 * per 60 seconds per number, so reusing a number would make the suite time-dependent.
 */
const PHONE = {
  handshake: '+8801755000001',
  wrongCode: '+8801755000002',
  customer: '+8801755000003',
  replay: '+8801755000004',
  alreadyRegistered: '+8801755000005',
  emailA: '+8801755000006',
  emailB: '+8801755000007',
  rider: '+8801755000008',
  merchant: '+8801755000009',
  rejectedRider: '+8801755000010',
  plainCustomer: '+8801755000011',
  extraMerchant: '+8801755000012',
  storeMerchant: '+8801755000013',
  approvedRider: '+8801755000014',
  conflictLicence: '+8801755000015',
  legacyMerchant: '+8801755000016',
  duplicateLicence: '+8801755000017'
} as const;

const SHARED_EMAIL = 'nusrat@example.com';

let tempDir: string;
let app: RunningServer;
let admin: LoggedInAccount;
let approvedMerchantId: string;

function wrongCode(realCode: string): string {
  return realCode === '000000' ? '111111' : '000000';
}

/** Requests a code for a phone and confirms the API answers with a registration offer. */
async function startRegistration(phone: string): Promise<string> {
  const request = await postJson(app, '/api/v1/auth/otp/request', { phone });
  expect(request.status).toBe(200);
  const otp = request.body.devOtp;
  expect(typeof otp).toBe('string');

  const verify = await postJson(app, '/api/v1/auth/otp/verify', { phone, otp });
  expect(verify.status).toBe(200);
  expect(verify.body.registrationRequired).toBe(true);
  expect(verify.body.tokens).toBeUndefined();
  expect(verify.body.user).toBeUndefined();

  return otp;
}

function register(phone: string, otp: string, body: Record<string, unknown> = {}): Promise<ApiResponse> {
  return postJson(app, '/api/v1/auth/register', { phone, otp, ...body });
}

/** Inserts an account directly, for states a normal flow cannot reach quickly. */
async function insertUser(
  phone: string,
  role: string,
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED',
  approvalReason: string | null = null,
  registrationDetails: Record<string, string> | null = null
): Promise<string> {
  const id = `usr_fixture_${phone.slice(-4)}`;
  const now = new Date().toISOString();
  await app.client.query(
    `INSERT INTO users (id, email, phone, fullName, role, isActive, approvalStatus, approvalReason, registrationDetails, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      `${phone.slice(-4)}@fixture.coxsbazar.delivery`,
      phone,
      'Fixture Account',
      role,
      1,
      approvalStatus,
      approvalReason,
      registrationDetails ? JSON.stringify(registrationDetails) : null,
      now,
      now
    ]
  );
  return id;
}

/** The shop address every merchant application carries, spread into a details payload. */
const SHOP_ADDRESS = {
  streetAddress: 'Shop 3, Beach Road',
  area: 'Kolatoli',
  district: "Cox's Bazar",
  postalCode: '4700'
} as const;

describe('Phone registration and account approval', () => {
  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({ port: 0, host: '127.0.0.1', databaseFile: `${tempDir}/registration.sqlite` });
    admin = await login(app, SEEDED.admin.phone);
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  describe('the registration handshake', () => {
    it('offers registration instead of a session for an unknown number', async () => {
      const request = await postJson(app, '/api/v1/auth/otp/request', { phone: PHONE.handshake });
      expect(request.status).toBe(200);

      const verify = await postJson(app, '/api/v1/auth/otp/verify', {
        phone: PHONE.handshake,
        otp: request.body.devOtp
      });

      expect(verify.status).toBe(200);
      expect(verify.body).toMatchObject({
        success: true,
        registrationRequired: true,
        phone: PHONE.handshake
      });
      expect(verify.body.tokens).toBeUndefined();
      expect(verify.body.user).toBeUndefined();
    });

    it('rejects a wrong code for an unknown number like any other wrong code', async () => {
      const request = await postJson(app, '/api/v1/auth/otp/request', { phone: PHONE.wrongCode });
      expect(request.status).toBe(200);

      const verify = await postJson(app, '/api/v1/auth/otp/verify', {
        phone: PHONE.wrongCode,
        otp: wrongCode(request.body.devOtp)
      });
      expect(verify.status).toBe(401);
      expect(verify.body.error.message).toBe('Incorrect verification code');
    });

    it('creates a customer who can use the account straight away', async () => {
      const otp = await startRegistration(PHONE.customer);

      // A wrong code is refused before anything is created.
      const wrong = await register(PHONE.customer, wrongCode(otp), {
        fullName: 'Nusrat Jahan',
        role: 'CUSTOMER'
      });
      expect(wrong.status).toBe(401);

      const created = await register(PHONE.customer, otp, { fullName: 'Nusrat Jahan', role: 'customer' });

      expect(created.status).toBe(201);
      expect(created.body.approvalRequired).toBe(false);
      expect(created.body.user).toMatchObject({
        phone: PHONE.customer,
        fullName: 'Nusrat Jahan',
        role: 'CUSTOMER',
        isActive: true,
        approvalStatus: 'APPROVED'
      });
      expect(created.body.user.id).toMatch(/^usr_/);
      // Phone-only signup still has to fill the unique email column.
      expect(created.body.user.email).toBe('8801755000003@phone.coxsbazar.delivery');
      expect(created.body.tokens.accessToken).toBeTruthy();
      expect(created.body.session.id).toMatch(/^sess_/);

      const token = created.body.tokens.accessToken;
      const me = await getJson(app, '/api/v1/auth/me', { token });
      expect(me.status).toBe(200);
      expect(me.body.user.id).toBe(created.body.user.id);
      expect(me.body.user.approvalStatus).toBe('APPROVED');

      // The account is fully usable: it clears the auth and approval gates and holds
      // the customer's permissions (the 400 is the handler's own payload validation).
      const quote = await postJson(app, '/api/v1/orders/quote', {}, { token });
      expect(quote.status).toBe(400);
      expect(quote.body.error.code).toBe('VALIDATION_ERROR');

      const missingOrder = await getJson(app, '/api/v1/orders/ord_missing', { token });
      expect(missingOrder.status).toBe(404);
    });

    it('retires the code that created the account', async () => {
      const otp = await startRegistration(PHONE.replay);
      const created = await register(PHONE.replay, otp, { fullName: 'Rehana Karim', role: 'CUSTOMER' });
      expect(created.status).toBe(201);

      const replay = await register(PHONE.replay, otp, { fullName: 'Rehana Karim', role: 'CUSTOMER' });
      expect(replay.status).toBe(400);
      expect(replay.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('refuses a phone number that already has an account', async () => {
      await insertUser(PHONE.alreadyRegistered, 'CUSTOMER', 'APPROVED');

      const request = await postJson(app, '/api/v1/auth/otp/request', { phone: PHONE.alreadyRegistered });
      expect(request.status).toBe(200);

      const attempt = await register(PHONE.alreadyRegistered, request.body.devOtp, {
        fullName: 'Imposter Account',
        role: 'CUSTOMER'
      });

      expect(attempt.status).toBe(409);
      expect(attempt.body.error.code).toBe('CONFLICT');
      expect(attempt.body.error.message).toMatch(/already exists/i);
    });

    it('refuses an email address that is already registered', async () => {
      const firstOtp = await startRegistration(PHONE.emailA);
      const first = await register(PHONE.emailA, firstOtp, {
        fullName: 'Shared Email One',
        role: 'CUSTOMER',
        email: SHARED_EMAIL
      });
      expect(first.status).toBe(201);
      expect(first.body.user.email).toBe(SHARED_EMAIL);

      const secondOtp = await startRegistration(PHONE.emailB);
      const second = await register(PHONE.emailB, secondOtp, {
        fullName: 'Shared Email Two',
        role: 'CUSTOMER',
        email: SHARED_EMAIL
      });
      expect(second.status).toBe(409);
      expect(second.body.error.message).toMatch(/email/i);
    });
  });

  describe('registration validation', () => {
    let otp: string;

    beforeAll(async () => {
      otp = await startRegistration(PHONE.rider);
    });

    it('never lets anyone self-register as an administrator', async () => {
      const attempt = await register(PHONE.rider, otp, { fullName: 'Ayesha Rahman', role: 'ADMIN' });
      expect(attempt.status).toBe(400);
      expect(attempt.body.error.message).toMatch(/role/);

      const nonsense = await register(PHONE.rider, otp, { fullName: 'Ayesha Rahman', role: 'WIZARD' });
      expect(nonsense.status).toBe(400);
    });

    it('requires a usable full name', async () => {
      const missing = await register(PHONE.rider, otp, { role: 'CUSTOMER' });
      expect(missing.status).toBe(400);
      expect(missing.body.error.message).toMatch(/fullName/);

      const tooShort = await register(PHONE.rider, otp, { fullName: 'A', role: 'CUSTOMER' });
      expect(tooShort.status).toBe(400);
    });

    it('requires the onboarding details that make a review possible', async () => {
      const merchantWithout = await register(PHONE.rider, otp, {
        fullName: 'Ayesha Rahman',
        role: 'MERCHANT'
      });
      expect(merchantWithout.status).toBe(400);
      expect(merchantWithout.body.error.message).toMatch(/businessName/);

      const riderWithoutVehicle = await register(PHONE.rider, otp, {
        fullName: 'Ayesha Rahman',
        role: 'DRIVER',
        details: { nidNumber: '1990123456789' }
      });
      expect(riderWithoutVehicle.status).toBe(400);
      expect(riderWithoutVehicle.body.error.message).toMatch(/vehicleType/);

      const badVehicle = await register(PHONE.rider, otp, {
        fullName: 'Ayesha Rahman',
        role: 'DRIVER',
        details: { nidNumber: '1990123456789', vehicleType: 'HOVERCRAFT' }
      });
      expect(badVehicle.status).toBe(400);
      expect(badVehicle.body.error.message).toMatch(/vehicleType/);
    });

    it('requires a merchant to say where the shop is', async () => {
      const noAddress = await register(PHONE.rider, otp, {
        fullName: 'Ayesha Rahman',
        role: 'MERCHANT',
        details: { businessName: 'Sea Breeze Grill', tradeLicenseNumber: 'TRAD-9911' }
      });
      expect(noAddress.status).toBe(400);
      expect(noAddress.body.error.message).toMatch(/details.streetAddress/);

      const halfAddress = await register(PHONE.rider, otp, {
        fullName: 'Ayesha Rahman',
        role: 'MERCHANT',
        details: {
          businessName: 'Sea Breeze Grill',
          tradeLicenseNumber: 'TRAD-9911',
          streetAddress: 'Shop 3, Beach Road',
          area: 'Kolatoli'
        }
      });
      expect(halfAddress.status).toBe(400);
      expect(halfAddress.body.error.message).toMatch(/details.district/);

      const badPostcode = await register(PHONE.rider, otp, {
        fullName: 'Ayesha Rahman',
        role: 'MERCHANT',
        details: {
          businessName: 'Sea Breeze Grill',
          tradeLicenseNumber: 'TRAD-9911',
          ...SHOP_ADDRESS,
          postalCode: '47'
        }
      });
      expect(badPostcode.status).toBe(400);
      expect(badPostcode.body.error.message).toMatch(/postalCode/);
    });

    it('still accepts the registration after those form errors', async () => {
      // Proof that a verified code is not consumed by validation failures.
      const created = await register(PHONE.rider, otp, {
        fullName: 'Ayesha Rahman',
        role: 'DRIVER',
        details: { nidNumber: '1990123456789', vehicleType: 'motorcycle', licenseNumber: 'DK-2231' }
      });

      expect(created.status).toBe(201);
      expect(created.body.approvalRequired).toBe(true);
      expect(created.body.user).toMatchObject({ role: 'DRIVER', approvalStatus: 'PENDING' });
      expect(created.body.message).toMatch(/review/i);
    });
  });

  describe('merchant and rider approval', () => {
    let merchantToken: string;

    it('creates a merchant account pending review', async () => {
      const otp = await startRegistration(PHONE.merchant);
      const created = await register(PHONE.merchant, otp, {
        fullName: 'Jamil Ahmed',
        role: 'MERCHANT',
        details: {
          businessName: 'Sea Breeze Grill',
          tradeLicenseNumber: 'TRAD-9911',
          zoneId: 'kolatoli',
          ...SHOP_ADDRESS
        }
      });

      expect(created.status).toBe(201);
      expect(created.body.approvalRequired).toBe(true);
      expect(created.body.user).toMatchObject({ role: 'MERCHANT', approvalStatus: 'PENDING', isActive: true });
      // A pending account can sign in so it can watch its own status.
      expect(created.body.tokens.accessToken).toBeTruthy();

      merchantToken = created.body.tokens.accessToken;
      approvedMerchantId = created.body.user.id;

      const me = await getJson(app, '/api/v1/auth/me', { token: merchantToken });
      expect(me.status).toBe(200);
      expect(me.body.user.approvalStatus).toBe('PENDING');
    });

    it('holds back every permission-bearing route while the account is pending', async () => {
      const quote = await postJson(app, '/api/v1/orders/quote', {}, { token: merchantToken });
      expect(quote.status).toBe(403);
      expect(quote.body.error.code).toBe('ACCOUNT_NOT_APPROVED');
      expect(quote.body.error.message).toMatch(/approval/i);

      const order = await getJson(app, '/api/v1/orders/ord_does_not_exist', { token: merchantToken });
      expect(order.status).toBe(403);
      expect(order.body.error.code).toBe('ACCOUNT_NOT_APPROVED');
    });

    it('shows the application in the admin review queue with its details', async () => {
      const queue = await getJson(app, '/api/v1/admin/registrations', { token: admin.accessToken });
      expect(queue.status).toBe(200);

      const entry = queue.body.registrations.find(
        (item: { userId: string }) => item.userId === approvedMerchantId
      );
      expect(entry).toBeTruthy();
      expect(entry).toMatchObject({
        fullName: 'Jamil Ahmed',
        role: 'MERCHANT',
        approvalStatus: 'PENDING',
        reviewedBy: null
      });
      expect(entry.details).toEqual({
        businessName: 'Sea Breeze Grill',
        tradeLicenseNumber: 'TRAD-9911',
        zoneId: 'kolatoli',
        ...SHOP_ADDRESS
      });
      // Customers are never queued for review.
      expect(
        queue.body.registrations.some((item: { role: string }) => item.role === 'CUSTOMER')
      ).toBe(false);

      const riders = await getJson(app, '/api/v1/admin/registrations?role=DRIVER', {
        token: admin.accessToken
      });
      expect(riders.status).toBe(200);
      expect(riders.body.count).toBeGreaterThan(0);
      expect(riders.body.registrations.every((item: { role: string }) => item.role === 'DRIVER')).toBe(true);

      const everything = await getJson(app, '/api/v1/admin/registrations?status=ALL', {
        token: admin.accessToken
      });
      expect(everything.body.count).toBeGreaterThan(queue.body.count);
    });

    it('unlocks the account when an administrator approves it', async () => {
      const approved = await postJson(
        app,
        `/api/v1/admin/registrations/${approvedMerchantId}/approve`,
        {},
        { token: admin.accessToken }
      );

      expect(approved.status).toBe(200);
      expect(approved.body.registration).toMatchObject({
        userId: approvedMerchantId,
        approvalStatus: 'APPROVED',
        reviewedBy: SEEDED.admin.id
      });
      expect(typeof approved.body.registration.reviewedAt).toBe('string');

      // The approval gate is gone; what remains is the merchant's ordinary role limits.
      const quote = await postJson(app, '/api/v1/orders/quote', {}, { token: merchantToken });
      expect(quote.status).toBe(403);
      expect(quote.body.error.code).toBe('FORBIDDEN');

      const me = await getJson(app, '/api/v1/auth/me', { token: merchantToken });
      expect(me.body.user.approvalStatus).toBe('APPROVED');
    });

    it('records both the registration and the review in the audit log', async () => {
      const logs = await app.client.query<{ action: string }>(
        'SELECT action FROM audit_logs WHERE entityId = ?',
        [approvedMerchantId]
      );
      const actions = logs.rows.map((row) => row.action);
      expect(actions).toContain('ACCOUNT_REGISTER');
      expect(actions).toContain('REGISTRATION_APPROVE');
    });

    it('lets a rejected applicant sign in to read the decision', async () => {
      const queue = await getJson(app, '/api/v1/admin/registrations?role=DRIVER', {
        token: admin.accessToken
      });
      const rider = queue.body.registrations.find(
        (item: { details?: { nidNumber?: string } }) => item.details?.nidNumber === '1990123456789'
      );
      expect(rider).toBeTruthy();

      const rejected = await postJson(
        app,
        `/api/v1/admin/registrations/${rider.userId}/reject`,
        { reason: 'NID image is unreadable' },
        { token: admin.accessToken }
      );
      expect(rejected.status).toBe(200);
      expect(rejected.body.registration).toMatchObject({
        approvalStatus: 'REJECTED',
        approvalReason: 'NID image is unreadable',
        reviewedBy: SEEDED.admin.id
      });

      await insertUser(PHONE.rejectedRider, 'DRIVER', 'REJECTED', 'NID image is unreadable');
      const request = await postJson(app, '/api/v1/auth/otp/request', { phone: PHONE.rejectedRider });
      const verify = await postJson(app, '/api/v1/auth/otp/verify', {
        phone: PHONE.rejectedRider,
        otp: request.body.devOtp
      });

      expect(verify.status).toBe(200);
      expect(verify.body.user.approvalStatus).toBe('REJECTED');

      const me = await getJson(app, '/api/v1/auth/me', { token: verify.body.tokens.accessToken });
      expect(me.status).toBe(200);
      expect(me.body.user).toMatchObject({
        approvalStatus: 'REJECTED',
        approvalReason: 'NID image is unreadable'
      });

      const quote = await postJson(app, '/api/v1/orders/quote', {}, {
        token: verify.body.tokens.accessToken
      });
      expect(quote.status).toBe(403);
      expect(quote.body.error.code).toBe('ACCOUNT_NOT_APPROVED');
    });
  });

  describe('review rules and authorization', () => {
    it('lets only administrators read or decide the queue', async () => {
      const anonymous = await getJson(app, '/api/v1/admin/registrations');
      expect(anonymous.status).toBe(401);

      const forgedToken = await getJson(app, '/api/v1/admin/registrations', {
        token: 'not.a.real.token'
      });
      expect(forgedToken.status).toBe(401);

      const otp = await startRegistration(PHONE.plainCustomer);
      const customer = await register(PHONE.plainCustomer, otp, {
        fullName: 'Rakib Hasan',
        role: 'CUSTOMER'
      });
      expect(customer.status).toBe(201);
      const customerToken = customer.body.tokens.accessToken;

      const list = await getJson(app, '/api/v1/admin/registrations', { token: customerToken });
      expect(list.status).toBe(403);
      expect(list.body.error.code).toBe('FORBIDDEN');

      const decide = await postJson(
        app,
        `/api/v1/admin/registrations/${approvedMerchantId}/reject`,
        { reason: 'Not allowed' },
        { token: customerToken }
      );
      expect(decide.status).toBe(403);
      expect(decide.body.error.code).toBe('FORBIDDEN');
    });

    it('validates the review decisions themselves', async () => {
      const unknown = await postJson(
        app,
        '/api/v1/admin/registrations/usr_does_not_exist/approve',
        {},
        { token: admin.accessToken }
      );
      expect(unknown.status).toBe(404);

      const customers = await app.client.query<{ id: string }>(
        "SELECT id FROM users WHERE role = 'CUSTOMER' ORDER BY createdAt LIMIT 1"
      );
      const notReviewable = await postJson(
        app,
        `/api/v1/admin/registrations/${customers.rows[0].id}/approve`,
        {},
        { token: admin.accessToken }
      );
      expect(notReviewable.status).toBe(400);
      expect(notReviewable.body.error.message).toMatch(/not subject to registration review/i);

      const otp = await startRegistration(PHONE.extraMerchant);
      const created = await register(PHONE.extraMerchant, otp, {
        fullName: 'Late Night Cafe',
        role: 'MERCHANT',
        details: {
          businessName: 'Late Night Cafe',
          tradeLicenseNumber: 'TRAD-2200',
          ...SHOP_ADDRESS
        }
      });
      expect(created.status).toBe(201);
      const pendingId = created.body.user.id;

      const withoutReason = await postJson(
        app,
        `/api/v1/admin/registrations/${pendingId}/reject`,
        {},
        { token: admin.accessToken }
      );
      expect(withoutReason.status).toBe(400);
      expect(withoutReason.body.error.message).toMatch(/reason/i);

      const blankReason = await postJson(
        app,
        `/api/v1/admin/registrations/${pendingId}/reject`,
        { reason: '   ' },
        { token: admin.accessToken }
      );
      expect(blankReason.status).toBe(400);

      const rejected = await postJson(
        app,
        `/api/v1/admin/registrations/${pendingId}/reject`,
        { reason: 'Duplicate application' },
        { token: admin.accessToken }
      );
      expect(rejected.status).toBe(200);
      expect(rejected.body.registration.approvalStatus).toBe('REJECTED');

      const rejectedAgain = await postJson(
        app,
        `/api/v1/admin/registrations/${pendingId}/reject`,
        { reason: 'Duplicate application' },
        { token: admin.accessToken }
      );
      expect(rejectedAgain.status).toBe(409);

      const approvedTwice = await postJson(
        app,
        `/api/v1/admin/registrations/${approvedMerchantId}/approve`,
        {},
        { token: admin.accessToken }
      );
      expect(approvedTwice.status).toBe(409);
    });

    it('creates the store and its shop address when a merchant is approved', async () => {
      const otp = await startRegistration(PHONE.storeMerchant);
      const created = await register(PHONE.storeMerchant, otp, {
        fullName: 'Sultana Ahmed',
        role: 'MERCHANT',
        details: {
          businessName: 'Sultana General Store',
          tradeLicenseNumber: 'TRAD-7700',
          category: 'grocery',
          ...SHOP_ADDRESS
        }
      });
      expect(created.status).toBe(201);
      const merchantUserId = created.body.user.id;

      // A permitted account with no store to trade from is exactly the state approval must
      // not leave behind, so nothing exists for it yet.
      const before = await app.client.query('SELECT id FROM merchants WHERE ownerUserId = ?', [
        merchantUserId
      ]);
      expect(before.rows).toHaveLength(0);

      const approved = await postJson(
        app,
        `/api/v1/admin/registrations/${merchantUserId}/approve`,
        {},
        { token: admin.accessToken }
      );
      expect(approved.status).toBe(200);
      expect(approved.body.profile).toMatchObject({
        role: 'MERCHANT',
        businessName: 'Sultana General Store',
        tradeLicenseNumber: 'TRAD-7700',
        category: 'grocery',
        phone: PHONE.storeMerchant,
        isOpen: true
      });

      const merchantId = approved.body.profile.merchantId as string;
      const stored = await app.client.query<{ ownerUserId: string; addressId: string }>(
        'SELECT ownerUserId, addressId FROM merchants WHERE id = ?',
        [merchantId]
      );
      expect(stored.rows[0].ownerUserId).toBe(merchantUserId);

      // The shop address on the application is the one the store now points at, public and
      // labelled as a business rather than a home.
      const address = await app.client.query<{ userId: string; label: string }>(
        'SELECT userId, label, streetAddress, area, district, postalCode, isPiiRestricted FROM addresses WHERE id = ?',
        [stored.rows[0].addressId]
      );
      expect(address.rows[0]).toMatchObject({
        userId: merchantUserId,
        label: 'Shop',
        isPiiRestricted: 0,
        ...SHOP_ADDRESS
      });

      // And the store is usable straight away: the public menu endpoint answers for it.
      const menu = await getJson(app, `/api/v1/merchants/${merchantId}/menu`);
      expect(menu.status).toBe(200);
      expect(menu.body.merchant.businessName).toBe('Sultana General Store');
      expect(menu.body.items).toEqual([]);
    });

    it('creates an off-duty rider profile from the application on approval', async () => {
      const otp = await startRegistration(PHONE.approvedRider);
      const created = await register(PHONE.approvedRider, otp, {
        fullName: 'Rafiq Islam',
        role: 'DRIVER',
        details: {
          nidNumber: '1992112233445',
          vehicleType: 'motorcycle',
          licenseNumber: 'DK-9911',
          zoneId: 'kolatoli'
        }
      });
      expect(created.status).toBe(201);
      const riderUserId = created.body.user.id;

      const approved = await postJson(
        app,
        `/api/v1/admin/registrations/${riderUserId}/approve`,
        {},
        { token: admin.accessToken }
      );
      expect(approved.status).toBe(200);
      expect(approved.body.profile).toEqual({
        role: 'DRIVER',
        userId: riderUserId,
        nidNumber: '1992112233445',
        vehicleType: 'MOTORCYCLE',
        licenseNumber: 'DK-9911',
        zoneId: 'kolatoli',
        dutyStatus: 'OFF_DUTY'
      });

      const rows = await app.client.query<{ nidNumber: string; vehicleType: string; dutyStatus: string }>(
        'SELECT nidNumber, vehicleType, dutyStatus FROM rider_profiles WHERE userId = ?',
        [riderUserId]
      );
      expect(rows.rows[0]).toEqual({
        nidNumber: '1992112233445',
        vehicleType: 'MOTORCYCLE',
        dutyStatus: 'OFF_DUTY'
      });
    });

    it('rolls the approval back when the store cannot be created', async () => {
      // A licence another store already holds is only reachable through a row that skipped
      // the registration checks, which is what an application filed earlier is.
      const conflictingId = await insertUser(
        PHONE.conflictLicence,
        'MERCHANT',
        'PENDING',
        null,
        { businessName: 'Second Sea Breeze', tradeLicenseNumber: 'TRAD-9911', ...SHOP_ADDRESS }
      );

      const approved = await postJson(
        app,
        `/api/v1/admin/registrations/${conflictingId}/approve`,
        {},
        { token: admin.accessToken }
      );
      expect(approved.status).toBe(409);
      expect(approved.body.error.message).toMatch(/licence/i);

      // Nothing half-done: still pending, and no store was left behind.
      const user = await app.client.query<{ approvalStatus: string }>(
        'SELECT approvalStatus FROM users WHERE id = ?',
        [conflictingId]
      );
      expect(user.rows[0].approvalStatus).toBe('PENDING');

      const stores = await app.client.query('SELECT id FROM merchants WHERE ownerUserId = ?', [
        conflictingId
      ]);
      expect(stores.rows).toHaveLength(0);
    });

    it('accepts a shop address from the reviewer for an application that has none', async () => {
      // Filed before merchants had to state an address: the store cannot be built without
      // one, so the reviewer supplies it rather than the approval being stuck for good.
      const legacyId = await insertUser(PHONE.legacyMerchant, 'MERCHANT', 'PENDING', null, {
        businessName: 'Legacy Cafe',
        tradeLicenseNumber: 'TRAD-3300'
      });

      const refused = await postJson(
        app,
        `/api/v1/admin/registrations/${legacyId}/approve`,
        {},
        { token: admin.accessToken }
      );
      expect(refused.status).toBe(400);
      expect(refused.body.error.message).toMatch(/shop address/i);
      expect(refused.body.error.details.field).toBe('address');

      const stillPending = await app.client.query<{ approvalStatus: string }>(
        'SELECT approvalStatus FROM users WHERE id = ?',
        [legacyId]
      );
      expect(stillPending.rows[0].approvalStatus).toBe('PENDING');

      const approved = await postJson(
        app,
        `/api/v1/admin/registrations/${legacyId}/approve`,
        {
          address: {
            streetAddress: 'Room 2, Sugandha Point',
            area: 'Sugandha',
            district: "Cox's Bazar",
            postalCode: '4700'
          }
        },
        { token: admin.accessToken }
      );
      expect(approved.status).toBe(200);
      // No category on the application, so the store is uncategorised rather than absent.
      expect(approved.body.profile).toMatchObject({
        role: 'MERCHANT',
        tradeLicenseNumber: 'TRAD-3300',
        category: 'General'
      });

      const address = await app.client.query<{ streetAddress: string; label: string }>(
        'SELECT streetAddress, area, label FROM addresses WHERE id = ?',
        [approved.body.profile.addressId]
      );
      expect(address.rows[0]).toEqual({
        streetAddress: 'Room 2, Sugandha Point',
        area: 'Sugandha',
        label: 'Shop'
      });
    });

    it('refuses at registration a trade licence another store already holds', async () => {
      const otp = await startRegistration(PHONE.duplicateLicence);
      const created = await register(PHONE.duplicateLicence, otp, {
        fullName: 'Impostor Store',
        role: 'MERCHANT',
        details: {
          businessName: 'Impostor Store',
          tradeLicenseNumber: 'TRAD-9911',
          ...SHOP_ADDRESS
        }
      });
      expect(created.status).toBe(409);
      expect(created.body.error.message).toMatch(/licence/i);
    });

    it('rejects an unknown review status filter', async () => {
      const response = await getJson(app, '/api/v1/admin/registrations?status=NONSENSE', {
        token: admin.accessToken
      });
      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/status/);
    });
  });
});
