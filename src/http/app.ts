import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import {
  AppError,
  NotFoundError,
  RateLimitError,
  UnauthorizedError,
  serializeError
} from '../core/errors';
import { logger } from '../core/logger';
import { AccountStatusService } from '../auth/accountStatusService';
import { ClientAddressRetention } from '../auth/clientAddressRetention';
import { PhoneAuthService } from '../auth/phoneAuth';
import { OtpDeliveryLog } from '../auth/otpDeliveryLog';
import type { OtpDispatchResult } from '../auth/otpDelivery';
import { DatabaseOtpStore } from '../auth/otpStore';
import { assertPermission } from '../auth/rbac';
import { RegistrationService } from '../auth/registrationService';
import { RiderDutyService } from '../auth/riderDutyService';
import { SecurityNoticeService, type SecurityNoticeSender } from '../auth/securityNotices';
import { SessionService } from '../auth/sessionService';
import { verifyToken, type TokenPayload } from '../auth/tokens';
import type { DatabaseClient } from '../db/client';
import {
  AddressRepository,
  AuditLogRepository,
  CatalogRepository,
  MerchantRepository,
  NotificationRepository,
  OrderRepository,
  OtpDeliveryRepository,
  PaymentRepository,
  RateLimitRepository,
  RefundRepository,
  RetentionRepository,
  UserRepository
} from '../db/repositories';
import { DatabaseRateLimiter } from './rateLimiter';
import {
  clientAddressFields,
  isLocalOrPrivateAddress,
  normalizeAddress,
  parseForwardedHeaderMode,
  parseTrustedProxies,
  resolveClientAddress
} from './clientIp';
import { createAddressRoutes } from './routes/addressRoutes';
import { createAdminRoutes } from './routes/adminRoutes';
import { createAuthRoutes } from './routes/authRoutes';
import { createCatalogRoutes } from './routes/catalogRoutes';
import { createDriverRoutes } from './routes/driverRoutes';
import { createMerchantRoutes } from './routes/merchantRoutes';
import { createNotificationRoutes } from './routes/notificationRoutes';
import { createOrderRoutes } from './routes/orderRoutes';
import { createPaymentRoutes } from './routes/paymentRoutes';
import { createWebhookRoutes } from './routes/webhookRoutes';
import {
  matchPath,
  methodHasBody,
  readJsonBody,
  type AuthContext,
  type RequestContext,
  type Route
} from './httpUtils';

const BEARER_PREFIX = 'Bearer ';

export interface AppOptions {
  /** Overrides the configured RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS (used by tests). */
  rateLimit?: { max: number; windowMs: number };
  /**
   * Overrides the configured TRUST_PROXY: which peers may be believed about the caller's
   * address, and therefore whether X-Forwarded-For is read at all. See src/http/clientIp.ts.
   */
  trustProxy?: string;
  /** Overrides the configured PII_RETENTION_DAYS (used by tests). */
  retentionDays?: number;
  /**
   * Overrides the configured TRUSTED_FORWARD_HEADER: which forwarded header the proxies
   * maintain, and therefore whether RFC 7239's `Forwarded` is read at all.
   */
  trustedForwardHeader?: string;
  /** Injectable for tests; defaults to the configured SMS gateway. */
  otpDispatch?: (phone: string, otp: string, expiresInSeconds: number) => Promise<OtpDispatchResult>;
  /**
   * The out-of-band channel for security notices. Injectable for tests; defaults to an SMS
   * through the configured provider. The durable half is always the account's own list.
   */
  noticeSender?: SecurityNoticeSender;
  /**
   * Overrides the configured SMS_RECEIPT_WEBHOOK_SECRET: the shared secret the gateway
   * presents when it reports a delivery. Supplied here rather than read from the environment
   * inside the route so that a test can exercise a configured deployment and an unconfigured
   * one in the same process, which the module-level `env` would not allow.
   */
  receiptWebhookSecret?: string;
}

