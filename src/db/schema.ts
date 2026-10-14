/**
 * Cox's Bazar Door2Door Platform - Database Schema and Data Models
 */

export type UserRole = 'CUSTOMER' | 'MERCHANT' | 'DRIVER' | 'ADMIN';

/**
 * Review state of a self-registered account. Customers are approved on creation;
 * merchants and riders start PENDING until an admin reviews them.
 */
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/**
 * What a rider registered to ride. Kept here rather than in the registration service so the
 * stored profile and the application that produced it agree on the same vocabulary.
 */
export type RiderVehicleType = 'BICYCLE' | 'MOTORCYCLE' | 'WALKER' | 'EV_SCOOTER';

/**
 * A rider's duty state. A newly approved rider starts OFF_DUTY: the platform hands out work,
 * it does not put somebody on shift.
 */
export type RiderDutyStatus = 'OFF_DUTY' | 'AVAILABLE' | 'ON_DELIVERY' | 'ON_BREAK';

export type OrderStatus = 
  | 'PENDING' 
  | 'CONFIRMED' 
  | 'PREPARING' 
  | 'OUT_FOR_DELIVERY' 
  | 'DELIVERED' 
  | 'CANCELLED';

/**
 * The same states as a value, in the order an order moves through them.
 *
 * A union is erased at runtime and the `orders` table's `CHECK` is a string, so neither can be
 * iterated to refuse `?status=PREPARING_BURNT`. This is the one list a filter is validated
 * against, rather than a fourth hand-written copy beside the type, the DDL and the client.
 */
export const ORDER_STATUSES: readonly OrderStatus[] = [
  'PENDING',
  'CONFIRMED',
  'PREPARING',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED'
];

export type PaymentStatus = 
  | 'PENDING' 
  | 'PROCESSING' 
  | 'COMPLETED' 
  | 'FAILED' 
  | 'REFUNDED';

export type PaymentMethod = 'CASH_ON_DELIVERY' | 'BKASH' | 'NAGAD' | 'CREDIT_CARD';

export type ReconciliationStatus = 'MATCHED' | 'DISCREPANCY' | 'PENDING';

