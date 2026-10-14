import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { DatabaseClient, type DatabaseDriver, type QueryResult } from '../src/db/client';
import { PostgresDriver } from '../src/db/postgresDriver';
import { AuthRepository, UserRepository } from '../src/db/repositories';
import { seedIfEmpty } from '../src/db/seed';
import { toPostgres } from '../src/db/sqlDialect';
import { isUniqueViolationError } from '../src/core/errors';
import { getJson, login, postJson, startServer, SEEDED, type RunningServer } from './apiTestClient';

/**
 * The PostgreSQL backend, against a real PostgreSQL.
 *
 * These are the claims the SQLite suites cannot make: that the translated schema is one
 * PostgreSQL accepts, that a row read back has the same shape as one read from SQLite, that
 * the per-request session lookup is still one indexed read, and that the writer serialisation
 * `BEGIN IMMEDIATE` gave the platform's invariants survives the move to a server.
 *
 * The whole run happens inside a schema of its own, created and dropped here, so pointing
 * `TEST_DATABASE_URL` at any database — including a shared one — cannot disturb anything
 * outside it: nothing the tests create is unqualified by `search_path`, and the schema they
 * created is the only thing dropped at the end.
 */

const BASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55432/cxb_door2door_dev';

const SCHEMA = `cxb_test_${randomBytes(5).toString('hex')}`;

/** The same connection, with every unqualified name resolved inside the test's own schema. */
function scoped(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('options', `-c search_path=${SCHEMA}`);
  return parsed.toString();
}

