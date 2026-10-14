import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, types as pgTypes, type PoolClient, type PoolConfig } from 'pg';
import { AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import type { DatabaseDriver, QueryResult } from './client.js';
import { toPostgres, toStorageParams } from './sqlDialect.js';

/**
 * The PostgreSQL backend: same platform, same schema, a real database server underneath.
 *
 * SQLite is one file on one host, which is what the pilot runs on and what the cross-process
 * tests exercise. This driver is for the deployments that cannot be that: several hosts, a
 * scheduler that moves processes, a managed database with backups and a standby. Nothing
 * above this file knows the difference — repositories write the same SQL, get the same row
 * shapes back, and the per-request session lookup stays what it was: one primary-key read.
 *
 * Three properties are deliberately preserved from the SQLite driver rather than left to
 * PostgreSQL's defaults:
 *
 * - **Values read back the same.** `BIGINT` keeps the 64-bit width `INTEGER` has in SQLite,
 *   and is parsed into a JavaScript number here, so `Boolean(row.isRevoked)` and arithmetic
 *   on epoch milliseconds behave identically on both engines instead of turning `'0'` into
 *   `true`. Widening is safe because every integer in this schema is a count, an amount or a
 *   timestamp well inside 2^53. `TEXT` is pinned to the `"C"` collation by the translator, so
 *   comparing ids, ISO timestamps and token digests stays byte-wise.
 * - **Writers serialise, as they did.** SQLite's `BEGIN IMMEDIATE` serialises every writer,
 *   and the invariants that were written against it — a refund may not exceed what was paid,
 *   one `Idempotency-Key` may be claimed once, one refresh token may be rotated once — are
 *   check-then-write sequences that READ COMMITTED would let two transactions interleave.
 *   A transaction-scoped advisory lock restores exactly that guarantee, is released by COMMIT
 *   or ROLLBACK, and costs nothing when transactions queue: they were queueing already.
 * - **Transactions nest instead of erroring.** A `transaction()` inside a transaction joins
 *   the outer one, as it does on SQLite, so the same composed call sites keep working.
 */

/**
 * The key the write lock is taken under, the ASCII of `cxbd`. Any two processes serving this
 * platform must use the same key to serialise against each other, which is why it is a
 * constant rather than derived from anything per-process.
 */
const WRITE_LOCK_KEY = 0x63786264;

/** `bigint` columns, as parsed back. See the note on values read back the same. */
const INT8_OID = 20;

const rowTypes: PoolConfig['types'] = {
  getTypeParser: (oid: number, format?: 'text' | 'binary') =>
    oid === INT8_OID && format !== 'binary'
      ? (value: string): number => Number(value)
      : pgTypes.getTypeParser(oid as never, format as never)
};

export interface PostgresDriverOptions {
  /** A `postgresql://` connection string. Never logged: it carries the password. */
  connectionString: string;
  /** Concurrent connections held open, including the ones inside transactions. */
  max?: number;
  /** How long a query may wait for a connection before the request fails. */
  connectionTimeoutMs?: number;
  /** How long an unused connection is kept before it is closed. */
  idleTimeoutMs?: number;
  /** Read by the server, so an operator can tell this deployment's connections apart. */
  applicationName?: string;
}

export class PostgresDriver implements DatabaseDriver {
  private readonly pool: Pool;
  /**
   * The connection a transaction is running on, carried with the async context rather than
   * held on the instance: one driver serves every concurrent request, and a field would hand
   * one request's transaction — and its uncommitted rows — to another.
   */
  private readonly transactionClient = new AsyncLocalStorage<PoolClient>();
  private isClosed = false;

  constructor(options: PostgresDriverOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.max ?? 10,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
      idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
      application_name: options.applicationName ?? 'cxb-door2door-api',
      // Parsed rather than mutated globally: the `pg` type registry is process-wide, and a
      // deployment that also talks to PostgreSQL for something else should keep its own.
      types: rowTypes
    });

    // A connection dropped while idle (a failover, a firewall, a restart) is announced on the
    // pool. Unhandled, it is an uncaught exception that takes the process down with it.
    this.pool.on('error', (error: Error) => {
      logger.error('An idle PostgreSQL connection failed', error);
    });
  }

  private assertOpen(): void {
    if (this.isClosed) {
      throw new AppError('Database connection closed', 500, 'DB_CLOSED');
    }
  }

  private static toParams(params: readonly unknown[]): unknown[] {
    return toStorageParams(params).map((param) =>
      param instanceof Uint8Array && !Buffer.isBuffer(param) ? Buffer.from(param) : param
    );
  }

  public async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    this.assertOpen();
    const translated = toPostgres(sql);
    const bound = PostgresDriver.toParams(params);

    // Inside a transaction every statement goes down that transaction's connection; outside
    // one it is taken from the pool and returned to it as soon as the answer arrives.
    const client = this.transactionClient.getStore() ?? this.pool;

    // A failure is passed through untouched: `code` is what the callers that recognise a
    // unique violation read, and a rewritten message would hide it.
    const result = await client.query(translated, bound);
    return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
  }

  public async transaction<T>(callback: (driver: DatabaseDriver) => Promise<T>): Promise<T> {
    this.assertOpen();

    // A nested transaction joins the outermost one, as it does on SQLite: PostgreSQL has no
    // nested BEGIN either, and a savepoint here would let an inner failure commit half of a
    // write the caller believed was atomic.
    if (this.transactionClient.getStore()) {
      return callback(this);
    }

    const client = await this.pool.connect();

    // Released exactly once on every path, and only once: a connection that leaks back into no
    // pool is not reclaimed, and the failure mode is a process that works until the pool is
    // exhausted and then waits forever on a connection that will never come back.
    let released = false;
    const release = (destroy = false): void => {
      if (released) return;
      released = true;
      client.release(destroy);
    };

    try {
      await client.query('BEGIN');

      // Taken before the callback runs, so nothing it reads can be changed underneath it by
      // another writer. Released by COMMIT or ROLLBACK below, including on failure.
      await client.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [WRITE_LOCK_KEY]);

      const result = await this.transactionClient.run(client, () => callback(this));
      await client.query('COMMIT');
      release();
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
        release();
      } catch (rollbackError) {
        // The connection is unusable (a dead server, a cancelled backend). The original
        // failure is what the caller needs to see; this one is logged and the connection is
        // discarded rather than returned to the pool in an open transaction.
        logger.error('Could not roll back a failed PostgreSQL transaction', rollbackError);
        release(true);
      }
      throw error;
    }
  }

  public async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    await this.pool.end();
  }

  public async ping(): Promise<boolean> {
    if (this.isClosed) return false;
    try {
      await this.pool.query('SELECT 1 AS ok');
      return true;
    } catch {
      return false;
    }
  }
}