/** Everything the route table needs, supplied by the composition root in `createApp`. */
export interface AppRouteDeps {
  client: DatabaseClient;
  userRepo: UserRepository;
  addressRepo: AddressRepository;
  merchantRepo: MerchantRepository;
  catalogRepo: CatalogRepository;
  orderRepo: OrderRepository;
  auditRepo: AuditLogRepository;
  /** The account holder's own notice list; see src/auth/securityNotices.ts. */
  notificationRepo: NotificationRepository;
  sessionService: SessionService;
  /** Suspending and reinstating accounts; see src/auth/accountStatusService.ts. */
  accountStatus: AccountStatusService;
  /** Rider duty state and the roster dispatch works from. */
  riderDuty: RiderDutyService;
  registrationService: RegistrationService;
  otpService: PhoneAuthService;
  otpDeliveryRepo: OtpDeliveryRepository;
  otpDeliveryLog: OtpDeliveryLog;
  paymentRepo: PaymentRepository;
  refundRepo: RefundRepository;
  retention: ClientAddressRetention;
  /** Injectable for tests; defaults to the configured SMS gateway. */
  otpDispatch?: AppOptions['otpDispatch'];
  /** Overrides the configured delivery-report secret (see AppOptions). */
  receiptWebhookSecret?: string;
}

/**
 * Every route this API serves, assembled in one place.
 *
 * Exported so the authorization sweep (tests/routeAuthorization.test.ts) can enumerate the
 * exact set the running server registers. Each route's access — public or authenticated,
 * the permission required, and whether an account still awaiting review may reach it — is
 * declared there and checked against the live API, so a route added without that
 * declaration fails the suite instead of being served because nobody looked.
 *
 * Nothing else should call this: `createApp` is the only composition root.
 */
export function buildRoutes(deps: AppRouteDeps): Route[] {
  return [
    {
      method: 'GET',
      path: '/health',
      handler: async () => {
        const dbHealth = await deps.client.healthCheck();
        return {
          status: dbHealth.ok ? 200 : 503,
          body: {
            success: dbHealth.ok,
            status: dbHealth.ok ? 'ok' : 'degraded',
            database: { ok: dbHealth.ok, checkedAt: dbHealth.timestamp },
            uptimeSeconds: Math.round(process.uptime())
          }
        };
      }
    },
    ...createAuthRoutes({
      userRepo: deps.userRepo,
      sessionService: deps.sessionService,
      registrationService: deps.registrationService,
      otpService: deps.otpService,
      otpDeliveryLog: deps.otpDeliveryLog,
      retention: deps.retention,
      ...(deps.otpDispatch ? { dispatchOtp: deps.otpDispatch } : {})
    }),
    ...createAddressRoutes({
      client: deps.client,
      addressRepo: deps.addressRepo,
      orderRepo: deps.orderRepo
    }),
    ...createAdminRoutes({
      registrationService: deps.registrationService,
      otpDeliveryRepo: deps.otpDeliveryRepo,
      notificationRepo: deps.notificationRepo,
      accountStatus: deps.accountStatus,
      // The same service and trail the OTP routes use: the help desk clears the state a login
      // reads, and a code it forces is recorded where every other dispatch is.
      otpService: deps.otpService,
      auditRepo: deps.auditRepo,
      otpDeliveryLog: deps.otpDeliveryLog,
      ...(deps.otpDispatch ? { dispatchOtp: deps.otpDispatch } : {})
    }),
    ...createDriverRoutes({ riderDuty: deps.riderDuty, orderRepo: deps.orderRepo }),
    ...createMerchantRoutes({
      client: deps.client,
      merchantRepo: deps.merchantRepo,
      addressRepo: deps.addressRepo
    }),
    ...createCatalogRoutes({
      client: deps.client,
      merchantRepo: deps.merchantRepo,
      catalogRepo: deps.catalogRepo,
      orderRepo: deps.orderRepo
    }),
    ...createNotificationRoutes({ notificationRepo: deps.notificationRepo }),
    ...createOrderRoutes({
      client: deps.client,
      userRepo: deps.userRepo,
      addressRepo: deps.addressRepo,
      merchantRepo: deps.merchantRepo,
      catalogRepo: deps.catalogRepo,
      orderRepo: deps.orderRepo,
      auditRepo: deps.auditRepo
    }),
    ...createPaymentRoutes({
      client: deps.client,
      orderRepo: deps.orderRepo,
      paymentRepo: deps.paymentRepo,
      refundRepo: deps.refundRepo,
      auditRepo: deps.auditRepo
    }),
    // Where the gateway reports what happened to a message after the send — the other half of
    // the attempt trail the OTP routes write. Authenticated by a shared secret rather than by
    // an account, so its whole access decision is inside the handler.
    ...createWebhookRoutes({
      otpDeliveryRepo: deps.otpDeliveryRepo,
      ...(deps.receiptWebhookSecret === undefined ? {} : { secret: deps.receiptWebhookSecret })
    })
  ];
}

