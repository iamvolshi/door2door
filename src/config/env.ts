import { z } from 'zod';
import { describeForwardedHeaderProblem, describeTrustProxyProblem } from '../http/clientIp';

/** Development-only JWT secret. `assertSecureProductionConfig` refuses it in production. */
export const DEV_JWT_SECRET = 'development_jwt_secret_must_be_long_and_secure';

/** Development-only database URL. `assertSecureProductionConfig` refuses it in production. */
export const DEV_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/cxb_door2door_dev';

const booleanish = (defaultValue: boolean) =>
  z
    .string()
    .default(String(defaultValue))
    .transform((value) => value.trim().toLowerCase() === 'true');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // 0 is valid and means "bind an ephemeral port" (used by tests and container runtimes).
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_URL: z.string().min(1).default(DEV_DATABASE_URL),
  // File-backed SQLite database used by the runtime (src/server.ts). Persistent by default.
  SQLITE_STORAGE_PATH: z.string().min(1).default('./data/cxb_delivery.sqlite'),
  // Which engine the platform stores its data in (src/db/storage.ts). Explicit rather than
  // inferred from DATABASE_URL: that variable has a default so that it is declared at all, and
  // reading its presence as "run on PostgreSQL" would move a deployment off its own SQLite file
  // the first time somebody exported a URL.
  DB_DRIVER: z.enum(['sqlite', 'postgres']).default('sqlite'),
  // Connections the PostgreSQL backend holds open. Writes are serialised by the driver (see
  // src/db/postgresDriver.ts), so this bounds concurrent *reads* — the traffic that scales.
  PG_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  PG_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
  JWT_EXPIRES_IN: z.string().default('7d'),
  // SMS delivery for phone OTP. Supported providers: 'greenweb' and 'bulksmsbd'.
  // A provider with no credential (or an unknown name) fails closed instead of
  // pretending to send; SMS_MOCK_MODE simulates dispatch without any network call.
  SMS_PROVIDER: z.string().default('none'),
  SMS_MOCK_MODE: booleanish(true),
  SMS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  SMS_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  SMS_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(500),
  GREENWEB_API_URL: z.string().default('https://api.greenweb.com.bd/api.php'),
  GREENWEB_API_TOKEN: z.string().default(''),
  GREENWEB_SENDER_ID: z.string().default('CXBEXPRESS'),
  BULKSMSBD_API_URL: z.string().default('https://bulksmsbd.net/api/smsapi'),
  BULKSMSBD_API_KEY: z.string().default(''),
  BULKSMSBD_SENDER_ID: z.string().default('CXBEXPRESS'),
  // The shared secret the gateway presents when it reports what happened to a message
  // (src/http/routes/webhookRoutes.ts). Empty means the delivery-report endpoint is served
  // but refuses every report, which is the honest state of a deployment that has not been
  // given a secret to check against — and it is not part of the production boot checks,
  // because a gateway that cannot report delivery is a thinner trail rather than a broken
  // platform: the attempt is still recorded, it just never learns about the handset.
  SMS_RECEIPT_WEBHOOK_SECRET: z.string().default(''),
  CORS_ORIGIN: z.string().default('*'),
  // Which peers may be believed about the client's address (see src/http/clientIp.ts).
  // Empty means "no proxy", and then X-Forwarded-For is ignored entirely — correct for a
  // directly exposed API, and wrong (every client shares one rate-limit bucket, and every
  // session records the proxy) behind a reverse proxy. A value that does not parse stops
  // the boot, so a typo cannot silently degrade to either extreme.
  TRUST_PROXY: z
    .string()
    .default('')
    .superRefine((value, ctx) => {
      const problem = describeTrustProxyProblem(value);
      if (problem) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${problem}. Use '', true, 'loopback', or a comma-separated list of IP addresses and CIDR ranges`
        });
      }
    }),
  // Which forwarded header the proxies in front of this API maintain (see
  // src/http/clientIp.ts). 'x-forwarded-for' is the default and ignores RFC 7239's
  // `Forwarded` entirely; 'forwarded' reads only that header; 'both' reads both and, when
  // they name different clients, believes neither and attributes the request to the peer.
  // It is never guessed from the request: reading a header the proxies do not maintain
  // would let any caller name itself, so a deployment has to say which one it has.
  TRUSTED_FORWARD_HEADER: z
    .string()
    .default('x-forwarded-for')
    .superRefine((value, ctx) => {
      const problem = describeForwardedHeaderProblem(value);
      if (problem) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${problem}. Use 'x-forwarded-for', 'forwarded' or 'both'`
        });
      }
    }),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  // How many days the address a client connected from (and the device string beside it)
  // may be kept in auth_sessions, audit_logs and otp_deliveries before it is replaced by
  // '[redacted]' (src/auth/clientAddressRetention.ts). The rows themselves are kept.
  // There is no "off" value: 0 is refused rather than guessed at, because it could mean
  // either "redact immediately" or "do not redact", and a privacy control that silently
  // does nothing is worse than one that complains. Ten years is the practical maximum.
  PII_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  APP_NAME: z.string().default('CoxBazarDoor2Door'),
  ENCRYPTION_KEY: z.string().min(32).default('12345678901234567890123456789012')
})
  // A backend and a connection string that disagree are a boot-time mistake, and the first
  // request that touched the database would report it as an outage instead.
  .superRefine((config, ctx) => {
    if (config.DB_DRIVER !== 'postgres') return;
    let protocol = '';
    try {
      protocol = new URL(config.DATABASE_URL).protocol;
    } catch {
      protocol = '';
    }
    if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'must be a postgresql:// connection string when DB_DRIVER=postgres'
      });
    }
  });

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(customEnv?: Record<string, unknown>): EnvConfig {
  const source = customEnv ?? process.env;
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const formatted = result.error.errors
      .map((err) => `  - ${err.path.join('.')}: ${err.message}`)
      .join('\n');
    throw new Error(`[Configuration Error] Invalid environment variables:\n${formatted}`);
  }

  return result.data;
}

