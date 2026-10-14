import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRoutes } from '../src/http/app';
import { AccountStatusService } from '../src/auth/accountStatusService';
import { ClientAddressRetention } from '../src/auth/clientAddressRetention';
import { OtpDeliveryLog } from '../src/auth/otpDeliveryLog';
import { DatabaseOtpStore } from '../src/auth/otpStore';
import { PhoneAuthService } from '../src/auth/phoneAuth';
import { hasPermission, type Permission } from '../src/auth/rbac';
import { RegistrationService } from '../src/auth/registrationService';
import { SessionService } from '../src/auth/sessionService';
import {
  AddressRepository,
  AuditLogRepository,
  CatalogRepository,
  MerchantRepository,
  NotificationRepository,
  OrderRepository,
  OtpDeliveryRepository,
  RetentionRepository,
  UserRepository
} from '../src/db/repositories';
import type { UserRole } from '../src/db/schema';
import type { Route, RouteMethod } from '../src/http/httpUtils';
import {
  SEEDED,
  apiRequest,
  createTempDatabaseDir,
  login,
  removeTempDatabaseDir,
  startServer,
  type ApiResponse,
  type LoggedInAccount,
  type RunningServer
} from './apiTestClient';

/**
 * The authorization sweep: every route this API registers, what it demands of a caller, and
 * where that demand is actually enforced.
 *
 * The point is not to re-test the router. It is that a route's access is a *decision* — is it
 * public? which permission does it need? may an account still under review reach it? — and
 * decisions made by omission are invisible. So each route's access is declared below, the
 * declaration is diffed against the live route table in both directions (an undeclared route
 * fails, and a stale declaration fails), and then the running API is asked to prove it: a 401
 * exactly where a token is required, a 403 naming the permission for a role that lacks it, and
 * the review gate answered the way the declaration says.
 *
 * Adding a route therefore fails this file until someone writes down who may call it.
 */

/**
 * Two authenticated routes carry no route-level permission, for a reason each records here.
 * The set is an allow-list rather than a pattern: a new route needs an entry, and only a
 * deliberate edit can add one.
 */
const PERMISSION_EXEMPTIONS: Record<string, string> = {
  'GET /api/v1/auth/me':
    'A caller reads its own account and its own review status, so there is nothing to grant: the permission would have to be one every role holds, and an account awaiting review must be able to reach it.',
  'GET /api/v1/orders/:orderId':
    "Whether an order is visible depends on the row — its customer, its merchant's owner, or a role with order:read:all — so the handler decides and answers 403. A route-level permission could only name one of those and would shut the others out.",
  'GET /api/v1/notifications':
    'Every account holder has notices of its own, so the permission would have to be one every role holds — and an account awaiting review holds none, yet still has warnings it must be able to read. What confines a caller to its own list is the token owner in the query, not a grant.',
  'POST /api/v1/notifications/read':
    'The same data as the list, acknowledged instead of read: the ids are narrowed inside the token owner’s own rows, so it needs the same absence of a permission for the same reason.',
  'GET /api/v1/auth/sessions':
    'A caller lists its own sessions. The permission would have to be one every role holds — and an account awaiting review holds none, yet may be signed in on a phone it no longer trusts. What confines the list to the caller is the token owner in the query, not a grant.',
  'POST /api/v1/auth/sessions/revoke-all':
    'The same rows as the list, ended instead of read. Ending your own sessions is the one security action that must never depend on a grant somebody else controls, so it has no permission for the same reason as the list.',
  'DELETE /api/v1/auth/sessions/:sessionId':
    'One of those same rows, ended one at a time. The session named is narrowed to the caller’s own rows inside the statement, so what confines it is the token owner rather than a grant — and a device the owner no longer trusts has to be cut off whatever the review state of the account holding it.'
};

interface DeclaredRoute {
  method: RouteMethod;
  path: string;
  /**
   * `public` means no bearer access token is required. It does not mean anonymous: refresh
   * and logout are authenticated by a token in the body, and the OTP routes by a code sent
   * to the phone. What it rules out is the router demanding a header.
   */
  access: 'public' | 'authenticated';
  /** The permission the router enforces before the handler runs. */
  permission?: Permission;
  /** Whether an account awaiting review (or refused one) may reach the route. */
  allowUnapprovedAccount?: boolean;
  /**
   * True for the rare route that ends every session the calling account holds. Calling one
   * burns whichever token called it, and a shared sweep token would leave every later
   * expectation answered with 401 — a wrong answer that looks like a broken route. So the
   * sweep calls such a route with a disposable account's own fresh login, and signs the
   * pending fixture back in when that fixture was the caller.
   */
  endsCallerSessions?: boolean;
  /** Why the route has the access it has. Required, so no route is declared by habit. */
  reason: string;
}

