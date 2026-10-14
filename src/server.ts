import { createServer, type Server } from 'node:http';
import { assertSecureProductionConfig, env } from './config/env.js';
import { logger } from './core/logger.js';
import { settleSecurityNotices } from './auth/securityNotices.js';
import { DatabaseClient } from './db/client.js';
import { createStorageDriver, type StorageBackend } from './db/storage.js';
import { seedIfEmpty } from './db/seed.js';
import { createApp, type AppOptions } from './http/app.js';
import { parseForwardedHeaderMode, parseTrustedProxies } from './http/clientIp.js';
import { ClientAddressRetention } from './auth/clientAddressRetention.js';
import { RetentionRepository } from './db/repositories.js';

export interface StartServerOptions {
  /** TCP port to bind. 0 selects an ephemeral port. Defaults to env.PORT. */
  port?: number;
  /** Interface to bind. Defaults to env.HOST. */
  host?: string;
  /** SQLite file backing the platform. Defaults to env.SQLITE_STORAGE_PATH. */
  databaseFile?: string;
  /** Which engine to run on. Defaults to env.DB_DRIVER. */
  backend?: StorageBackend;
  /** PostgreSQL connection string. Defaults to env.DATABASE_URL. */
  databaseUrl?: string;
  /** Seed pilot data on first boot of an empty database. Defaults to true. */
  seed?: boolean;
  /** Overrides the configured request rate limit. */
  rateLimit?: { max: number; windowMs: number };
  /** Overrides the configured TRUST_PROXY: which peers are believed about the caller. */
  trustProxy?: string;
  /** Overrides the configured PII_RETENTION_DAYS. */
  retentionDays?: number;
  /** Overrides the configured TRUSTED_FORWARD_HEADER. */
  trustedForwardHeader?: string;
  /** Injectable for tests; defaults to the configured SMS gateway. */
  otpDispatch?: AppOptions['otpDispatch'];
  /** Injectable for tests; the out-of-band channel a security notice is sent on. */
  noticeSender?: AppOptions['noticeSender'];
  /** Overrides the configured SMS_RECEIPT_WEBHOOK_SECRET, the gateway's report secret. */
  receiptWebhookSecret?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  host: string;
  /** Which engine is actually serving this process. */
  backend: StorageBackend;
  /** Where the data is, safe to log or print in a test failure. */
  databaseDescription: string;
  databaseFile: string;
  client: DatabaseClient;
  server: Server;
  close(): Promise<void>;
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
      } else {
        resolve(port);
      }
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Composition root: opens the persistent database, applies migrations, seeds the
 * pilot dataset once, wires the HTTP application and starts listening.
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  assertSecureProductionConfig(env);

  const port = options.port ?? env.PORT;
  const host = options.host ?? env.HOST;
  const databaseFile = options.databaseFile ?? env.SQLITE_STORAGE_PATH;
  const shouldSeed = options.seed ?? true;

  const storage = await createStorageDriver({
    backend: options.backend ?? env.DB_DRIVER,
    sqliteFile: databaseFile,
    databaseUrl: options.databaseUrl ?? env.DATABASE_URL,
    poolMax: env.PG_POOL_MAX,
    connectionTimeoutMs: env.PG_CONNECTION_TIMEOUT_MS
  });
  const client = new DatabaseClient(storage.driver);
  await client.migrate();

  if (shouldSeed) {
    await seedIfEmpty(client);
  }

  // Addresses are normally redacted with the traffic that creates them (the next login),
  // but a process that restarts rarely — or is handed a restored backup — should not wait
  // for a customer to sign in before the retention window is applied to what is already
  // there. Best effort: a failure here must not stop the API from starting.
  const retentionDays = options.retentionDays ?? env.PII_RETENTION_DAYS;
  await new ClientAddressRetention({
    repo: new RetentionRepository(client),
    retentionDays
  }).sweep();

  const server = createServer(
    createApp(client, {
      rateLimit: options.rateLimit,
      trustProxy: options.trustProxy,
      trustedForwardHeader: options.trustedForwardHeader,
      retentionDays,
      otpDispatch: options.otpDispatch,
      noticeSender: options.noticeSender,
      receiptWebhookSecret: options.receiptWebhookSecret
    })
  );
  const boundPort = await listen(server, port, host);
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${displayHost}:${boundPort}`;

  // Printed at boot because a wrong value here is invisible at runtime: with the wrong
  // answer every customer shares one rate-limit bucket and every session row names the
  // proxy, and the API looks healthy throughout.
  logger.info(`Cox's Bazar Door2Door API listening on ${url}`, {
    // The backend and where it points, never the connection string: that carries the password.
    storageBackend: storage.backend,
    database: storage.description,
    environment: env.NODE_ENV,
    trustedProxies: parseTrustedProxies(options.trustProxy ?? env.TRUST_PROXY).description,
    forwardedHeader: parseForwardedHeaderMode(
      options.trustedForwardHeader ?? env.TRUSTED_FORWARD_HEADER
    )
  });

  let isClosing = false;

  return {
    url,
    port: boundPort,
    host,
    backend: storage.backend,
    databaseDescription: storage.description,
    databaseFile,
    client,
    server,
    close: async (): Promise<void> => {
      if (isClosing) return;
      isClosing = true;

      const closed = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      server.closeAllConnections();
      await closed;
      // A security notice already on its way to the gateway is worth finishing: the account
      // holder is locked out either way, and a warning lost to a restart tells nobody.
      await settleSecurityNotices();
      await client.close();
      logger.info('Server stopped and database connection closed');
    }
  };
}

