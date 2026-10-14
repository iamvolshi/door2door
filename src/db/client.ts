import { DDL_STATEMENTS, MIGRATION_STATEMENTS } from './schema.js';
import { logger } from '../core/logger.js';
import {
  AppError,
  isDatabaseBusyError,
  isDuplicateColumnError,
  isDuplicateObjectError
} from '../core/errors.js';

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface DatabaseDriver {
  execute(sql: string, params?: unknown[]): Promise<QueryResult>;
  transaction<T>(callback: (driver: DatabaseDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  ping(): Promise<boolean>;
}

/**
 * High-performance lightweight In-Memory & Parameterized SQL compatible store
 * supporting both SQLite syntax and PostgreSQL style queries.
 */
export class MemoryDatabaseDriver implements DatabaseDriver {
  private tables = new Map<string, Array<Record<string, unknown>>>();
  private isClosed = false;

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    if (this.isClosed) {
      throw new AppError('Database connection closed', 500, 'DB_CLOSED');
    }

    const trimmed = sql.trim();
    const upper = trimmed.toUpperCase();

    if (upper.startsWith('CREATE TABLE')) {
      const match = trimmed.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/i);
      if (match && match[1]) {
        const tableName = match[1];
        if (!this.tables.has(tableName)) {
          this.tables.set(tableName, []);
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (upper.startsWith('CREATE INDEX')) {
      return { rows: [], rowCount: 0 };
    }

    if (upper.startsWith('INSERT INTO')) {
      const match = trimmed.match(/INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
      if (match) {
        const tableName = match[1];
        const columns = match[2].split(',').map((c) => c.trim().replace(/["`\[\]]/g, ''));
        const table = this.tables.get(tableName) || [];
        const row: Record<string, unknown> = {};
        columns.forEach((col, idx) => {
          row[col] = params[idx] !== undefined ? params[idx] : null;
        });
        table.push(row);
        this.tables.set(tableName, table);
        return { rows: [row], rowCount: 1 };
      }
    }

    if (upper.startsWith('SELECT')) {
      const fromMatch = trimmed.match(/FROM\s+([a-zA-Z0-9_]+)/i);
      if (!fromMatch) {
        return { rows: [], rowCount: 0 };
      }
      const tableName = fromMatch[1];
      let rows = [...(this.tables.get(tableName) || [])];

      const whereMatch = trimmed.match(/WHERE\s+(.+?)(?:ORDER\s+BY|LIMIT|$)/i);
      if (whereMatch) {
        const whereClause = whereMatch[1];
        const conditions = whereClause.split(/\s+AND\s+/i);
        let paramIdx = 0;
        conditions.forEach((cond) => {
          const parts = cond.trim().split(/\s*=\s*/);
          if (parts.length === 2) {
            const key = parts[0].trim().replace(/["`\[\]]/g, '');
            const expectedVal = params[paramIdx++];
            rows = rows.filter((r) => r[key] === expectedVal);
          }
        });
      }

      return { rows, rowCount: rows.length };
    }

    if (upper.startsWith('UPDATE')) {
      const updateMatch = trimmed.match(/UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+(.+?)\s+WHERE\s+(.+)/i);
      if (updateMatch) {
        const tableName = updateMatch[1];
        const setClause = updateMatch[2];
        const whereClause = updateMatch[3];
        const table = this.tables.get(tableName) || [];

        const setCols = setClause.split(',').map((s) => s.split('=')[0].trim().replace(/["`\[\]]/g, ''));
        let paramIdx = 0;
        const updates: Record<string, unknown> = {};
        setCols.forEach((col) => {
          updates[col] = params[paramIdx++];
        });

        const whereKey = whereClause.split('=')[0].trim().replace(/["`\[\]]/g, '');
        const whereVal = params[paramIdx];

        let updatedCount = 0;
        const updatedRows: Record<string, unknown>[] = [];
        for (let i = 0; i < table.length; i++) {
          if (table[i][whereKey] === whereVal) {
            table[i] = { ...table[i], ...updates };
            updatedRows.push(table[i]);
            updatedCount++;
          }
        }
        return { rows: updatedRows, rowCount: updatedCount };
      }
    }

    if (upper.startsWith('DELETE FROM')) {
      const match = trimmed.match(/DELETE\s+FROM\s+([a-zA-Z0-9_]+)\s+WHERE\s+(.+)/i);
      if (match) {
        const tableName = match[1];
        const whereKey = match[2].split('=')[0].trim().replace(/["`\[\]]/g, '');
        const whereVal = params[0];
        const table = this.tables.get(tableName) || [];
        const originalCount = table.length;
        const filtered = table.filter((r) => r[whereKey] !== whereVal);
        this.tables.set(tableName, filtered);
        return { rows: [], rowCount: originalCount - filtered.length };
      }
    }

    return { rows: [], rowCount: 0 };
  }

  async transaction<T>(callback: (driver: DatabaseDriver) => Promise<T>): Promise<T> {
    return callback(this);
  }

  async close(): Promise<void> {
    this.isClosed = true;
  }

  async ping(): Promise<boolean> {
    return !this.isClosed;
  }

  getTableData(tableName: string): Record<string, unknown>[] {
    return this.tables.get(tableName) || [];
  }
}

export class DatabaseClient {
  private static instance: DatabaseClient | null = null;
  private driver: DatabaseDriver;
  private initialized = false;

  constructor(driver?: DatabaseDriver) {
    this.driver = driver || new MemoryDatabaseDriver();
  }

  public static getInstance(driver?: DatabaseDriver): DatabaseClient {
    if (!DatabaseClient.instance) {
      DatabaseClient.instance = new DatabaseClient(driver);
    }
    return DatabaseClient.instance;
  }

  public static resetInstance(): void {
    DatabaseClient.instance = null;
  }

  public getDriver(): DatabaseDriver {
    return this.driver;
  }

  /**
   * A second process starting against the same database can find it mid-write. SQLite
   * reports that as a busy/locked error and PostgreSQL announces a deadlock or a lock wait
   * that gave up; neither is a schema fault, so the attempt is retried rather than crashing
   * the process during boot.
   */
  private static isLockedError(error: unknown): boolean {
    return isDatabaseBusyError(error);
  }

  public async migrate(): Promise<void> {
    logger.info('Running database migrations...');

    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.runMigrationStatements();
        this.initialized = true;
        logger.info('Database migrations completed successfully');
        return;
      } catch (error) {
        if (!DatabaseClient.isLockedError(error) || attempt === maxAttempts) {
          throw error;
        }
        const delayMs = 100 * attempt;
        logger.warn(`Database busy while migrating; retrying in ${delayMs}ms`, { attempt });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private async runMigrationStatements(): Promise<void> {
    for (const ddl of DDL_STATEMENTS) {
      await this.driver.execute(ddl);
    }
    for (const migration of MIGRATION_STATEMENTS) {
      try {
        await this.driver.execute(migration);
      } catch (error) {
        // Adding a column that already exists is the expected outcome on a current schema.
        // So is losing a race with another process that created the same object a moment
        // ago: PostgreSQL refuses the loser instead of treating the race as a no-op.
        if (!isDuplicateColumnError(error) && !isDuplicateObjectError(error)) {
          throw error;
        }
      }
    }
  }

  public async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    if (!this.initialized) {
      await this.migrate();
    }
    return (await this.driver.execute(sql, params)) as QueryResult<T>;
  }

  public async transaction<T>(callback: (client: DatabaseClient) => Promise<T>): Promise<T> {
    return this.driver.transaction(async () => {
      return callback(this);
    });
  }

  public async healthCheck(): Promise<{ ok: boolean; timestamp: string }> {
    const isOk = await this.driver.ping();
    return {
      ok: isOk,
      timestamp: new Date().toISOString()
    };
  }

  public async close(): Promise<void> {
    await this.driver.close();
    this.initialized = false;
  }
}

export const db = DatabaseClient.getInstance();