const DECLARED: DeclaredRoute[] = [
  {
    method: 'GET',
    path: '/health',
    access: 'public',
    reason:
      'Readiness for the platform’s own monitoring; it reports whether the database answers and exposes no account data, and the rate limiter exempts it.'
  },
  {
    method: 'POST',
    path: '/api/v1/auth/otp/request',
    access: 'public',
    reason:
      'Starts a login for a number nobody has proved yet, so there is no token to present; the phone number is the credential, and the reply is identical for a known and an unknown number.'
  },
  {
    method: 'POST',
    path: '/api/v1/auth/otp/verify',
    access: 'public',
    reason:
      'Exchanges the code sent to the phone for a session; the code is the credential, and it is deliberately usable by a number with no account so registration can follow.'
  },
  {
    method: 'POST',
    path: '/api/v1/auth/register',
    access: 'public',
    reason:
      'An account cannot present an access token before it exists; what authorises it is a verified code for the phone, which is consumed here.'
  },
  {
    method: 'POST',
    path: '/api/v1/auth/refresh',
    access: 'public',
    reason:
      'The refresh token in the body is the credential — an expired access token is precisely what a caller holding nothing else cannot present.'
  },
  {
    method: 'POST',
    path: '/api/v1/auth/logout',
    access: 'public',
    reason:
      'Revokes the session the body’s refresh token names; requiring a live access token would leave a caller who has only a refresh token unable to sign out.'
  },
  {
    method: 'GET',
    path: '/api/v1/auth/me',
    access: 'authenticated',
    allowUnapprovedAccount: true,
    reason:
      'The caller’s own record and review status, so it needs a token but no permission — and an account still awaiting review must be able to watch its own status.'
  },
  {
    method: 'GET',
    path: '/api/v1/auth/sessions',
    access: 'authenticated',
    allowUnapprovedAccount: true,
    reason:
      'The caller’s own live sessions, read from the token owner’s rows: the token digest is not among the columns served, and the list is confined by the user id in the query rather than by a grant.'
  },
  {
    method: 'POST',
    path: '/api/v1/auth/sessions/revoke-all',
    access: 'authenticated',
    allowUnapprovedAccount: true,
    endsCallerSessions: true,
    reason:
      'Ends every session the caller holds, that one included, so the account can cut off a device it no longer trusts without an administrator. No permission, because every role — including one awaiting review — has its own sessions to end.'
  },
  {
    method: 'DELETE',
    path: '/api/v1/auth/sessions/:sessionId',
    access: 'authenticated',
    allowUnapprovedAccount: true,
    // The id it names may be the caller’s own, so the sweep calls it with an account that
    // exists for that one call. The sweep’s fixture id is not a live session of that account
    // (or of any other), so the route answers 404 — the entitlement this proves is that the
    // token reached the handler at all, which is what an authorization refusal would prevent.
    endsCallerSessions: true,
    reason:
      'Ends one of the caller’s own sessions, named by its id, so the client can put down the phone it no longer trusts without ending the session it is holding. No permission: the id is scoped to the token owner in the statement itself, and an account awaiting review must be able to cut off its own handset before anybody has reviewed it.'
  },
  {
    method: 'GET',
    path: '/api/v1/notifications',
    access: 'authenticated',
    allowUnapprovedAccount: true,
    reason:
      'The caller’s own notice list — the second channel a security warning is delivered on, so a warning still lands when the SMS could not be sent. Every query is scoped by the token owner, and an account awaiting review needs its own warnings as much as anybody.'
  },
  {
    method: 'POST',
    path: '/api/v1/notifications/read',
    access: 'authenticated',
    allowUnapprovedAccount: true,
    reason:
      'Acknowledges the caller’s own notices, with the ids narrowed inside the token owner’s rows so another account’s id marks nothing.'
  },
  {
    method: 'GET',
    path: '/api/v1/addresses',
    access: 'authenticated',
    permission: 'address:manage:own',
    reason: 'Lists the signed-in customer’s own saved addresses; every query is scoped by the token owner.'
  },
  {
    method: 'POST',
    path: '/api/v1/addresses',
    access: 'authenticated',
    permission: 'address:manage:own',
    reason: 'Saves a new address for the token owner; the address is never created for anybody else.'
  },
  {
    method: 'GET',
    path: '/api/v1/addresses/:addressId',
    access: 'authenticated',
    permission: 'address:manage:own',
    reason: 'Reads one address, which must belong to the caller; another customer’s row is reported as not found, and so is one the caller has taken off their own list, which is no longer reachable by id even though the orders delivered there still name it.'
  },
  {
    method: 'PATCH',
    path: '/api/v1/addresses/:addressId',
    access: 'authenticated',
    permission: 'address:manage:own',
    reason: 'Edits the caller’s own address, with ownership in the update statement itself.'
  },
  {
    method: 'DELETE',
    path: '/api/v1/addresses/:addressId',
    access: 'authenticated',
    permission: 'address:manage:own',
    reason: 'Removes the caller’s own address. One that an order was delivered to cannot be deleted — the order names it, and its history has to keep resolving — so the row is detached instead: gone from every listing and from its id, kept only as what those orders say they were sent to.'
  },
  {
    method: 'GET',
    path: '/api/v1/admin/registrations',
    access: 'authenticated',
    permission: 'registration:read',
    reason: 'The review queue carries applicants’ contact details and onboarding answers, so it is administrator work.'
  },
  {
    method: 'POST',
    path: '/api/v1/admin/registrations/:userId/approve',
    access: 'authenticated',
    permission: 'registration:review',
    reason: 'Approving decides whether an account becomes usable, and creates the merchant or rider profile that dispatch depends on.'
  },
  {
    method: 'POST',
    path: '/api/v1/admin/registrations/:userId/reject',
    access: 'authenticated',
    permission: 'registration:review',
    reason: 'Rejecting closes an account and records a reason the applicant is shown.'
  },
  {
    method: 'GET',
    path: '/api/v1/admin/phone-logins',
    access: 'authenticated',
    permission: 'otp:read',
    reason:
      'The recent phone-login activity for one number at a time: which numbers asked for a login code, how many wrong guesses they made and whether the live code was retired. No user table, no login-entity jump: the bound is the number the caller holds, and the database supplies the outcome.'
  },
  {
    method: 'GET',
    path: '/api/v1/admin/phone-logins',
    access: 'authenticated',
    permission: 'otp:read',
    reason:
      'The recent phone-login activity for one number at a time. See /api/v1/admin/phone-logins.'
  },
  {
    method: 'GET',
    path: '/api/v1/admin/otp-deliveries',
    access: 'authenticated',
    permission: 'otp:read',
    reason: 'The SMS attempt trail answers “did the code go out?” for a phone number, which is customer data and an operator’s view of the gateway.'
  },
  {
    method: 'POST',
    path: '/api/v1/admin/otp-challenges/reset',
    access: 'authenticated',
    permission: 'otp:manage',
    reason:
      'Clears the resend cooldown on a phone number, and can send one code to it — so it writes login state for a number that may belong to anybody, and it can text one. That is the help desk acting on an account it does not own, which is why it is an `otp:manage` rather than the `otp:read` the delivery trail uses: reading who was texted and changing when they can be texted again are different powers, and only administrators hold this one. Every call is written to the audit trail.'
  },
  {
    method: 'POST',
    path: '/api/v1/admin/users/:userId/suspend',
    access: 'authenticated',
    permission: 'system:manage',
    reason:
      'Ends an account’s access: it can no longer sign in and its live sessions are retired, so this is the platform closing an account rather than reviewing one — `system:manage` is the grant that says so, and it is deliberately not the registration-review grant an admin uses to reject an application. An account cannot be suspended by itself, so the handler additionally refuses an administrator’s own account.'
  },
  {
    method: 'POST',
    path: '/api/v1/admin/users/:userId/reinstate',
    access: 'authenticated',
    permission: 'system:manage',
    reason:
      'The inverse of suspension, and the reason suspension is not a one-way door: the same grant, the same refusal of an administrator’s own account, and the only way the warning a suspended owner could not sign in to read becomes readable.'
  },
  {
    method: 'GET',
    path: '/api/v1/admin/security-notices',
    access: 'authenticated',
    permission: 'audit:read',
    reason:
      'Security notices with their delivery outcomes, read across every account: it carries the incidents themselves, who they belong to and whether they were ever reached, so it is an audit view of the whole platform rather than of the caller’s own records. Read-only by construction — the route only ever reads, and the notices it lists are written by the authentication path, never by an operator.'
  },
  {
    method: 'GET',
    path: '/api/v1/drivers/me/duty',
    access: 'authenticated',
    permission: 'rider:duty:own',
    reason:
      'The caller’s own duty state — whether they are on the roster and can be given work. It is about the caller and nobody else, which is what the :own scope says; the handler answers 404 rather than somebody else’s state when the account has no rider profile.'
  },
  {
    method: 'PATCH',
    path: '/api/v1/drivers/me/duty',
    access: 'authenticated',
    permission: 'rider:duty:own',
    reason:
      'Puts the caller on or off the roster. Going on duty is what makes a rider dispatchable and going off it is what stops work arriving, so the grant is the rider’s own and cannot touch anybody else’s state; ON_DELIVERY is refused here because dispatch owns it while an order is in the rider’s hands.'
  },
  {
    method: 'GET',
    path: '/api/v1/drivers/roster',
    access: 'authenticated',
    permission: 'rider:read:all',
    reason:
      'The roster across every rider, with their names and phone numbers, so dispatch has somebody to hand work to — a platform-wide operational view rather than a rider’s own records, hence the :all scope that only administrators hold.'
  },
  {
    method: 'GET',
    path: '/api/v1/drivers/me/orders',
    access: 'authenticated',
    permission: 'order:read:driver',
    reason:
      'The deliveries assigned to the caller and to nobody else: the driver id comes from the access token and is the `WHERE` of the only query, so there is no id in the path to guess and nothing to authorise beyond being the rider the order was assigned to. The permission is the rider grant, so a customer or a merchant is refused before the handler runs; an administrator holds it as well and reads an empty list, having no deliveries of their own — which is what makes this a question about the caller rather than about the fleet.'
  },
  {
    method: 'POST',
    path: '/api/v1/merchant/profile',
    access: 'authenticated',
    permission: 'merchant:manage:own',
    reason:
      'Opens the caller’s own store, which is the one thing the read and the edit cannot do for an approved merchant whose `merchants` row is missing: the store is created for the token owner, so `ownerUserId` never comes from the body and there is no id to point at somebody else’s shop, and the review gate refuses an account still under review before the handler runs — which is what makes this the route an *approved* merchant uses. Administrators hold the grant too and would be opening a shop for themselves, which is why nothing in the platform sends them here.'
  },
  {
    method: 'GET',
    path: '/api/v1/merchant/profile',
    access: 'authenticated',
    permission: 'merchant:manage:own',
    reason:
      'The caller’s own store, found by the account that owns it rather than by an id in the path — so there is nothing to guess and nothing to authorise beyond being the owner. The grant is the :own scope for that reason; the handler answers 404 when an approved merchant has no store, and `POST` on this same path is how that merchant opens one.'
  },
  {
    method: 'PATCH',
    path: '/api/v1/merchant/profile',
    access: 'authenticated',
    permission: 'merchant:manage:own',
    reason:
      'Edits the caller’s own shopfront — name, description, category, opening state and where riders collect from. Every statement carries the owner’s id, and the licensing, contact and rating fields are refused by name, so a merchant cannot change the terms it was approved on.'
  },
  {
    method: 'GET',
    path: '/api/v1/merchant/catalog',
    access: 'authenticated',
    permission: 'catalog:manage:merchant',
    reason:
      'The caller’s own menu, including the items that are not on sale today. The store is found by the account that owns it, so the list a merchant sees is its own by construction and `catalog:manage:merchant` is the grant that makes the shelf theirs.'
  },
  {
    method: 'POST',
    path: '/api/v1/merchant/catalog',
    access: 'authenticated',
    permission: 'catalog:manage:merchant',
    reason:
      'Adds an item to the caller’s own catalogue — the step that turns a newly approved empty store into one that can take an order. The store comes from the token, and the platform owns the id and the SKU, so nothing in the body can point at another store.'
  },
  {
    method: 'GET',
    path: '/api/v1/merchant/catalog/:itemId',
    access: 'authenticated',
    permission: 'catalog:manage:merchant',
    reason:
      'One of the caller’s own items. An item belonging to another store is answered 404 rather than 403, so an item id cannot be used to discover what somebody else sells.'
  },
  {
    method: 'PATCH',
    path: '/api/v1/merchant/catalog/:itemId',
    access: 'authenticated',
    permission: 'catalog:manage:merchant',
    reason:
      'Edits the caller’s own item — what it says, what it costs, and whether it is on the menu today. Every statement carries the owner’s store id, and the id, SKU and timestamps are refused by name.'
  },
  {
    method: 'DELETE',
    path: '/api/v1/merchant/catalog/:itemId',
    access: 'authenticated',
    permission: 'catalog:manage:merchant',
    reason:
      'Removes the caller’s own item. An item a customer has already ordered is refused with 409 rather than deleted, because the order line keeps pointing at what was bought; the merchant’s alternative is marking it unavailable.'
  },
  {
    method: 'GET',
    path: '/api/v1/merchants',
    access: 'public',
    reason: 'The storefront directory a visitor browses before signing in; names, categories and ratings, never a person — no licence numbers, owner ids or phones.'
  },
  {
    method: 'GET',
    path: '/api/v1/merchants/:merchantId/menu',
    access: 'public',
    reason: 'A storefront menu is what a visitor browses before signing in; it lists prices and descriptions, never a person.'
  },
  {
    method: 'POST',
    path: '/api/v1/orders/quote',
    access: 'authenticated',
    permission: 'order:create',
    reason: 'A quote prices the caller’s own basket against the caller’s own address, so it is the first half of placing an order rather than a read.'
  },
  {
    method: 'POST',
    path: '/api/v1/orders',
    access: 'authenticated',
    permission: 'order:create',
    reason: 'Placing an order spends money and creates a row a merchant and a rider act on.'
  },
  {
    method: 'GET',
    path: '/api/v1/orders/:orderId',
    access: 'authenticated',
    reason: 'Readable by the order’s customer, its merchant’s owner, or a role with order:read:all — the handler decides. Where the order went is narrower than the order: the address it was delivered to is reported to that customer and to a role holding pii:read:full, so a merchant reading its own sale can see the order without seeing the customer’s door.'
  },
  {
    method: 'POST',
    path: '/api/v1/orders/:orderId/payments',
    access: 'authenticated',
    permission: 'order:create',
    reason:
      'Records money taken for the customer’s own order. Paying is the second half of placing an order, and the amount comes from the order rather than the body, so it needs the same permission as placing one.'
  },
  {
    method: 'POST',
    path: '/api/v1/orders/:orderId/cancel',
    access: 'authenticated',
    permission: 'order:cancel:own',
    reason:
      'The customer ending their own order, with the policy-computed refund written in the same transaction. Cancelling is the refund path inside the window, hence order:cancel:own; the handler additionally requires ownership, so an administrator holding the permission cannot cancel a customer’s order here.'
  },
  {
    method: 'POST',
    path: '/api/v1/orders/:orderId/refunds',
    access: 'authenticated',
    permission: 'order:manage:all',
    reason:
      'Sending money back after the cancellation window has closed, or after delivery — a decision an administrator makes, which is why no customer token reaches it.'
  },
  {
    // Registered twice, once per method, on purpose: some gateways can only call back with a
    // GET and some only with a POST, and the report is the same report either way.
    method: 'GET',
    path: '/api/v1/webhooks/sms-delivery-reports',
    access: 'public',
    reason:
      'Called by the SMS gateway, which is a machine with no account and no way to sign in: what authorises a report is the shared secret in SMS_RECEIPT_WEBHOOK_SECRET, checked in constant time inside the handler. Public in the router’s sense — no bearer token — and deliberately not open: with no secret configured the route refuses every report rather than recording one it cannot attribute.'
  },
  {
    method: 'POST',
    path: '/api/v1/webhooks/sms-delivery-reports',
    access: 'public',
    reason:
      'The same endpoint as the GET above, for a gateway that posts its delivery reports instead — as JSON or as a form-encoded body, which is the shape these providers send in. The same secret, the same handler, and the same absence of an account: there is nobody to hold a permission, so the whole access decision is the secret check in the handler.'
  }
];