let _envInstance: EnvConfig | null = null;

export function getEnv(): EnvConfig {
  if (!_envInstance) {
    _envInstance = validateEnv();
  }
  return _envInstance;
}

/**
 * Refuses to boot a production process on development-only defaults.
 */
export function assertSecureProductionConfig(config: EnvConfig): void {
  if (config.NODE_ENV !== 'production') return;

  const problems: string[] = [];
  if (config.JWT_SECRET === DEV_JWT_SECRET) {
    problems.push('JWT_SECRET is still the development default');
  }
  if (config.ENCRYPTION_KEY === '12345678901234567890123456789012') {
    problems.push('ENCRYPTION_KEY is still the development default');
  }
  if (config.DB_DRIVER === 'postgres' && config.DATABASE_URL === DEV_DATABASE_URL) {
    problems.push('DATABASE_URL is still the development default while DB_DRIVER=postgres');
  }
  if (config.SMS_MOCK_MODE) {
    problems.push('SMS_MOCK_MODE is enabled, so no OTP would ever reach a phone');
  }

  const smsProvider = config.SMS_PROVIDER.trim().toLowerCase();
  if (smsProvider === '' || smsProvider === 'none') {
    problems.push('SMS_PROVIDER is not configured, so phone login cannot work');
  } else {
    const credential =
      smsProvider === 'greenweb'
        ? config.GREENWEB_API_TOKEN
        : smsProvider === 'bulksmsbd'
          ? config.BULKSMSBD_API_KEY
          : null;
    if (credential === null) {
      problems.push(`SMS_PROVIDER '${smsProvider}' has no implemented client`);
    } else if (credential.trim() === '') {
      problems.push(`SMS_PROVIDER '${smsProvider}' has no credential`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `[Configuration Error] Refusing to start in production: ${problems.join('; ')}. Set real secrets before deploying.`
    );
  }
}

export const env = getEnv();