/**
 * Maximum request bodies are bounded in httpUtils; this limiter bounds request rates per
 * client address using the configured RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS, and counts
 * that budget in the database so it is shared by every process rather than repeated in
 * each one.
 */
export function createApp(
  client: DatabaseClient,
  options: AppOptions = {}
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const userRepo = new UserRepository(client);
  const addressRepo = new AddressRepository(client);
  const merchantRepo = new MerchantRepository(client);
  const catalogRepo = new CatalogRepository(client);
  const orderRepo = new OrderRepository(client);
  const auditRepo = new AuditLogRepository(client);
  const notificationRepo = new NotificationRepository(client);
  // One notice service for the whole process, so every event that warns an account holder
  // goes through the same durable-then-out-of-band path, and a test that substitutes the
  // sender substitutes it everywhere.
  const notices = new SecurityNoticeService(client, {
    ...(options.noticeSender ? { sender: options.noticeSender } : {})
  });
  const sessionService = new SessionService(client, { notices });
  const registrationService = new RegistrationService(client, { notices });
  const accountStatus = new AccountStatusService(client, { notices });
  // A rider's working state, which approval seeds and the rider then owns; see
  // src/auth/riderDutyService.ts.
  const riderDuty = new RiderDutyService(client);
  // Phone-login state is kept in the database so a code issued here can be verified by
  // another process, and so a restart does not lose a pending code or its cooldown.
  const otpService = new PhoneAuthService({ store: new DatabaseOtpStore(client) });
  // The SMS attempt trail: written for every OTP dispatch so an operator can see whether
  // a code actually left the building, and readable through the admin endpoint.
  const otpDeliveryRepo = new OtpDeliveryRepository(client);
  const otpDeliveryLog = new OtpDeliveryLog(otpDeliveryRepo);
  const paymentRepo = new PaymentRepository(client);
  const refundRepo = new RefundRepository(client);
  // Replaces the addresses on records whose retention window has closed, so the trail
  // stops identifying a person without losing the record that something happened.
  const retention = new ClientAddressRetention({
    repo: new RetentionRepository(client),
    ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays })
  });

  const rateLimit = options.rateLimit ?? { max: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW_MS };
  // Counted in the database rather than here, so every process that serves these clients
  // enforces one budget between them (see ./rateLimiter.ts). The key is a digest of the
  // client address, derived from the server secret so that it is the same key everywhere.
  const rateLimiter = new DatabaseRateLimiter({
    repo: new RateLimitRepository(client),
    max: rateLimit.max,
    windowMs: rateLimit.windowMs,
    secret: env.ENCRYPTION_KEY
  });

  // Who may be believed about the caller's address. Unset means "no proxy", and then the
  // socket address is used for both the rate-limit bucket and every audit row.
  const trustProxy = parseTrustedProxies(options.trustProxy ?? env.TRUST_PROXY);
  const forwardedHeader = parseForwardedHeaderMode(
    options.trustedForwardHeader ?? env.TRUSTED_FORWARD_HEADER
  );
  let warnedAboutIgnoredForwarding = false;
  let warnedAboutHiddenClient = false;
  let warnedAboutConflictingHeaders = false;

  const routes: Route[] = buildRoutes({
    client,
    userRepo,
    addressRepo,
    merchantRepo,
    catalogRepo,
    orderRepo,
    auditRepo,
    notificationRepo,
    sessionService,
    accountStatus,
    riderDuty,
    registrationService,
    otpService,
    otpDeliveryRepo,
    otpDeliveryLog,
    paymentRepo,
    refundRepo,
    retention,
    ...(options.otpDispatch ? { otpDispatch: options.otpDispatch } : {}),
    ...(options.receiptWebhookSecret === undefined
      ? {}
      : { receiptWebhookSecret: options.receiptWebhookSecret })
  });

  async function authenticateRequest(headers: IncomingMessage['headers']): Promise<AuthContext> {
    const rawHeader = headers.authorization;
    const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (!header || !header.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedError('Authorization header must be a Bearer access token');
    }

    const payload = verifyToken<TokenPayload>(header.slice(BEARER_PREFIX.length).trim(), 'access');

    // A signed token is not enough: it also names the session that minted it, and a
    // session retired by rotation, logout or a burned family retires its access tokens
    // with it. One primary-key lookup, so revocation is immediate rather than a 15-minute
    // tail, and the check lands here so no authenticated route can forget it.
    const sessionId = await sessionService.requireLiveSession(payload.sessionId);

    const user = await userRepo.findById(payload.userId);
    if (!user) {
      throw new UnauthorizedError('Access token does not match an account');
    }

    return { user, sessionId };
  }

  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const method = req.method ?? 'GET';
    const socketAddress = normalizeAddress(req.socket.remoteAddress);
    const forwardedFor = req.headers['x-forwarded-for'];
    const forwarded = req.headers.forwarded;
    const source = resolveClientAddress(
      { socketAddress, xForwardedFor: forwardedFor, forwarded, mode: forwardedHeader },
      trustProxy
    );
    const clientIp = source.address;

    // A trusted proxy that hides the client it forwarded for — an obfuscated identifier,
    // `unknown`, or an element that cannot be read — leaves every client of that proxy in
    // one rate-limit bucket, and no session row can name a person. That is a deployment
    // decision, but a silent one, so it is reported once per process.
    if (source.hidden && !warnedAboutHiddenClient) {
      warnedAboutHiddenClient = true;
      logger.warn(
        `The trusted proxy disclosed no client address (${forwardedHeader}); every request from it is counted as one client.`,
        { requestId, peer: socketAddress ?? 'unknown' }
      );
    }

    // Two headers the deployment maintains naming different clients is either a proxy
    // change nobody announced or someone forging one of them; either way the request is
    // attributed to the peer, and that is worth saying out loud once.
    if (source.conflict && !warnedAboutConflictingHeaders) {
      warnedAboutConflictingHeaders = true;
      logger.warn(
        'Forwarded and X-Forwarded-For named different clients; the request was attributed to the peer instead.',
        { requestId, peer: socketAddress ?? 'unknown' }
      );
    }

    // A request arriving from a host-local address that carries any forwarded header is the
    // signature of a reverse proxy nobody configured: headers are ignored, so every client
    // shares one rate-limit bucket and every audit row names the proxy instead of a person.
    // Reported once per process, so it is a finding rather than per-request noise.
    if (
      !warnedAboutIgnoredForwarding &&
      (forwardedFor !== undefined || forwarded !== undefined) &&
      socketAddress !== null &&
      isLocalOrPrivateAddress(socketAddress) &&
      !trustProxy.isTrusted(socketAddress)
    ) {
      warnedAboutIgnoredForwarding = true;
      logger.warn(
        `A forwarded header was ignored: ${socketAddress} is a local address but not a trusted proxy. Set TRUST_PROXY if this API runs behind a reverse proxy.`,
        { requestId, peer: socketAddress }
      );
    }

    let status = 500;
    let payload: unknown = null;
    // A 429 names its wait twice: in the body's `details.retryAfterSeconds` for clients
    // that read JSON, and in the standard `Retry-After` header for HTTP stacks (mobile
    // networking layers included) that honour it without parsing the body.
    let retryAfterSeconds: number | null = null;

    try {
      // Health checks are exempt so monitoring never trips the client rate limit.
      let countedSessionId: string | null = null;
      if (pathname !== '/health') {
        const decision = await rateLimiter.check(clientIp);
        countedSessionId = decision.sessionId;
        if (!decision.allowed) {
          throw new RateLimitError(`Too many requests. Retry in ${decision.retryAfterSeconds}s`, {
            retryAfterSeconds: decision.retryAfterSeconds
          });
        }
      }

      let matchedRoute: Route | null = null;
      let params: Record<string, string> = {};
      let pathMatched = false;

      for (const route of routes) {
        const routeParams = matchPath(route.path, pathname);
        if (routeParams) {
          pathMatched = true;
          if (route.method === method) {
            matchedRoute = route;
            params = routeParams;
            break;
          }
        }
      }

      if (!matchedRoute) {
        if (pathMatched) {
          throw new AppError(`Method ${method} is not allowed for ${pathname}`, 405, 'METHOD_NOT_ALLOWED');
        }
        throw new NotFoundError(`Route ${method} ${pathname}`);
      }

      let auth: AuthContext | undefined;
      if (matchedRoute.requiresAuth) {
        auth = await authenticateRequest(req.headers);

        // The count had to happen before we knew who was asking — a flood must be refused
        // before it can cost a token check — so the session is named on the counter now that
        // it is proved. Only when the row is not already attributed to this session, which in
        // the ordinary case means once per device per window rather than once per request.
        if (auth.sessionId !== countedSessionId) {
          await rateLimiter.recordSession(clientIp, auth.sessionId);
        }

        // Checked before the role lookup so an account still under review gets a useful
        // message instead of "your role lacks this permission". Pending and rejected
        // accounts hold no role permissions; only status-checking routes opt out.
        const approvalStatus = auth.user.approvalStatus ?? 'APPROVED';
        if (approvalStatus !== 'APPROVED' && !matchedRoute.allowUnapprovedAccount) {
          throw new AppError(
            approvalStatus === 'REJECTED'
              ? 'This registration was rejected by an administrator'
              : 'This account is awaiting administrator approval',
            403,
            'ACCOUNT_NOT_APPROVED',
            true,
            { approvalStatus, reason: auth.user.approvalReason ?? null }
          );
        }

        if (matchedRoute.permission) {
          assertPermission(auth.user.role, matchedRoute.permission);
        }
      }

      const ctx: RequestContext = {
        params,
        query: url.searchParams,
        headers: req.headers,
        clientIp,
        ...clientAddressFields(source),
        requestId,
        body: methodHasBody(matchedRoute.method) ? await readJsonBody(req) : {},
        auth
      };

      const result = await matchedRoute.handler(ctx);
      status = result.status;
      payload = result.body;
    } catch (error) {
      const serialized = serializeError(error);
      const isOperational = error instanceof AppError;
      status = isOperational ? error.statusCode : 500;
      payload = {
        success: false,
        error: {
          code: serialized.code,
          message: isOperational ? serialized.message : 'Internal server error',
          ...(serialized.details ? { details: serialized.details } : {}),
          requestId
        }
      };

      if (status === 429 && serialized.details !== undefined && !Array.isArray(serialized.details)) {
        const wait = (serialized.details as Record<string, unknown>).retryAfterSeconds;
        if (typeof wait === 'number' && Number.isFinite(wait)) {
          retryAfterSeconds = Math.max(0, Math.ceil(wait));
        }
      }

      if (status >= 500) {
        logger.error('Request failed', error, { requestId, method, path: pathname });
      } else {
        logger.warn('Request rejected', { requestId, method, path: pathname, status, code: serialized.code });
      }
    }

    const text = JSON.stringify(payload ?? null);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'x-request-id': requestId,
      ...(retryAfterSeconds !== null ? { 'retry-after': String(retryAfterSeconds) } : {})
    });
    res.end(text);

    logger.info('Request completed', {
      requestId,
      method,
      path: pathname,
      status,
      durationMs: Date.now() - startedAt,
      // Only when a trusted proxy disclosed them: for a direct request the API knows its
      // own scheme and host, and saying so on every line would be noise.
      ...clientAddressFields(source)
    });
  };
}