/** A real id for each placeholder, so a swept request reaches the gate rather than the router. */
const PATH_PARAMS: Record<string, string> = {
  // Deliberately ids that exist for nobody: the sweep is asking about authorization, and a
  // request that cannot mutate seeded rows is one less thing a failing sweep could disturb.
  ':addressId': 'addr_not_a_real_address',
  ':userId': 'usr_not_a_real_user',
  ':orderId': 'ord_not_a_real_order',
  ':merchantId': SEEDED.merchantId,
  ':itemId': 'cat_not_a_real_item',
  // A session id that names nothing live: the route answers 404 and ends no session, which is
  // what makes it safe to sweep with the same tokens the rest of the run depends on.
  ':sessionId': 'sess_not_a_real_session'
};

/** Roles a token is available for, least privileged first: the sweep prefers the tightest one. */
const ROLES: readonly UserRole[] = ['CUSTOMER', 'MERCHANT', 'DRIVER', 'ADMIN'];

const GATE_MESSAGE = /Bearer access token/;

let tempDir: string;
let app: RunningServer;
/** The routes the running server registered, read from the same builder it uses. */
let registered: Route[];
let tokens: Record<UserRole, string>;
let pending: LoggedInAccount;

/** Fixture accounts the sweep owns, created directly so no seeded account is disturbed. */
const PENDING_PHONE = '+8801799000001';

