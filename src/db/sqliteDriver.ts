import type { StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from '../core/errors.js';
import type { DatabaseDriver, QueryResult } from './client.js';

type SqlValue = null | number | bigint | string | Uint8Array;
type SqliteModule = typeof import('node:sqlite');

/**
 * `node:sqlite` is a prefix-only builtin: it is missing from `module.builtinModules`,
 * so static `import` statements cannot be resolved by bundlers or test runners.
 * `process.getBuiltinModule` fetches the real module at runtime instead, which keeps
 * this file loadable under Vite/Vitest as well as plain Node.
 */
const sqliteModule = process.getBuiltinModule('node:sqlite') as unknown as SqliteModule | undefined;
if (!sqliteModule) {
  throw new Error(
    'node:sqlite is unavailable in this runtime. Node.js >= 22.5.0 is required (see package.json engines).'
  );
}
const { DatabaseSync } = sqliteModule;
type Database = InstanceType<SqliteModule['DatabaseSync']>;

const READ_STATEMENT = /^\s*(SELECT|PRAGMA|WITH)\b/i;
/**
 * A write that answers with rows (`INSERT … RETURNING`). The rate-limit counter is one:
 * it increments and reports the counter it landed in, as a single atomic statement, so
 * two processes cannot both believe they were the first to touch a window. `run()` throws
 * the returned rows away, so these have to go through `all()`.
 */
const RETURNING_STATEMENT = /\bRETURNING\b/i;

/**
 * Persistent SQLite driver (file-backed) implementing the platform DatabaseDriver
 * contract. Unlike MemoryDatabaseDriver, data survives process restarts and
 * `transaction()` performs a real atomic BEGIN/COMMIT/ROLLBACK.
 */
export class SqliteDriver implements DatabaseDriver {
  private readonly connection: Database;
  private isClosed = false;
  private transactionDepth = 0;

  constructor(filename: string) {
    if (filename !== ':memory:') {
      mkdirSync(dirname(filename), { recursive: true });
    }
    this.connection = new DatabaseSync(filename);
    this.connection.exec('PRAGMA journal_mode = WAL');
    this.connection.exec('PRAGMA foreign_keys = ON');
    // Several server processes may share one database file, so a writer that finds the
    // file locked by another process waits instead of failing immediately.
    this.connection.exec('PRAGMA busy_timeout = 5000');
  }

  private assertOpen(): void {
    if (this.isClosed) {
      throw new AppError('Database connection closed', 500, 'DB_CLOSED');
    }
  }

  private static toSqlParams(params: unknown[]): SqlValue[] {
    return params.map((param) => {
      if (param === null || param === undefined) return null;
      if (typeof param === 'boolean') return param ? 1 : 0;
      if (
        typeof param === 'number' ||
        typeof param === 'string' ||
        typeof param === 'bigint' ||
        param instanceof Uint8Array
      ) {
        return param;
      }
      return JSON.stringify(param) ?? String(param);
    });
  }

  public async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    this.assertOpen();
    const statement: StatementSync = this.connection.prepare(sql);
    const bound = SqliteDriver.toSqlParams(params);

    if (READ_STATEMENT.test(sql) || RETURNING_STATEMENT.test(sql)) {
      const rows = statement.all(...bound) as Record<string, unknown>[];
      return { rows, rowCount: rows.length };
    }

    const info = statement.run(...bound);
    return { rows: [], rowCount: Number(info.changes) };
  }

  public async transaction<T>(callback: (driver: DatabaseDriver) => Promise<T>): Promise<T> {
    this.assertOpen();

    // Nested calls join the outermost transaction (SQLite has no nested BEGIN).
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        return await callback(this);
      } finally {
        this.transactionDepth -= 1;
      }
    }

    this.transactionDepth = 1;
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = await callback(this);
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  public async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.connection.close();
  }

  public async ping(): Promise<boolean> {
    if (this.isClosed) return false;
    try {
      this.connection.prepare('SELECT 1 AS ok').get();
      return true;
    } catch {
      return false;
    }
  }
}
