import { AppError } from '../core/errors.js';
import type { DatabaseDriver } from './client.js';
import { SqliteDriver } from './sqliteDriver.js';

/**
 * Choosing the storage engine, in one place.
 *
 * The platform is written against `DatabaseDriver`, so the choice is a single decision made
 * at boot and named in the log line that follows it. Which engine is chosen is never inferred:
 * `DATABASE_URL` has a default so that the variable is declared, and treating "a URL exists"
 * as "run on PostgreSQL" would move a deployment off its own database the first time somebody
 * exported one.
 */
export type StorageBackend = 'sqlite' | 'postgres';

export interface StorageOptions {
  backend: StorageBackend;
  /** The SQLite file, used only when `backend` is `sqlite`. */
  sqliteFile: string;
  /** The `postgresql://` connection string, used only when `backend` is `postgres`. */
  databaseUrl: string;
  /** Concurrent PostgreSQL connections. */
  poolMax?: number;
  connectionTimeoutMs?: number;
}

export interface SelectedStorage {
  backend: StorageBackend;
  driver: DatabaseDriver;
  /**
   * A description of where the data actually is, safe to log.
   *
   * Never the connection string: it carries the password, and a boot log is the last place a
   * credential should end up. For PostgreSQL this is the host, port and database with the user
   * name beside them, which is what an operator needs to confirm the API came up against the
   * database they meant.
   */
  description: string;
}

/** `user@host:port/database`, with the password left out. */
export function describeDatabaseTarget(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    const database = url.pathname.replace(/^\//, '') || '(no database named)';
    const user = url.username === '' ? '' : `${decodeURIComponent(url.username)}@`;
    const port = url.port === '' ? '' : `:${url.port}`;
    return `${user}${url.hostname}${port}/${database}`;
  } catch {
    return '(a DATABASE_URL that could not be parsed)';
  }
}

function assertPostgresUrl(databaseUrl: string): void {
  let protocol = '';
  try {
    protocol = new URL(databaseUrl).protocol;
  } catch {
    protocol = '';
  }
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
    throw new AppError(
      `DB_DRIVER=postgres needs a postgresql:// DATABASE_URL (got '${describeDatabaseTarget(databaseUrl)}')`,
      500,
      'POSTGRES_URL_INVALID'
    );
  }
}

/**
 * Opens the configured engine.
 *
 * The PostgreSQL driver is loaded only when it is the backend, so a deployment running on
 * SQLite neither loads the client library nor needs it installed to boot. The dynamic import
 * is what makes that work under both module systems: CommonJS keeps it a lazy `require`, while
 * a bundler or test runner that treats these files as ESM keeps it a real import.
 */
export async function createStorageDriver(options: StorageOptions): Promise<SelectedStorage> {
  if (options.backend === 'sqlite') {
    return {
      backend: 'sqlite',
      driver: new SqliteDriver(options.sqliteFile),
      description: options.sqliteFile
    };
  }

  assertPostgresUrl(options.databaseUrl);

  let postgres: typeof import('./postgresDriver.js');
  try {
    postgres = await import('./postgresDriver.js');
  } catch (error) {
    throw new AppError(
      "DB_DRIVER=postgres needs the 'pg' package, which could not be loaded. Install it with 'npm install pg'.",
      500,
      'POSTGRES_DRIVER_UNAVAILABLE',
      true,
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }

  return {
    backend: 'postgres',
    driver: new postgres.PostgresDriver({
      connectionString: options.databaseUrl,
      max: options.poolMax,
      connectionTimeoutMs: options.connectionTimeoutMs
    }),
    description: describeDatabaseTarget(options.databaseUrl)
  };
}