/**
 * Sweeping `POST /auth/sessions/revoke-all` with any token the rest of the sweep holds would
 * sign that account out for the remainder of the run, and every later expectation would be
 * answered with 401. So each call of such a route is made by an account created for it and
 * then abandoned, sessions and all. A fresh phone per call also keeps the OTP resend cooldown
 * out of it: a number used once has nothing to wait for.
 */
let disposableAccounts = 0;

async function insertFixtureUser(
  id: string,
  phone: string,
  role: UserRole,
  approvalStatus: 'APPROVED' | 'PENDING'
): Promise<void> {
  const now = new Date().toISOString();
  await app.client.query(
    `INSERT INTO users (id, email, phone, fullName, role, isActive, approvalStatus, approvalReason, registrationDetails, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      `${id}@fixture.coxsbazar.delivery`,
      phone,
      `Fixture ${role}`,
      role,
      1,
      approvalStatus,
      null,
      null,
      now,
      now
    ]
  );
}

function key(route: { method: string; path: string }): string {
  return `${route.method} ${route.path}`;
}

/** One declaration per route: either its line in the table, or a placeholder for an undeclared one. */
function declaredFor(route: Route): DeclaredRoute | undefined {
  return DECLARED.find((entry) => entry.method === route.method && entry.path === route.path);
}

function concretePath(path: string): string {
  return path.replace(/:[A-Za-z]+/g, (param) => PATH_PARAMS[param] ?? param);
}

/** The token whose role holds `permission`, tightest role first; null when no role does. */
function admittingToken(permission?: Permission): string | null {
  const role = ROLES.find((candidate) => (permission ? hasPermission(candidate, permission) : candidate === 'CUSTOMER'));
  return role ? tokens[role] : null;
}

/** The role that lacks `permission`, tightest first; null when every role holds it. */
function denyingRole(permission: Permission): UserRole | null {
  return ROLES.find((candidate) => !hasPermission(candidate, permission)) ?? null;
}

function call(route: { method: RouteMethod; path: string }, token?: string) {
  return apiRequest(app, route.method, concretePath(route.path), token ? { token } : {});
}

/** One call of a route that ends the caller's own sessions, made by an account that exists for nothing else. */
async function callDisposably(route: { method: RouteMethod; path: string }): Promise<ApiResponse> {
  disposableAccounts += 1;
  const phone = `+8801798${String(disposableAccounts).padStart(6, '0')}`;
  await insertFixtureUser(`usr_fixture_revoker_${disposableAccounts}`, phone, 'CUSTOMER', 'APPROVED');
  const account = await login(app, phone);
  return call(route, account.accessToken);
}

/**
 * The same, for an account that is still awaiting review: the token this call ends belongs to
 * an account nobody approved, which is the state the review gate exists for.
 */
async function callDisposablyAsPending(route: { method: RouteMethod; path: string }): Promise<ApiResponse> {
  disposableAccounts += 1;
  const phone = `+8801797${String(disposableAccounts).padStart(6, '0')}`;
  await insertFixtureUser(
    `usr_fixture_pending_sweep_${disposableAccounts}`,
    phone,
    'MERCHANT',
    'PENDING'
  );
  const account = await login(app, phone);
  return call(route, account.accessToken);
}

/** True when the answer is the router's own "no bearer token" rejection, not a handler's. */
function demandedBearerToken(response: { status: number; body: any }): boolean {
  return response.status === 401 && GATE_MESSAGE.test(String(response.body?.error?.message ?? ''));
}

beforeAll(async () => {
  tempDir = createTempDatabaseDir();
  app = await startServer({
    port: 0,
    host: '127.0.0.1',
    databaseFile: `${tempDir}/route-authorization.sqlite`,
    // The sweep makes a request per route per rule; the limiter must not be what answers.
    rateLimit: { max: 5000, windowMs: 60000 }
  });

  // The same builder the server uses, so this list cannot drift from what is served.
  const client = app.client;
  registered = buildRoutes({
    client,
    userRepo: new UserRepository(client),
    addressRepo: new AddressRepository(client),
    merchantRepo: new MerchantRepository(client),
    catalogRepo: new CatalogRepository(client),
    orderRepo: new OrderRepository(client),
    auditRepo: new AuditLogRepository(client),
    notificationRepo: new NotificationRepository(client),
    sessionService: new SessionService(client),
    accountStatus: new AccountStatusService(client),
    registrationService: new RegistrationService(client),
    otpService: new PhoneAuthService({ store: new DatabaseOtpStore(client) }),
    otpDeliveryRepo: new OtpDeliveryRepository(client),
    otpDeliveryLog: new OtpDeliveryLog(new OtpDeliveryRepository(client)),
    // The new endpoint reads challenge rows, not users, so no login fixture is needed for it.
    _unusedLoginActivityClient: client,
    retention: new ClientAddressRetention({ repo: new RetentionRepository(client) })
  });

  const admin = await login(app, SEEDED.admin.phone);
  const customer = await login(app, SEEDED.customer.phone);
  const merchant = await login(app, SEEDED.merchant.phone);
  const driver = await login(app, SEEDED.driver.phone);
  tokens = {
    ADMIN: admin.accessToken,
    CUSTOMER: customer.accessToken,
    MERCHANT: merchant.accessToken,
    DRIVER: driver.accessToken
  };

  // An account that passed its OTP check but is still waiting on review: the state the
  // review gate exists for, and one a normal flow only reaches through an admin decision.
  await insertFixtureUser('usr_fixture_pending', PENDING_PHONE, 'MERCHANT', 'PENDING');
  pending = await login(app, PENDING_PHONE);

});

afterAll(async () => {
  await app?.close();
  removeTempDatabaseDir(tempDir);
});

describe('every route the server registers is declared here', () => {
  it('has no route without a declaration and no declaration without a route', () => {
    const registeredKeys = registered.map(key).sort();
    const declaredKeys = DECLARED.map(key).sort();

    const undeclared = registeredKeys.filter((route) => !declaredKeys.includes(route));
    expect(
      undeclared,
      'These routes are served but not declared. Add each to DECLARED with its access, permission and review-gate status.'
    ).toEqual([]);

    const stale = declaredKeys.filter((route) => !registeredKeys.includes(route));
    expect(
      stale,
      'These routes are declared but no longer registered. Remove them, or they are hiding a route that moved.'
    ).toEqual([]);
  });

  it('substitutes a real id for every path parameter it sweeps', () => {
    const params = new Set<string>();
    for (const entry of DECLARED) {
      for (const match of entry.path.matchAll(/:[A-Za-z]+/g)) params.add(match[0]);
    }

    const unmapped = [...params].filter((param) => PATH_PARAMS[param] === undefined);
    expect(unmapped, 'A new path parameter needs an id in PATH_PARAMS before it can be swept.').toEqual([]);
  });

  it('registers each method and path exactly once', () => {
    const seen = new Map<string, number>();
    for (const route of registered) {
      seen.set(key(route), (seen.get(key(route)) ?? 0) + 1);
    }

    const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([route]) => route);
    expect(duplicated, 'A duplicate registration means one of the two handlers can never run.').toEqual([]);
  });

  it('keeps the route’s own flags in step with the declaration', () => {
    const mismatches: string[] = [];

    for (const route of registered) {
      const declaration = declaredFor(route);
      if (!declaration) continue;

      const wantsAuth = route.requiresAuth === true;
      if (wantsAuth !== (declaration.access === 'authenticated')) {
        mismatches.push(
          `${key(route)}: declared ${declaration.access} but requiresAuth is ${String(route.requiresAuth)}`
        );
      }
      if (route.permission !== declaration.permission) {
        mismatches.push(
          `${key(route)}: declared permission ${declaration.permission ?? 'none'} but the route enforces ${route.permission ?? 'none'}`
        );
      }
      if ((route.allowUnapprovedAccount === true) !== (declaration.allowUnapprovedAccount === true)) {
        mismatches.push(
          `${key(route)}: declared allowUnapprovedAccount ${String(declaration.allowUnapprovedAccount === true)} but the route has ${String(route.allowUnapprovedAccount === true)}`
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('gives every authenticated route a permission or a recorded exemption', () => {
    const unguarded: string[] = [];

    for (const entry of DECLARED) {
      if (entry.access !== 'authenticated') {
        if (entry.permission !== undefined) {
          unguarded.push(`${key(entry)}: a public route cannot enforce a permission`);
        }
        continue;
      }
      if (entry.permission !== undefined) continue;
      if (PERMISSION_EXEMPTIONS[key(entry)] === undefined) {
        unguarded.push(
          `${key(entry)}: authenticated without a permission. Name the permission it needs, or add an exemption with the reason it cannot have one.`
        );
      }
    }

    const unusedExemption = Object.keys(PERMISSION_EXEMPTIONS).filter(
      (route) => !DECLARED.some((entry) => key(entry) === route)
    );
    for (const route of unusedExemption) {
      unguarded.push(`${route}: exemption recorded for a route that is not declared`);
    }

    expect(unguarded).toEqual([]);
  });

  it('grants every declared permission to at least one role', () => {
    // A permission nobody holds is a route nobody can use: the failure that looks like a
    // 403 for a real administrator and like nothing at all in review.
    const unreachable = DECLARED.filter((entry) => entry.permission !== undefined)
      .filter((entry) => !ROLES.some((role) => hasPermission(role, entry.permission as Permission)))
      .map((entry) => `${key(entry)} needs '${entry.permission}', which no role holds`);

    expect(unreachable).toEqual([]);
  });
});

describe('the running API enforces what the declaration says', () => {
  it('answers a public route without demanding a bearer token', async () => {
    const refused: string[] = [];

    for (const entry of DECLARED.filter((route) => route.access === 'public')) {
      const response = await call(entry);
      if (demandedBearerToken(response)) {
        refused.push(`${key(entry)} answered 401 for a missing bearer token but is declared public`);
      }
      // A public route still answers something: silence would hide a route that is only
      // public because it matches nothing.
      if (response.status < 200 || response.status >= 500) {
        refused.push(`${key(entry)} answered ${response.status} to a public request`);
      }
    }

    expect(refused).toEqual([]);
  });

  it('reaches the documented answers on the public routes a caller actually uses', async () => {
    const health = await call({ method: 'GET', path: '/health' });
    expect(health.status).toBe(200);

    const menu = await call({ method: 'GET', path: '/api/v1/merchants/:merchantId/menu' });
    expect(menu.status).toBe(200);
    expect(Array.isArray(menu.body.items)).toBe(true);

    const otp = await apiRequest(app, 'POST', '/api/v1/auth/otp/request', {
      body: { phone: '+8801799000009' }
    });
    expect(otp.status).toBe(200);
    expect(typeof otp.body.devOtp).toBe('string');
  });

  it('answers an authenticated route with 401 exactly when no token is presented', async () => {
    const wrong: string[] = [];

    for (const entry of DECLARED.filter((route) => route.access === 'authenticated')) {
      const response = await call(entry);
      if (!demandedBearerToken(response)) {
        wrong.push(`${key(entry)} answered ${response.status} to a request with no token, not the 401 gate`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it('admits a token whose role holds the declared permission', async () => {
    const blocked: string[] = [];

    for (const entry of DECLARED.filter((route) => route.access === 'authenticated')) {
      const token = admittingToken(    entry.permission);
      if (token === null && entry.endsCallerSessions !== true) {
        blocked.push(`${key(entry)}: no role holds '${entry.permission}', so no token could reach it`);
        continue;
      }

      const response =
        entry.endsCallerSessions === true ? await callDisposably(entry) : await call(entry, token!);
      // The handler may refuse the request for its own reasons (404 for an id that exists
      // for nobody, 400 for an empty body). What must not appear here is an authorization
      // refusal: the token is entitled to reach the handler.
      if (response.status === 401 || response.status === 403) {
        blocked.push(
          `${key(entry)} refused an entitled token with ${response.status}: ${JSON.stringify(response.body?.error?.message ?? response.body)}`
        );
      }
    }

    expect(blocked).toEqual([]);
  });

  it('refuses a token whose role lacks the declared permission, naming it', async () => {
    const admitted: string[] = [];

    for (const entry of DECLARED.filter((route) => route.permission !== undefined)) {
      const permission = entry.permission as Permission;
      const denied = denyingRole(permission);
      if (denied === null) {
        admitted.push(`${key(entry)}: every role holds '${permission}', so a refusal cannot be observed`);
        continue;
      }

      const response = await call(entry, tokens[denied]);
      if (response.status !== 403) {
        admitted.push(`${key(entry)} answered ${response.status} for a ${denied} token, not 403`);
        continue;
      }
      if (response.body?.error?.code !== 'FORBIDDEN') {
        admitted.push(`${key(entry)} answered 403 with code ${String(response.body?.error?.code)}, not FORBIDDEN`);
      }
      // The message must name the permission actually enforced: a route that enforces a
      // weaker one than it declares is the mistake this assertion exists to catch.
      if (!String(response.body?.error?.message ?? '').includes(permission)) {
        admitted.push(
          `${key(entry)} refused a ${denied} without naming '${permission}': ${JSON.stringify(response.body?.error?.message ?? null)}`
        );
      }
    }

    expect(admitted).toEqual([]);
  });

  it('applies the review gate exactly where the declaration allows an unapproved account', async () => {
    const wrong: string[] = [];

    // A route that ends the caller's sessions takes the token it was called with with it, so
    // each of those is given a pending account of its own rather than the shared fixture: the
    // alternative — sweeping them last — only works while there is exactly one such route, and
    // a second one would answer 401 from the session check instead of the gate this test asks
    // about. Nothing here depends on the order the declarations happen to be written in.
    for (const entry of DECLARED.filter((route) => route.access === 'authenticated')) {
      const response =
        entry.endsCallerSessions === true
          ? await callDisposablyAsPending(entry)
          : await call(entry, pending.accessToken);
      const gated = response.status === 403 && response.body?.error?.code === 'ACCOUNT_NOT_APPROVED';

      if (entry.allowUnapprovedAccount === true) {
        if (gated) {
          wrong.push(`${key(entry)} allows accounts awaiting review but answered ACCOUNT_NOT_APPROVED`);
        } else if (response.status === 401 || response.status === 403) {
          wrong.push(
            `${key(entry)} admits accounts awaiting review but answered ${response.status}: ${JSON.stringify(response.body?.error?.message ?? null)}`
          );
        }
        continue;
      }

      if (!gated) {
        wrong.push(
          `${key(entry)} answered ${response.status} to an account awaiting review; permission-bearing routes must answer ACCOUNT_NOT_APPROVED`
        );
      }
    }

    expect(wrong).toEqual([]);
  });
});
