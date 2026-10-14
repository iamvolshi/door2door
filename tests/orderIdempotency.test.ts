import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseClient } from '../src/db/client';
import { SqliteDriver } from '../src/db/sqliteDriver';
import { IdempotencyRepository } from '../src/db/repositories';
import { DurableIdempotencyService } from '../src/services/durableIdempotency';
import { IdempotencyService } from '../src/services/idempotencyService';
import {
  SEEDED,
  createTempDatabaseDir,
  login,
  postJson,
  removeTempDatabaseDir,
  startServer,
  type LoggedInAccount,
  type RunningServer
} from './apiTestClient';

const EXPECTED_TOTAL = 742.5;
const ENDPOINT = 'POST /api/v1/orders';

function orderPayload() {
  return {
    customerId: SEEDED.customer.id,
    merchantId: SEEDED.merchantId,
    deliveryAddressId: SEEDED.addressId,
    serviceArea: 'cox_bazar_sadar',
    distanceKm: 3,
    items: [{ itemId: SEEDED.coralId, quantity: 1 }]
  };
}

/**
 * Reads a stored key using a **separate OS process**, which is the only way to show that
 * what answers a retry is on disk rather than in this process's module state.
 */
function readKeyFromAnotherProcess(
  databaseFile: string,
  scopedKey: string
): { responseStatusCode: number; responseBody: string } | null {
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.env.PROBE_DB);
    const row = db
      .prepare('SELECT responseStatusCode, responseBody, expiresAt FROM idempotency_keys WHERE idempotencyKey = ?')
      .get(process.env.PROBE_KEY);
    db.close();
    process.stdout.write(JSON.stringify(row ?? null));
  `;
  const output = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, PROBE_DB: databaseFile, PROBE_KEY: scopedKey }
  });
  return JSON.parse(output);
}

async function countOrders(client: DatabaseClient, customerId: string): Promise<number> {
  const res = await client.query<{ count: number }>(
    'SELECT COUNT(*) as count FROM orders WHERE customerId = ?',
    [customerId]
  );
  return Number(res.rows[0]?.count ?? 0);
}

let tempDir: string;

beforeAll(() => {
  tempDir = createTempDatabaseDir();
});

afterAll(() => {
  removeTempDatabaseDir(tempDir);
});

describe('Order idempotency that outlives the process', () => {
  it('replays the same order after a restart instead of placing a second one', async () => {
    const file = `${tempDir}/durable.sqlite`;
    const key = `durable-restart-${Date.now()}`;

    const first = await startServer({ port: 0, host: '127.0.0.1', databaseFile: file });
    let orderId = '';
    let session: LoggedInAccount;
    let before = 0;

    try {
      session = await login(first, SEEDED.customer.phone);
      before = await countOrders(first.client, SEEDED.customer.id);

      const created = await postJson(first, '/api/v1/orders', orderPayload(), {
        token: session.accessToken,
        headers: { 'idempotency-key': key }
      });
      expect(created.status).toBe(201);
      expect(created.body.order.pricing.totalBdt).toBe(EXPECTED_TOTAL);
      orderId = created.body.order.id;

      // The claim and its stored answer are rows, not process state: that is what a
      // restart, a deploy or a second instance gets to read.
      const stored = await first.client.query<{
        idempotencyKey: string;
        userId: string;
        endpoint: string;
        requestHash: string;
        responseStatusCode: number;
        responseBody: string;
        expiresAt: string;
      }>('SELECT * FROM idempotency_keys WHERE idempotencyKey = ?', [
        `${SEEDED.customer.id}:${ENDPOINT}:${key}`
      ]);
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0].userId).toBe(SEEDED.customer.id);
      expect(stored.rows[0].endpoint).toBe(ENDPOINT);
      expect(stored.rows[0].requestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.rows[0].responseStatusCode).toBe(201);
      expect(Date.parse(stored.rows[0].expiresAt)).toBeGreaterThan(Date.now());
      expect(JSON.parse(stored.rows[0].responseBody).order.id).toBe(orderId);
    } finally {
      await first.close();
    }

    // Same assertion, but from a process that shares no memory with this one: the key and
    // the order it stands for are on disk, which is the whole point of the change.
    const fromDisk = readKeyFromAnotherProcess(file, `${SEEDED.customer.id}:${ENDPOINT}:${key}`);
    expect(fromDisk?.responseStatusCode).toBe(201);
    expect(JSON.parse(fromDisk!.responseBody).order.id).toBe(orderId);

    const second = await startServer({ port: 0, host: '127.0.0.1', databaseFile: file });
    try {
      // A brand new process, with none of the first attempt's memory, still answers the
      // retry with the order that already exists rather than placing another.
      const replay = await postJson(second, '/api/v1/orders', orderPayload(), {
        token: session!.accessToken,
        headers: { 'idempotency-key': key }
      });
      expect(replay.status).toBe(201);
      expect(replay.body.order.id).toBe(orderId);
      expect(replay.body.order.pricing.totalBdt).toBe(EXPECTED_TOTAL);

      // Exactly one order was added by the pair of identical requests, and the pilot
      // dataset's own order is still there and untouched.
      expect(await countOrders(second.client, SEEDED.customer.id)).toBe(before + 1);
    } finally {
      await second.close();
    }
  }, 30000);

  it('places one order when the same key arrives twice at once', async () => {
    const app: RunningServer = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${tempDir}/concurrent-http.sqlite`
    });

    try {
      const session = await login(app, SEEDED.customer.phone);
      const before = await countOrders(app.client, SEEDED.customer.id);
      const headers = { 'idempotency-key': `http-concurrent-${Date.now()}` };

      const [first, second] = await Promise.all([
        postJson(app, '/api/v1/orders', orderPayload(), { token: session.accessToken, headers }),
        postJson(app, '/api/v1/orders', orderPayload(), { token: session.accessToken, headers })
      ]);

      // Either the duplicate was told the first attempt is still running, or it arrived
      // after it finished and was handed that same order back. Never a second order.
      for (const response of [first, second]) {
        expect([201, 409]).toContain(response.status);
      }
      expect([first.status, second.status]).toContain(201);
      if (first.status === 201 && second.status === 201) {
        expect(first.body.order.id).toBe(second.body.order.id);
      }
      expect(await countOrders(app.client, SEEDED.customer.id)).toBe(before + 1);
    } finally {
      await app.close();
    }
  }, 30000);

  it('refuses a key that is reused for a different order without placing anything', async () => {
    const app: RunningServer = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${tempDir}/mismatch.sqlite`
    });

    try {
      const session = await login(app, SEEDED.customer.phone);
      const key = `durable-mismatch-${Date.now()}`;

      const created = await postJson(app, '/api/v1/orders', orderPayload(), {
        token: session.accessToken,
        headers: { 'idempotency-key': key }
      });
      expect(created.status).toBe(201);
      const before = await countOrders(app.client, SEEDED.customer.id);

      const different = await postJson(
        app,
        '/api/v1/orders',
        { ...orderPayload(), items: [{ itemId: SEEDED.rupchandaId, quantity: 2 }] },
        { token: session.accessToken, headers: { 'idempotency-key': key } }
      );
      expect(different.status).toBe(409);
      expect(different.body.error.code).toBe('CONFLICT');
      expect(different.body.error.message).toMatch(/different request payload/);
      expect(await countOrders(app.client, SEEDED.customer.id)).toBe(before);
    } finally {
      await app.close();
    }
  }, 30000);
});

describe('DurableIdempotencyService against the real database', () => {
  let client: DatabaseClient;
  let service: DurableIdempotencyService;

  beforeAll(async () => {
    client = new DatabaseClient(new SqliteDriver(`${tempDir}/service.sqlite`));
    await client.migrate();
    service = new DurableIdempotencyService(client);
  });

  afterAll(async () => {
    await client.close();
  });

  function request(key: string, userId = 'usr_a', payload: unknown = { amount: 1 }) {
    return { key, userId, endpoint: ENDPOINT, payload };
  }

  /**
   * The promise is one order however many times the client asks, so a write that fails
   * after the order itself was placed is the case worth attacking: the retry must not
   * place it a second time. The order here is an `audit_logs` row standing in for the
   * real insert, so what is asserted is what is actually in the database afterwards.
   */
  it('never places the same order twice when the answer cannot be stored', async () => {
    const own = new DatabaseClient(new SqliteDriver(`${tempDir}/answer-write.sqlite`));
    await own.migrate();
    const ownService = new DurableIdempotencyService(own);
    const marker = `order-stand-in-${Date.now()}`;
    type QueryFn = DatabaseClient['query'];
    const intactQuery = own.query.bind(own) as QueryFn;

    const placeOrderStandIn = async () => {
      await own.query(
        'INSERT INTO audit_logs (id, userId, action, entityType, entityId, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
        [`aud_${randomUUID()}`, 'usr_a', 'ORDER_PLACED', 'ORDER', marker, new Date().toISOString()]
      );
    };
    const ordersPlaced = async () =>
      Number(
        (
          await own.query<{ count: number }>('SELECT COUNT(*) as count FROM audit_logs WHERE entityId = ?', [
            marker
          ])
        ).rows[0].count
      );

    let failTheAnswerWrite = true;
    own.query = (async (sql: string, params: unknown[] = []) => {
      if (failTheAnswerWrite && /UPDATE idempotency_keys/i.test(sql)) {
        failTheAnswerWrite = false;
        throw new Error('disk I/O error');
      }
      return intactQuery(sql, params);
    }) as unknown as QueryFn;

    const action = async () => {
      await placeOrderStandIn();
      return { status: 201, body: { order: marker } };
    };

    try {
      const key = `answer-write-${Date.now()}`;
      await expect(ownService.execute(request(key), action)).rejects.toThrow('disk I/O error');

      // The client retries with the same key, exactly as it would after a 500.
      own.query = intactQuery;
      const retry = await ownService.execute(request(key), action);
      expect(retry.status).toBe(201);

      // One order, whatever happened in between.
      expect(await ordersPlaced()).toBe(1);
    } finally {
      own.query = intactQuery;
      await own.close();
    }
  });

  it('runs the work once when two identical requests arrive together', async () => {
    let runs = 0;
    const action = async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { status: 201, body: { placed: runs } };
    };

    const key = `concurrent-${Date.now()}`;
    const results = await Promise.allSettled([
      service.execute(request(key), action),
      service.execute(request(key), action)
    ]);

    expect(runs).toBe(1);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.statusCode).toBe(409);
  });

  it('keeps one account from being handed another account\'s stored response', async () => {
    const key = `shared-value-${Date.now()}`;
    const first = await service.execute(request(key, 'usr_a', { amount: 10 }), async () => ({
      status: 201,
      body: { order: 'order-of-a' }
    }));
    const second = await service.execute(request(key, 'usr_b', { amount: 10 }), async () => ({
      status: 201,
      body: { order: 'order-of-b' }
    }));

    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(false);
    expect(second.body.order).toBe('order-of-b');
  });

  it('refuses a key that is claimed but has no answer, rather than guessing', async () => {
    const key = `claimed-unanswered-${Date.now()}`;
    const repo = new IdempotencyRepository(client);
    const scoped = `usr_a:${ENDPOINT}:${key}`;

    // Not a state this service can leave behind — the claim is written in the same
    // transaction as the answer — so a row found this way must fail closed: running the
    // work again is exactly how a half-finished attempt becomes a second order.
    await repo.claim({
      id: `idem_unanswered_${Date.now()}`,
      idempotencyKey: scoped,
      userId: 'usr_a',
      endpoint: ENDPOINT,
      requestHash: IdempotencyService.hashPayload({ amount: 1 }),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    });

    const refused = await service
      .execute(request(key), async () => ({ status: 201, body: { placed: true } }))
      .then(() => 'placed')
      .catch((error: { statusCode?: number }) => error.statusCode);
    expect(refused).toBe(409);
  });

  it('frees the key when the attempt fails, so the client can retry', async () => {
    const key = `failed-${Date.now()}`;
    await expect(
      service.execute(request(key), async () => {
        throw new Error('payment gateway unreachable');
      })
    ).rejects.toThrow('payment gateway unreachable');

    const retry = await service.execute(request(key), async () => ({
      status: 201,
      body: { placed: true }
    }));
    expect(retry.fromCache).toBe(false);
    expect(retry.body.placed).toBe(true);
  });

  it('frees a key when the work and its answer are rolled back together', async () => {
    const key = `rolled-back-${Date.now()}`;
    const scoped = `usr_a:${ENDPOINT}:${key}`;

    await expect(
      service.execute(request(key), async () => {
        throw new Error('constraint violated after the insert');
      })
    ).rejects.toThrow('constraint violated after the insert');

    // Nothing was written, so nothing is left claiming the key.
    const repo = new IdempotencyRepository(client);
    expect(await repo.findByKey(scoped)).toBeNull();
  });

  it('lets a key be reused once its retention window has passed', async () => {
    const key = `expired-${Date.now()}`;
    const scoped = `usr_a:${ENDPOINT}:${key}`;
    const first = await service.execute(request(key), async () => ({
      status: 201,
      body: { placed: 'first' }
    }));
    expect(first.body.placed).toBe('first');

    await client.query('UPDATE idempotency_keys SET expiresAt = ? WHERE idempotencyKey = ?', [
      new Date(Date.now() - 1000).toISOString(),
      scoped
    ]);

    const afterExpiry = await service.execute(request(key), async () => ({
      status: 201,
      body: { placed: 'second' }
    }));
    expect(afterExpiry.fromCache).toBe(false);
    expect(afterExpiry.body.placed).toBe('second');
  });

  it('only frees a key whose retention window has closed', async () => {
    const repo = new IdempotencyRepository(client);
    const scoped = `usr_a:${ENDPOINT}:conditional-${Date.now()}`;
    await repo.save({
      id: `idem_conditional_${Date.now()}`,
      idempotencyKey: scoped,
      userId: 'usr_a',
      endpoint: ENDPOINT,
      requestHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    // A live key survives, even when a reader that saw an older version of it decides it
    // has expired: another request may have claimed it since.
    expect(await repo.deleteIfExpired(scoped, new Date().toISOString())).toBe(false);
    expect(await repo.findByKey(scoped)).not.toBeNull();

    await client.query('UPDATE idempotency_keys SET expiresAt = ? WHERE idempotencyKey = ?', [
      new Date(Date.now() - 1000).toISOString(),
      scoped
    ]);
    expect(await repo.deleteIfExpired(scoped, new Date().toISOString())).toBe(true);
    expect(await repo.findByKey(scoped)).toBeNull();
  });

  it('prunes expired keys without disturbing the live ones', async () => {
    const live = `live-${Date.now()}`;
    const stored = await service.execute(request(live), async () => ({
      status: 201,
      body: { placed: true }
    }));
    expect(stored.fromCache).toBe(false);

    const repo = new IdempotencyRepository(client);
    await repo.save({
      id: `idem_stale_${Date.now()}`,
      idempotencyKey: `usr_a:${ENDPOINT}:stale-${Date.now()}`,
      userId: 'usr_a',
      endpoint: ENDPOINT,
      requestHash: 'stale',
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    });

    const removed = await repo.deleteExpired(new Date().toISOString());
    expect(removed).toBeGreaterThanOrEqual(1);

    const replay = await service.execute(request(live), async () => {
      throw new Error('the live key must still replay');
    });
    expect(replay.fromCache).toBe(true);
  });
});