export interface UserRecord {
  id: string;
  email: string;
  phone: string;
  fullName: string;
  role: UserRole;
  isActive: boolean;
  /** Absent only on rows written before approval tracking existed; treat as APPROVED. */
  approvalStatus?: ApprovalStatus;
  /** JSON blob of the onboarding answers submitted at registration. */
  registrationDetails?: string | null;
  /** Reason recorded by the reviewing admin, typically on rejection. */
  approvalReason?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthCredentialRecord {
  id: string;
  userId: string;
  passwordHash: string;
  salt: string;
  mfaSecret?: string | null;
  failedAttempts: number;
  lockedUntil?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  expiresAt: string;
  isRevoked: boolean;
  /** Root of this login's rotation chain. Absent only on pre-migration rows, where the session id is the root. */
  familyId?: string | null;
  /** Session id this token was rotated into, which is what makes a replay recognisable. */
  replacedBy?: string | null;
  createdAt: string;
}

/**
 * A live session as its own owner sees it, which is why it has no `tokenHash`.
 *
 * The digest of a refresh token is the credential: it is the only secret in the row, it is
 * what a stolen copy of the table would let somebody redeem, and nothing outside
 * `AuthRepository` needs to name it. A type that cannot carry it makes "the list accidentally
 * returned the hash" a compile error rather than a review catch, which is why the listing
 * selects these columns explicitly instead of sharing `AuthSessionRecord` and dropping one.
 */
export interface AuthSessionView {
  id: string;
  userId: string;
  /** Root of this login's rotation chain, shared by the tokens it replaced. */
  familyId: string | null;
  /** The address the login came from, or `[redacted]` once past the retention window. */
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface AddressRecord {
  id: string;
  userId: string;
  label: string;
  streetAddress: string;
  area: string;
  district: string;
  postalCode: string;
  latitude?: number | null;
  longitude?: number | null;
  isDefault: boolean;
  isPiiRestricted: boolean;
  /**
   * When the customer took this address out of their list without the row going away.
   *
   * An address an order was delivered to cannot be deleted — the order names it, and the
   * delivery history has to keep resolving — so removing it detaches it instead: every
   * listing, default lookup and id lookup ignores it, and the row survives only as the
   * address those orders were delivered to. `null` means it is on the customer's list.
   */
  removedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MerchantRecord {
  id: string;
  ownerUserId: string;
  businessName: string;
  tradeLicenseNumber: string;
  description?: string | null;
  category: string;
  addressId: string;
  phone: string;
  isOpen: boolean;
  rating: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The operational half of a rider account: identity documents, the vehicle they ride, and
 * whether they are on duty. Created when an admin approves a rider registration, because a
 * permitted account with no profile cannot be dispatched.
 */
export interface RiderProfileRecord {
  userId: string;
  nidNumber: string;
  vehicleType: RiderVehicleType;
  licenseNumber?: string | null;
  zoneId?: string | null;
  dutyStatus: RiderDutyStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogItemRecord {
  id: string;
  merchantId: string;
  name: string;
  description?: string | null;
  category: string;
  priceBdt: number;
  isAvailable: boolean;
  sku: string;
  imageUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderRecord {
  id: string;
  orderNumber: string;
  customerId: string;
  merchantId: string;
  driverId?: string | null;
  deliveryAddressId: string;
  /**
   * The delivery address as it stood when the order was placed, as JSON.
   *
   * The row the id points at is shared and mutable: editing the address a customer moved out
   * of, or retiring it, would otherwise rewrite or erase what this order says about its own
   * delivery. The snapshot is written once, at placement, and read in preference to the row
   * ever after. Absent only on orders placed before the column existed.
   */
  deliveryAddressSnapshot?: string | null;
  status: OrderStatus;
  subtotalBdt: number;
  deliveryFeeBdt: number;
  discountBdt: number;
  taxBdt: number;
  totalBdt: number;
  specialInstructions?: string | null;
  cancellationReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderItemRecord {
  id: string;
  orderId: string;
  catalogItemId: string;
  itemName: string;
  quantity: number;
  unitPriceBdt: number;
  totalPriceBdt: number;
  notes?: string | null;
  createdAt: string;
}

export interface PaymentRecord {
  id: string;
  orderId: string;
  transactionId: string;
  provider: string;
  method: PaymentMethod;
  amountBdt: number;
  status: PaymentStatus;
  rawGatewayResponse?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentReconciliationRecord {
  id: string;
  paymentId: string;
  orderId: string;
  gatewayReference: string;
  expectedAmountBdt: number;
  receivedAmountBdt: number;
  status: ReconciliationStatus;
  notes?: string | null;
  reconciledAt?: string | null;
  createdAt: string;
}

export type RefundStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

export interface RefundRecord {
  id: string;
  orderId: string;
  /** The payment this refund gives back, when one was recorded. */
  paymentId?: string | null;
  amountBdt: number;
  status: RefundStatus;
  /** Why the money went back, from the cancellation policy or the administrator. */
  reason?: string | null;
  notes?: string | null;
  /** The account that authorised it, and the authority it used. */
  initiatedBy: string;
  initiatorRole: UserRole;
  createdAt: string;
}

export interface IdempotencyKeyRecord {
  id: string;
  idempotencyKey: string;
  userId?: string | null;
  endpoint: string;
  requestHash: string;
  responseStatusCode?: number | null;
  responseBody?: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface AuditLogRecord {
  id: string;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  oldValues?: string | null;
  newValues?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  /**
   * The session the acting request came through, when there was one.
   *
   * `userId` answers "which account did this"; this answers "which of that account's logins
   * did this" — the question an incident asks second, and the one the trail could not answer
   * at all while a person's account and their device were the same row. Null on rows written
   * with no request behind them (the seed, a script) and on the routes that are authenticated
   * by something other than a bearer token (login, refresh, logout).
   */
  sessionId?: string | null;
  createdAt: string;
}

/**
 * A recorded OTP SMS dispatch attempt. `delivered` means the gateway accepted the
 * message for delivery, not that a handset received it (see LIMITATIONS_AND_ROADMAP).
 */
/**
 * What the gateway reported about the handset, once it reported anything.
 *
 * The row's `delivered` is whether the gateway *accepted* the message; this is whether it
 * reached the phone. `UNKNOWN` is the honest value for both "nothing has been reported yet"
 * and "something was reported that could not be read" — the gateway's own token is kept
 * beside it in `receiptDetail`, so the two are distinguishable without guessing.
 */
export type SmsReceiptState = 'DELIVERED' | 'FAILED' | 'UNKNOWN';

export interface OtpDeliveryRecord {
  id: string;
  phone: string;
  /** Provider name, or `none` when no provider was configured. */
  provider: string;
  delivered: boolean;
  /** The provider's own status token, e.g. `SENT`, `202` or `1007`. */
  providerStatus?: string | null;
  /** Stable machine code for the failure, e.g. `SMS_PROVIDER_REJECTED`. */
  failureCode?: string | null;
  failureReason?: string | null;
  messageId?: string | null;
  /** How many HTTP attempts the dispatch made before giving up. */
  attempts: number;
  latencyMs?: number | null;
  /** Correlates the row with the API request log line for the same login. */
  requestId?: string | null;
  ipAddress?: string | null;
  /**
   * What the gateway later reported about the handset, when a delivery report has arrived.
   * Absent on rows written before that column existed, which read as `UNKNOWN`.
   */
  receiptState?: SmsReceiptState | null;
  /** JSON: the receipt as it was read — the token, the reason, how the row was matched. */
  receiptDetail?: string | null;
  createdAt: string;
}

/**
 * A notice the platform owes an account holder, stored durably so it can be read after
 * signing in rather than only pushed at them.
 *
 * This is the second channel beside SMS. The phone number is the only contact detail every
 * account really has — an account with no email of its own is stored with a placeholder
 * address that delivers nothing (see `placeholderEmail`) — so a warning that depends on the
 * SMS provider being configured, funded and reachable is a warning that can silently never
 * happen. A row here cannot fail to deliver for any of those reasons: it is already in the
 * platform's own database, waiting for the owner to sign in.
 */
/**
 * What happened when a notice was also pushed out of band — on a channel the owner does not
 * have to sign in to read. `UNKNOWN` means no attempt has reported back, which is both the
 * state of a notice written microseconds ago and the state of one whose attempt never
 * finished; it is the only state an operator may not read as either delivered or failed.
 */
export type OutOfBandState = 'DELIVERED' | 'FAILED' | 'UNKNOWN';

export interface NotificationRecord {
  id: string;
  /** The account the notice belongs to. Never anybody else's. */
  userId: string;
  /** Stable vocabulary for what happened, e.g. `SESSION_REVOKED`. */
  type: string;
  title: string;
  body: string;
  /** JSON blob naming the incident this notice describes. */
  details?: string | null;
  /**
   * The outcome of the out-of-band attempt, carried on the notice itself so the operator
   * question — "was this account holder actually reached?" — is one row and not a
   * reconstruction from the audit trail.
   */
  outOfBandState?: OutOfBandState;
  /** JSON: the attempt's own account of itself (provider, code, message id, when). */
  outOfBandDetail?: string | null;
  createdAt: string;
  /** When the owner read it; null until then. */
  readAt?: string | null;
}

export const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    fullName TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('CUSTOMER', 'MERCHANT', 'DRIVER', 'ADMIN')),
    isActive INTEGER NOT NULL DEFAULT 1,
    approvalStatus TEXT NOT NULL DEFAULT 'APPROVED' CHECK(approvalStatus IN ('PENDING', 'APPROVED', 'REJECTED')),
    registrationDetails TEXT,
    approvalReason TEXT,
    reviewedBy TEXT,
    reviewedAt TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );`,

  `CREATE TABLE IF NOT EXISTS auth_credentials (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    salt TEXT NOT NULL,
    mfaSecret TEXT,
    failedAttempts INTEGER NOT NULL DEFAULT 0,
    lockedUntil TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    tokenHash TEXT NOT NULL UNIQUE,
    ipAddress TEXT,
    userAgent TEXT,
    expiresAt TEXT NOT NULL,
    isRevoked INTEGER NOT NULL DEFAULT 0,
    familyId TEXT,
    replacedBy TEXT,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );`,

  // Phone-login state lives in the database, not in process memory: a code issued by one
  // server process must be verifiable by another, and a restart must not clear a pending
  // code or forget an active resend cooldown. Timestamps are epoch milliseconds so the
  // expiry and cooldown comparisons happen in SQL rather than in application time.
  `CREATE TABLE IF NOT EXISTS otp_challenges (
    phone TEXT PRIMARY KEY,
    otpHash TEXT,
    expiresAt INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    lastSentAt INTEGER NOT NULL
  );`,

  `CREATE TABLE IF NOT EXISTS addresses (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    label TEXT NOT NULL,
    streetAddress TEXT NOT NULL,
    area TEXT NOT NULL,
    district TEXT NOT NULL,
    postalCode TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    isDefault INTEGER NOT NULL DEFAULT 0,
    isPiiRestricted INTEGER NOT NULL DEFAULT 1,
    removedAt TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS merchants (
    id TEXT PRIMARY KEY,
    ownerUserId TEXT NOT NULL,
    businessName TEXT NOT NULL,
    tradeLicenseNumber TEXT UNIQUE NOT NULL,
    description TEXT,
    category TEXT NOT NULL,
    addressId TEXT NOT NULL,
    phone TEXT NOT NULL,
    isOpen INTEGER NOT NULL DEFAULT 1,
    rating REAL NOT NULL DEFAULT 5.0,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (ownerUserId) REFERENCES users(id),
    FOREIGN KEY (addressId) REFERENCES addresses(id)
  );`,

  // Written when an admin approves a rider registration, from the answers on that
  // application. Duty state lives here rather than on the user row: it changes on every
  // shift, while the account itself does not.
  `CREATE TABLE IF NOT EXISTS rider_profiles (
    userId TEXT PRIMARY KEY,
    nidNumber TEXT NOT NULL,
    vehicleType TEXT NOT NULL CHECK(vehicleType IN ('BICYCLE', 'MOTORCYCLE', 'WALKER', 'EV_SCOOTER')),
    licenseNumber TEXT,
    zoneId TEXT,
    dutyStatus TEXT NOT NULL DEFAULT 'OFF_DUTY' CHECK(dutyStatus IN ('OFF_DUTY', 'AVAILABLE', 'ON_DELIVERY', 'ON_BREAK')),
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS catalog_items (
    id TEXT PRIMARY KEY,
    merchantId TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL,
    priceBdt REAL NOT NULL,
    isAvailable INTEGER NOT NULL DEFAULT 1,
    sku TEXT UNIQUE NOT NULL,
    imageUrl TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (merchantId) REFERENCES merchants(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    orderNumber TEXT UNIQUE NOT NULL,
    customerId TEXT NOT NULL,
    merchantId TEXT NOT NULL,
    driverId TEXT,
    deliveryAddressId TEXT NOT NULL,
    deliveryAddressSnapshot TEXT,
    status TEXT NOT NULL CHECK(status IN ('PENDING', 'CONFIRMED', 'PREPARING', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED')),
    subtotalBdt REAL NOT NULL,
    deliveryFeeBdt REAL NOT NULL,
    discountBdt REAL NOT NULL DEFAULT 0,
    taxBdt REAL NOT NULL DEFAULT 0,
    totalBdt REAL NOT NULL,
    specialInstructions TEXT,
    cancellationReason TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (customerId) REFERENCES users(id),
    FOREIGN KEY (merchantId) REFERENCES merchants(id),
    FOREIGN KEY (driverId) REFERENCES users(id),
    FOREIGN KEY (deliveryAddressId) REFERENCES addresses(id)
  );`,

  `CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    orderId TEXT NOT NULL,
    catalogItemId TEXT NOT NULL,
    itemName TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unitPriceBdt REAL NOT NULL,
    totalPriceBdt REAL NOT NULL,
    notes TEXT,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (orderId) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (catalogItemId) REFERENCES catalog_items(id)
  );`,

  `CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    orderId TEXT NOT NULL,
    transactionId TEXT UNIQUE NOT NULL,
    provider TEXT NOT NULL,
    method TEXT NOT NULL,
    amountBdt REAL NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED')),
    rawGatewayResponse TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (orderId) REFERENCES orders(id)
  );`,

  `CREATE TABLE IF NOT EXISTS payment_reconciliations (
    id TEXT PRIMARY KEY,
    paymentId TEXT NOT NULL,
    orderId TEXT NOT NULL,
    gatewayReference TEXT NOT NULL,
    expectedAmountBdt REAL NOT NULL,
    receivedAmountBdt REAL NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('MATCHED', 'DISCREPANCY', 'PENDING')),
    notes TEXT,
    reconciledAt TEXT,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (paymentId) REFERENCES payments(id),
    FOREIGN KEY (orderId) REFERENCES orders(id)
  );`,

  // A refund is its own row, not a flag on the payment: the amount that went back, who
  // authorised it and why are what a customer dispute is settled with. `initiatorRole`
  // records which authority was used — the customer inside the self-service window, or an
  // administrator outside it.
  `CREATE TABLE IF NOT EXISTS refunds (
    id TEXT PRIMARY KEY,
    orderId TEXT NOT NULL,
    paymentId TEXT,
    amountBdt REAL NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('PENDING', 'COMPLETED', 'FAILED')),
    reason TEXT,
    notes TEXT,
    initiatedBy TEXT NOT NULL,
    initiatorRole TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (orderId) REFERENCES orders(id),
    FOREIGN KEY (paymentId) REFERENCES payments(id)
  );`,

  // Refunds may be partial and may happen more than once for one order, so the invariant
  // is a sum rather than a single row: the refunds against an order may never exceed what
  // was paid for it. That is checked inside the write transaction that records a refund
  // (see src/http/routes/paymentRoutes.ts), which `BEGIN IMMEDIATE` serialises across
  // processes — two different Idempotency-Keys asking for the same money back cannot both
  // succeed, however they interleave.
  `CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(orderId);`,

  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    id TEXT PRIMARY KEY,
    idempotencyKey TEXT UNIQUE NOT NULL,
    userId TEXT,
    endpoint TEXT NOT NULL,
    requestHash TEXT NOT NULL,
    responseStatusCode INTEGER,
    responseBody TEXT,
    expiresAt TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );`,

  `CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    userId TEXT,
    action TEXT NOT NULL,
    entityType TEXT NOT NULL,
    entityId TEXT NOT NULL,
    oldValues TEXT,
    newValues TEXT,
    ipAddress TEXT,
    userAgent TEXT,
    sessionId TEXT,
    createdAt TEXT NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);`,
  `CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);`,
  `CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(tokenHash);`,
  // Client addresses are redacted by age (`src/auth/clientAddressRetention.ts`), so the
  // sweep needs the column it filters on rather than scanning two growing tables hourly.
  `CREATE INDEX IF NOT EXISTS idx_auth_sessions_created ON auth_sessions(createdAt);`,
  `CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(createdAt);`,
  `CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customerId);`,
  `CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchantId);`,
  `CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driverId);`,
  `CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(orderId);`,
  `CREATE INDEX IF NOT EXISTS idx_payments_tx ON payments(transactionId);`,
  // At most one *completed* payment per order: a second charge for the same order is a
  // double charge, whatever key it arrives with. Failed and pending attempts stay
  // unconstrained, because retrying a charge that did not go through is normal. A
  // database that already holds two completed payments for one order fails this index at
  // boot instead of keeping the double charge quietly — no code path could ever have
  // written such a row, since payments were only written by the seed data.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_order_completed ON payments(orderId) WHERE status = 'COMPLETED';`,
  `CREATE INDEX IF NOT EXISTS idx_idempotency_key ON idempotency_keys(idempotencyKey);`,
  // Expired keys are pruned as orders are placed, so the sweep needs its own index rather
  // than scanning the table on every write.
  `CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expiresAt);`,
  `CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entityType, entityId);`,
  `CREATE INDEX IF NOT EXISTS idx_otp_challenges_last_sent ON otp_challenges(lastSentAt);`,

  // One row per OTP SMS dispatch, recorded after the attempt whether it succeeded or not,
  // so an operator can answer "did this login's code actually go out?". This is the only
  // place a provider's own words are kept: the application log rotates away, and the
  // gateway dashboard needs a message id nobody wrote down.
  `CREATE TABLE IF NOT EXISTS otp_deliveries (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    provider TEXT NOT NULL,
    delivered INTEGER NOT NULL,
    providerStatus TEXT,
    failureCode TEXT,
    failureReason TEXT,
    messageId TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    latencyMs INTEGER,
    requestId TEXT,
    ipAddress TEXT,
    receiptState TEXT NOT NULL DEFAULT 'UNKNOWN',
    receiptDetail TEXT,
    createdAt TEXT NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS idx_otp_deliveries_phone ON otp_deliveries(phone, createdAt);`,
  `CREATE INDEX IF NOT EXISTS idx_otp_deliveries_created ON otp_deliveries(createdAt);`,
  // A delivery report from the gateway names the message, not our row, so the provider's own
  // identifier is what a receipt is correlated by — and therefore the column worth an index.
  // `provider` leads it because two gateways may reuse the same reference space.
  `CREATE INDEX IF NOT EXISTS idx_otp_deliveries_message ON otp_deliveries(provider, messageId);`,

  // Dispatch asks "which riders are on duty?", and a merchant is found by its owner.
  `CREATE INDEX IF NOT EXISTS idx_rider_profiles_duty ON rider_profiles(dutyStatus);`,
  `CREATE INDEX IF NOT EXISTS idx_merchants_owner ON merchants(ownerUserId);`,

  // The request-rate-limit counter, one row per client, so the configured burst is a
  // property of the deployment rather than of each process in it. `key` is a keyed digest
  // of the client address, never the address itself: the counter only needs to recognise
  // the same client again, and a table that every request writes to is the last place that
  // should be accumulating where customers live. Rows are dropped once their window has
  // closed, so the table holds the clients seen in the last window and nothing older.
  `CREATE TABLE IF NOT EXISTS request_rate_limits (
    key TEXT PRIMARY KEY,
    windowStart INTEGER NOT NULL,
    hits INTEGER NOT NULL,
    sessionId TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_request_rate_limits_window ON request_rate_limits(windowStart);`,

  // The in-app half of a security notice: one row per warning the platform owes an account
  // holder, readable after sign-in. A row is keyed to the account rather than to a contact
  // detail, so it survives the SMS channel being unconfigured, rejected or out of budget —
  // and it is the only channel that reaches an account with no deliverable email.
  `CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    details TEXT,
    outOfBandState TEXT NOT NULL DEFAULT 'UNKNOWN',
    outOfBandDetail TEXT,
    createdAt TEXT NOT NULL,
    readAt TEXT,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );`,

  // Both reads the API makes are "this account's notices, newest first", so one index on the
  // account and the ordering covers them without scanning the table.
  `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(userId, createdAt);`
];

/**
 * Column additions for databases created before the column existed. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so `DatabaseClient.migrate()` runs these and ignores the
 * "duplicate column name" error that an already-current database raises.
 */
export const MIGRATION_STATEMENTS = [
  `ALTER TABLE users ADD COLUMN approvalStatus TEXT NOT NULL DEFAULT 'APPROVED' CHECK(approvalStatus IN ('PENDING', 'APPROVED', 'REJECTED'))`,
  `ALTER TABLE users ADD COLUMN registrationDetails TEXT`,
  `ALTER TABLE users ADD COLUMN approvalReason TEXT`,
  `ALTER TABLE users ADD COLUMN reviewedBy TEXT`,
  `ALTER TABLE users ADD COLUMN reviewedAt TEXT`,
  `ALTER TABLE auth_sessions ADD COLUMN familyId TEXT`,
  `ALTER TABLE auth_sessions ADD COLUMN replacedBy TEXT`,
  // Index created here, not in DDL_STATEMENTS: legacy databases lack the column until above.
  `CREATE INDEX IF NOT EXISTS idx_auth_sessions_family ON auth_sessions(familyId)`,
  // Created here rather than in DDL_STATEMENTS: on a database from the previous schema
  // the column does not exist until the statements above have run.
  `CREATE INDEX IF NOT EXISTS idx_users_approval ON users(approvalStatus, role)`,
  // A notice written before its channel reported back carries no outcome, which is exactly
  // what `UNKNOWN` means; existing rows are given that default rather than being guessed at.
  `ALTER TABLE notifications ADD COLUMN outOfBandState TEXT NOT NULL DEFAULT 'UNKNOWN'`,
  `ALTER TABLE notifications ADD COLUMN outOfBandDetail TEXT`,
  // Rows written before the session was recorded have no value, and NULL is the honest
  // reading of that: "nobody knows which session", not "this session". They are not
  // backfilled from `userId`, because a guess would be indistinguishable from an answer.
  `ALTER TABLE audit_logs ADD COLUMN sessionId TEXT`,
  `ALTER TABLE request_rate_limits ADD COLUMN sessionId TEXT`,
  // Created here, not in DDL_STATEMENTS: on a database from the previous schema the column
  // does not exist until the statement above has run, and an index on a missing column stops
  // the boot rather than failing quietly. The trail is read by victim — "what did this session
  // do?" is the question an incident starts from — and it is asked against a table that only
  // grows, so the column it is filtered by is worth an index of its own.
  `CREATE INDEX IF NOT EXISTS idx_audit_logs_session ON audit_logs(sessionId)`,
  // An address kept only for the delivery history of the orders that name it; every list of a
  // customer's addresses, and every default lookup, now filters on this column.
  `ALTER TABLE addresses ADD COLUMN removedAt TEXT`,
  // Written at placement rather than derived later, so an order's own record of where it went
  // cannot be rewritten by a later edit of the address it names.
  `ALTER TABLE orders ADD COLUMN deliveryAddressSnapshot TEXT`,
  // The gateway's report about the handset, which arrives after the send and on a route of its
  // own. A row written before this column existed has not been receipted, which is exactly
  // what UNKNOWN means; it is the same default the detail-less notices use.
  `ALTER TABLE otp_deliveries ADD COLUMN receiptState TEXT NOT NULL DEFAULT 'UNKNOWN'`,
  `ALTER TABLE otp_deliveries ADD COLUMN receiptDetail TEXT`
];