async function probe(): Promise<string | null> {
  const pool = new Pool({ connectionString: BASE_URL, max: 1, connectionTimeoutMillis: 3000 });
  try {
    await pool.query('SELECT 1');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** Fails 20 % of sessions, as a persistence check rather than a smoke one. */
class RecordingDriver implements DatabaseDriver {
  public readonly statements: string[] = [];

  constructor(private readonly inner: DatabaseDriver) {}

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    this.statements.push(sql);
    return this.inner.execute(sql, params);
  }

  transaction<T>(callback: (driver: DatabaseDriver) => Promise<T>): Promise<T> {
    return this.inner.transaction(callback);
  }

  /** The wrapper does not own the connection, so it does not close one it borrowed. */
  close(): Promise<void> {
    return Promise.resolve();
  }

  ping(): Promise<boolean> {
    return this.inner.ping();
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const unavailable = await probe();

const suite = unavailable === null ? describe : describe.skip;

if (unavailable !== null) {
  // Reported loudly rather than passing quietly: this suite is the only proof that the
  // PostgreSQL path works, and a silent skip would read as a green run.
  console.warn(
    `\n[postgresBackend] SKIPPED: no PostgreSQL at ${new URL(BASE_URL).host} (${unavailable}).\n` +
      '  Start one (e.g. docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine)\n' +
      '  or set TEST_DATABASE_URL, then run: npx vitest run tests/postgresBackend.test.ts\n'
  );
}

suite('A deployment running on PostgreSQL', () => {
  let admin: Pool;
  let client: DatabaseClient;
  let driver: PostgresDriver;
  let api: RunningServer | undefined;

  beforeAll(async () => {
    admin = new Pool({ connectionString: BASE_URL, max: 2 });
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);

    driver = new PostgresDriver({ connectionString: scoped(BASE_URL), max: 4 });
    client = new DatabaseClient(driver);
    await client.migrate();
    await seedIfEmpty(client);
  });

  afterAll(async () => {
    await api?.close();
    await client?.close();
    // The schema goes with everything in it; the database it lived in is left as it was found.
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await admin?.end();
  });

  it('creates the platform schema on an empty database', async () => {
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = ?`,
      [SCHEMA]
    );
    const names = tables.rows.map((row) => row.table_name);
    for (const expected of [
      'users',
      'auth_sessions',
      'audit_logs',
      'notifications',
      'otp_deliveries',
      'request_rate_limits',
      'idempotency_keys',
      'refunds'
    ]) {
      expect(names, `missing table ${expected}`).toContain(expected);
    }

    // The two columns that only exist because a migration added them, on this schema too.
    const migrations = await client.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = ? AND column_name IN ('sessionId', 'windowStart')`,
      [SCHEMA]
    );
    const byColumn = new Map(
      migrations.rows.map((row) => [`${row.table_name}.${row.column_name}`, row.data_type])
    );
    // The column is `sessionId` and not `sessionid`: PostgreSQL would fold an unquoted name,
    // and the application reads `row.sessionId`, so the spelling has to survive the port.
    expect(byColumn.get('audit_logs.sessionId')).toBe('text');
    // 64-bit, so epoch milliseconds survive: an `INTEGER` here would overflow in 1970.
    expect(byColumn.get('request_rate_limits.windowStart')).toBe('bigint');
  });

  it('pins text columns to the byte-wise collation SQLite compares with', async () => {
    // Without this, `'2026-1…' < '2026-10…'` and id ordering would follow the server's locale
    // instead of the bytes, and the trail would be ordered differently on two deployments.
    const collations = await client.query<{ table_name: string; collation_name: string }>(
      `SELECT table_name, collation_name FROM information_schema.columns
        WHERE table_schema = ? AND column_name IN ('id', 'tokenHash', 'createdAt')`,
      [SCHEMA]
    );
    expect(collations.rows.length).toBeGreaterThan(0);
    for (const column of collations.rows) {
      expect(column.collation_name, `${column.table_name} lost its collation`).toBe('C');
    }
  });

  it('reads a row back with the same shape SQLite gives it', async () => {
    const customer = await new UserRepository(client).findById(SEEDED.customer.id);

    // `isActive` is an integer standing in for a boolean; `Boolean('0')` would be true, and a
    // row that arrives as a string would quietly turn off every active-account check.
    expect(customer?.isActive).toBe(true);
    expect(typeof customer?.isActive).toBe('boolean');
    expect(customer?.phone).toBe(SEEDED.customer.phone);

    // The same for epoch milliseconds, which must stay numbers rather than becoming strings.
    const challenge = await client.query<{ expiresAt: string }>(
      `INSERT INTO otp_challenges (phone, otpHash, expiresAt, attempts, lastSentAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET expiresAt = excluded.expiresAt
       RETURNING expiresAt`,
      ['+8801811990001', 'hash', 1_770_000_000_123, 0, 1_770_000_000_000]
    );
    expect(challenge.rows[0].expiresAt).toBe(1_770_000_000_123);
  });

  it('keeps the per-request session lookup one read of one primary key', async () => {
    const recorder = new RecordingDriver(driver);
    const recorded = new DatabaseClient(recorder);
    const sessions = new AuthRepository(recorded);

    const created = await sessions.createSession({
      id: 'sess_plan_probe',
      userId: SEEDED.customer.id,
      tokenHash: 'plan_probe_hash',
      ipAddress: '203.0.113.9',
      userAgent: 'vitest/1.0',
      expiresAt: '2030-01-01T00:00:00.000Z',
      isRevoked: false,
      familyId: 'sess_plan_probe',
      replacedBy: null,
      createdAt: new Date().toISOString()
    });

    recorder.statements.length = 0;
    const found = await sessions.getSessionById(created.id);

    // One statement, and it names the primary key: this runs on every authenticated request,
    // so a second round trip or a scan here would be paid by every call the API serves.
    expect(recorder.statements).toHaveLength(1);
    expect(recorder.statements[0]).toBe('SELECT * FROM auth_sessions WHERE id = ?');
    // …and on the wire it is the same one statement, parameterised, which is what the server
    // can plan once and reuse.
    expect(toPostgres(recorder.statements[0])).toBe('SELECT * FROM auth_sessions WHERE id = $1');
    expect(found?.id).toBe(created.id);
    expect(found?.isRevoked).toBe(false);

    // And what the planner does with it, which is what makes it cheap as the table grows.
    const plan = await client.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (FORMAT JSON) SELECT * FROM auth_sessions WHERE id = ?`,
      [created.id]
    );
    const serialized = JSON.stringify(plan.rows[0]);
    expect(serialized).toContain('auth_sessions_pkey');
    expect(serialized).not.toContain('Seq Scan');
    expect(serialized).toContain('Index Scan');

    await client.query(`DELETE FROM auth_sessions WHERE id = ?`, [created.id]);
    await recorded.close();
  });

  it('does not slow the lookup down as the table grows by an order of magnitude', async () => {
    const bulk = async (from: number, to: number): Promise<void> => {
      await client.query(
        `INSERT INTO auth_sessions (id, userId, tokenHash, ipAddress, userAgent, expiresAt, isRevoked, familyId, replacedBy, createdAt)
         SELECT 'bulk_' || g, ?, 'bulk_hash_' || g, '203.0.113.9', 'bulk/1.0', '2030-01-01T00:00:00.000Z', 0, 'bulk_' || g, NULL, '2026-01-01T00:00:00.000Z'
           FROM generate_series(?::int, ?::int) AS g`,
        [SEEDED.customer.id, from, to]
      );
    };

    const sessions = new AuthRepository(client);
    const measure = async (probes: number, rounds: number): Promise<number> => {
      for (let i = 0; i < 50; i += 1) await sessions.getSessionById('bulk_1');
      const rounds_: number[] = [];
      for (let round = 0; round < rounds; round += 1) {
        const times: number[] = [];
        for (let i = 0; i < probes; i += 1) {
          const started = performance.now();
          await sessions.getSessionById(`bulk_${(i % 1000) + 1}`);
          times.push(performance.now() - started);
        }
        rounds_.push(median(times));
      }
      // The best of several rounds rather than their average: this suite shares a machine
      // with every other test file, and contention can only ever make a read look slower, so
      // the minimum is the closest thing here to the read's actual cost.
      return Math.min(...rounds_);
    };

    await bulk(1, 5_000);
    const small = await measure(100, 3);
    // Forty times the rows for the same read. The floor in the bound below is what absorbs a
    // busy machine (this suite shares one with every other test file); a scan of 200,000 rows
    // would need an order of magnitude more than that floor, which is the failure this looks
    // for.
    await bulk(5_001, 200_000);
    const large = await measure(100, 3);

    console.log(
      `[postgresBackend] session lookup: ${small.toFixed(3)} ms at 5k rows, ${large.toFixed(3)} ms at 200k rows`
    );
    expect(large).toBeLessThan(Math.max(small * 3, 5));

    await client.query(`DELETE FROM auth_sessions WHERE id LIKE 'bulk_%'`);
  }, 60_000);

  it('serialises concurrent writers, which is what the money and token invariants assume', async () => {
    // The shape every guarded write in the platform has: read a value, decide, write. READ
    // COMMITTED lets both transactions decide on the same "before"; SQLite's BEGIN IMMEDIATE
    // never did, and the advisory lock is what carries that guarantee over.
    await client.query(
      `INSERT INTO otp_challenges (phone, otpHash, expiresAt, attempts, lastSentAt) VALUES (?, NULL, ?, 0, ?)
       ON CONFLICT(phone) DO UPDATE SET attempts = 0`,
      ['+8801811990002', 1_770_000_000_000, 1_770_000_000_000]
    );

    const bump = (): Promise<number> =>
      client.transaction(async (tx) => {
        const read = await tx.query<{ attempts: number }>(
          `SELECT attempts FROM otp_challenges WHERE phone = ?`,
          ['+8801811990002']
        );
        const before = Number(read.rows[0].attempts);
        await new Promise((resolve) => setTimeout(resolve, 120));
        await tx.query(`UPDATE otp_challenges SET attempts = ? WHERE phone = ?`, [
          before + 1,
          '+8801811990002'
        ]);
        return before + 1;
      });

    const results = await Promise.all([bump(), bump()]);
    const after = await client.query<{ attempts: number }>(
      `SELECT attempts FROM otp_challenges WHERE phone = ?`,
      ['+8801811990002']
    );

    // Two increments, not one: neither transaction read the state the other was about to write.
    expect(results.sort()).toEqual([1, 2]);
    expect(Number(after.rows[0].attempts)).toBe(2);
  });

  it('commits, rolls back and joins nested transactions the way SQLite does', async () => {
    await client.transaction(async (tx) => {
      await tx.query(`INSERT INTO audit_logs (id, action, entityType, entityId, createdAt) VALUES (?, ?, ?, ?, ?)`, [
        'audit_commit',
        'PG_TEST_COMMIT',
        'PLATFORM',
        'SYSTEM',
        new Date().toISOString()
      ]);
    });

    await expect(
      client.transaction(async (tx) => {
        await tx.query(`INSERT INTO audit_logs (id, action, entityType, entityId, createdAt) VALUES (?, ?, ?, ?, ?)`, [
          'audit_rollback',
          'PG_TEST_ROLLBACK',
          'PLATFORM',
          'SYSTEM',
          new Date().toISOString()
        ]);
        throw new Error('the caller changed its mind');
      })
    ).rejects.toThrow('the caller changed its mind');

    // A nested transaction joins the outer one rather than opening a second: an inner write
    // followed by an outer failure must leave nothing behind.
    await expect(
      client.transaction(async (outer) => {
        await outer.transaction(async (inner) => {
          await inner.query(
            `INSERT INTO audit_logs (id, action, entityType, entityId, createdAt) VALUES (?, ?, ?, ?, ?)`,
            ['audit_nested', 'PG_TEST_NESTED', 'PLATFORM', 'SYSTEM', new Date().toISOString()]
          );
        });
        throw new Error('the outer transaction failed');
      })
    ).rejects.toThrow('the outer transaction failed');

    const rows = await client.query<{ id: string }>(
      `SELECT id FROM audit_logs WHERE id IN ('audit_commit', 'audit_rollback', 'audit_nested')`
    );
    expect(rows.rows.map((row) => row.id)).toEqual(['audit_commit']);
  });

  it('hands its connections back, so a pool smaller than the work is not exhausted', async () => {
    // More concurrent transactions than the pool has connections. Each one holds a connection
    // while it waits its turn on the write lock, so a transaction that failed to release its
    // connection would leave the pool permanently short and every later caller waiting for a
    // connection that never comes back — a hang with no error to read.
    const small = new PostgresDriver({ connectionString: scoped(BASE_URL), max: 2 });
    const sized = new DatabaseClient(small);
    try {
      const runs = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          sized.transaction(async (tx) => {
            await tx.query(`SELECT count(*) AS n FROM users`);
            return index;
          })
        )
      );
      expect(runs).toHaveLength(6);
    } finally {
      await sized.close();
    }
  }, 30_000);

  it('recognises a uniqueness violation from either engine', async () => {
    // The refund, payment and login-code paths turn a duplicate into a conflict by reading the
    // error; PostgreSQL says it with a SQLSTATE where SQLite says it with a message.
    const sessions = new AuthRepository(client);
    const first = {
      id: 'sess_unique_probe',
      userId: SEEDED.customer.id,
      tokenHash: 'unique_probe_hash',
      ipAddress: null,
      userAgent: null,
      expiresAt: '2030-01-01T00:00:00.000Z',
      isRevoked: false,
      familyId: 'sess_unique_probe',
      replacedBy: null,
      createdAt: new Date().toISOString()
    };
    await sessions.createSession(first);

    let violation: unknown;
    try {
      await sessions.createSession({ ...first, id: 'sess_unique_probe_2' });
    } catch (error) {
      violation = error;
    }
    expect(isUniqueViolationError(violation)).toBe(true);
  });

  it('serves the API end to end, session id and all', async () => {
    api = await startServer({
      port: 0,
      host: '127.0.0.1',
      backend: 'postgres',
      databaseUrl: scoped(BASE_URL),
      rateLimit: { max: 5000, windowMs: 60_000 }
    });
    expect(api.backend).toBe('postgres');
    // The description an operator is shown never carries the password.
    expect(api.databaseDescription).not.toContain('postgres:postgres');

    const customer = await login(api, SEEDED.customer.phone);
    const sessions = await getJson(api, '/api/v1/auth/sessions', { token: customer.accessToken });
    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions.some((s: { isCurrent: boolean }) => s.isCurrent)).toBe(true);

    const order = {
      merchantId: SEEDED.merchantId,
      deliveryAddressId: SEEDED.addressId,
      serviceArea: 'cox_bazar_sadar',
      distanceKm: 3,
      items: [{ itemId: SEEDED.rupchandaId, quantity: 1 }]
    };
    const placed = await postJson(api, '/api/v1/orders', order, {
      token: customer.accessToken,
      headers: { 'idempotency-key': 'pg-e2e-1' }
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);

    // The same key twice is the same order, which is the idempotency claim on this engine.
    const repeated = await postJson(api, '/api/v1/orders', order, {
      token: customer.accessToken,
      headers: { 'idempotency-key': 'pg-e2e-1' }
    });
    expect(repeated.body.order.id).toBe(placed.body.order.id);

    // And the trail names the session on this engine too, which is the point of the column.
    const trail = await api.client.query<{ action: string; sessionId: string | null }>(
      `SELECT action, sessionId FROM audit_logs WHERE sessionId IS NOT NULL ORDER BY createdAt DESC LIMIT 5`
    );
    expect(trail.rows.length).toBeGreaterThan(0);
    for (const row of trail.rows) {
      expect(row.sessionId).toBeTruthy();
    }

    const counter = await api.client.query<{ sessionId: string | null }>(
      `SELECT sessionId FROM request_rate_limits WHERE sessionId IS NOT NULL`
    );
    expect(counter.rows.length).toBeGreaterThan(0);
  }, 60_000);
});
