import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseClient } from '../src/db/client';
import { SqliteDriver } from '../src/db/sqliteDriver';
import { SEEDED } from './apiTestClient';
import { bootServer, ensureBuiltServer, sleep, stopAll, type ServerProcess } from './serverProcesses';

/**
 * Two server processes, one database, one racing duplicate.
 *
 * `tests/orderIdempotency.test.ts` already shows that a stored key replays after a restart,
 * but every request in it is served by a server inside the test's own process. The claim
 * this file holds is the one a second instance makes: two *processes* — separate PIDs,
 * separate connections, one SQLite file — seeing the same `Idempotency-Key` at the same
 * moment must still place one order.
 *
 * So the built API is started twice, as a deployment runs it (`node dist/main.js`), both
 * pointed at one database file, and then raced. Whatever order the attempts interleave in:
 *
 *  - exactly one order row exists afterwards;
 *  - every `201` names the same `order.id`;
 *  - an attempt that loses the race answers `409` (in flight) rather than placing anything;
 *  - a retry against *the other* process returns the first answer.
 *
 * `dist/` is checked before anything boots: a test that quietly ran against a stale build
 * would prove nothing about the source it is meant to cover.
 */

const ORDER_PATH = '/api/v1/orders';

let tempDir: string;
let databaseFile: string;
let first: ServerProcess;
let second: ServerProcess;
/** A reader connection of our own, for asking the database what actually landed. */
let reader: DatabaseClient;

/** One process, serving this file's shared database. */
function boot(): Promise<ServerProcess> {
  return bootServer({ databaseFile });
}

async function post(
  url: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  let parsed: any = null;
  try {
    parsed = await response.json();
  } catch {
    /* a response with no JSON body is recorded by its status alone */
  }
  return { status: response.status, body: parsed };
}

function orderPayload(quantity = 1): Record<string, unknown> {
  return {
    customerId: SEEDED.customer.id,
    merchantId: SEEDED.merchantId,
    deliveryAddressId: SEEDED.addressId,
    serviceArea: 'cox_bazar_sadar',
    distanceKm: 3,
    items: [{ itemId: SEEDED.coralId, quantity }]
  };
}

/** A new key per case, so one case's stored answer cannot answer another's request. */
function key(label: string): string {
  return `cross-process-${label}-${randomUUID()}`;
}

function place(server: ServerProcess, idempotencyKey: string, quantity = 1) {
  return post(server.url, ORDER_PATH, orderPayload(quantity), {
    'idempotency-key': idempotencyKey,
    // Minted by one process, honoured by both: sessions live in the shared database.
    authorization: `Bearer ${token}`
  });
}

async function orderCount(): Promise<number> {
  const result = await reader.query<{ count: number }>(
    'SELECT COUNT(*) as count FROM orders WHERE customerId = ?',
    [SEEDED.customer.id]
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** A paid order, placed and charged through one process, then used by both. */
async function placePaidOrder(server: ServerProcess, label: string): Promise<{ orderId: string; paid: number }> {
  const placed = await place(server, key(`${label}-place`));
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const orderId = placed.body.order.id as string;

  const payment = await post(
    server.url,
    `/api/v1/orders/${orderId}/payments`,
    { method: 'BKASH' },
    { 'idempotency-key': key(`${label}-pay`), authorization: `Bearer ${token}` }
  );
  expect(payment.status, JSON.stringify(payment.body)).toBe(201);
  return { orderId, paid: payment.body.payment.amountBdt as number };
}

function cancelOrder(server: ServerProcess, orderId: string, idempotencyKey: string) {
  return post(
    server.url,
    `/api/v1/orders/${orderId}/cancel`,
    {},
    { 'idempotency-key': idempotencyKey, authorization: `Bearer ${token}` }
  );
}

/** What the refunds table holds for one order: how many, and how much money in total. */
async function refundsFor(orderId: string): Promise<{ count: number; total: number }> {
  const result = await reader.query<{ count: number; total: number }>(
    'SELECT COUNT(*) as count, COALESCE(SUM(amountBdt), 0) as total FROM refunds WHERE orderId = ?',
    [orderId]
  );
  return { count: Number(result.rows[0]?.count ?? 0), total: Number(result.rows[0]?.total ?? 0) };
}

/** The order ids this customer actually has rows for. */
async function storedOrderIds(): Promise<string[]> {
  const result = await reader.query<{ id: string }>(
    'SELECT id FROM orders WHERE customerId = ? ORDER BY createdAt',
    [SEEDED.customer.id]
  );
  return result.rows.map((row) => row.id);
}

let token: string;

beforeAll(async () => {
  ensureBuiltServer();

  tempDir = mkdtempSync(join(tmpdir(), 'cxb-cross-process-'));
  databaseFile = join(tempDir, 'orders.sqlite');

  // Sequentially: the first process seeds the pilot dataset, and two processes racing to
  // create the same rows would be a fixture failure, not a finding about idempotency.
  first = await boot();
  second = await boot();

  reader = new DatabaseClient(new SqliteDriver(databaseFile));

  // Sign in once, against one process: the other must accept the token, which it can only
  // do by reading the same sessions table — the shared database, demonstrated up front.
  const request = await post(first.url, '/api/v1/auth/otp/request', { phone: SEEDED.customer.phone });
  if (request.status !== 200 || typeof request.body?.devOtp !== 'string') {
    throw new Error(`Could not obtain a login code: ${JSON.stringify(request)}`);
  }
  const verify = await post(first.url, '/api/v1/auth/otp/verify', {
    phone: SEEDED.customer.phone,
    otp: request.body.devOtp
  });
  if (verify.status !== 200) {
    throw new Error(`Could not sign in: ${JSON.stringify(verify)}`);
  }
  token = verify.body.tokens.accessToken;

  const me = await fetch(`${second.url}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  if (me.status !== 200) {
    throw new Error(`The second process did not accept the first process's session (${me.status})`);
  }
}, 180_000);

afterAll(async () => {
  await stopAll([first, second]);
  if (reader) await reader.close();
  // Windows can hold the file briefly after a killed process exits, and the database is
  // open by up to two server processes until they are gone, so the removal is retried for
  // a few seconds. A directory that survives that is reported rather than swallowed: it
  // would mean a process outlived this test.
  let removed = false;
  for (let attempt = 0; attempt < 20 && !removed; attempt += 1) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
      removed = true;
    } catch {
      await sleep(250);
    }
  }
  if (!removed) console.warn(`Could not remove the cross-process test directory: ${tempDir}`);
}, 60_000);

describe('One database shared by two server processes', () => {
  it('is really two processes, both serving the same database', async () => {
    expect(first.pid).toBeGreaterThan(0);
    expect(second.pid).toBeGreaterThan(0);
    expect(first.pid).not.toBe(second.pid);
    expect(first.url).not.toBe(second.url);

    const firstHealth = await fetch(`${first.url}/health`);
    const secondHealth = await fetch(`${second.url}/health`);
    expect(firstHealth.status).toBe(200);
    expect(secondHealth.status).toBe(200);

    // Same file, so a row written by one process is visible to the other: the sessions
    // table is where that shows without any test-only endpoint.
    const result = await reader.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM auth_sessions WHERE userId = ?',
      [SEEDED.customer.id]
    );
    expect(Number(result.rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });

  it('places one order when the same request races both processes at once', async () => {
    const idempotencyKey = key('race');
    const before = await orderCount();

    const [a, b] = await Promise.all([place(first, idempotencyKey), place(second, idempotencyKey)]);

    // Each attempt either placed the order, replayed its stored answer, or was told the
    // key is in flight. Nothing else is a legitimate answer to a duplicate.
    for (const [name, response] of [
      ['first', a],
      ['second', b]
    ] as const) {
      expect([201, 409], `the ${name} process answered ${response.status}: ${JSON.stringify(response.body)}`).toContain(
        response.status
      );
      if (response.status === 409) {
        expect(response.body.error.code).toBe('CONFLICT');
      }
    }

    const created = [a, b].filter((response) => response.status === 201);
    expect(created.length, 'at least one attempt must have placed the order').toBeGreaterThan(0);

    // The heart of it: one order, one id, whichever process answered.
    const ids = new Set(created.map((response) => response.body.order.id));
    expect([...ids]).toHaveLength(1);

    expect(await orderCount()).toBe(before + 1);
    expect(await storedOrderIds()).toContain([...ids][0]);
  }, 60_000);

  it('returns the first answer when the retry lands on the other process', async () => {
    const idempotencyKey = key('retry');
    const before = await orderCount();

    const placed = await place(first, idempotencyKey);
    expect(placed.status).toBe(201);

    // A different process, with no memory of the first attempt, and only the database to
    // tell it what happened.
    const replay = await place(second, idempotencyKey);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(placed.body);
    expect(await orderCount()).toBe(before + 1);
  }, 60_000);

  it('refuses the key for a different order, in both processes, without placing anything', async () => {
    const idempotencyKey = key('different-payload');
    const before = await orderCount();

    const placed = await place(first, idempotencyKey, 1);
    expect(placed.status).toBe(201);

    const [a, b] = await Promise.all([
      place(first, idempotencyKey, 2),
      place(second, idempotencyKey, 2)
    ]);

    for (const response of [a, b]) {
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
      // Naming the reason matters: a caller must be able to tell "still in flight" from
      // "this key already bought something else".
      expect(response.body.error.message).toMatch(/different request payload/);
    }

    expect(await orderCount()).toBe(before + 1);
  }, 60_000);

  it('places one order when a burst of duplicates hits both processes', async () => {
    const idempotencyKey = key('burst');
    const before = await orderCount();

    const responses = await Promise.all([
      place(first, idempotencyKey),
      place(second, idempotencyKey),
      place(first, idempotencyKey),
      place(second, idempotencyKey)
    ]);

    const created = responses.filter((response) => response.status === 201);
    for (const response of responses) {
      expect([201, 409]).toContain(response.status);
    }
    expect(created.length).toBeGreaterThan(0);

    const ids = new Set(created.map((response) => response.body.order.id));
    expect([...ids]).toHaveLength(1);

    const after = await orderCount();
    expect(after).toBe(before + 1);
    // One row in the table for the whole burst, counting what is stored rather than what
    // was answered.
    expect((await storedOrderIds()).filter((id) => id === [...ids][0])).toHaveLength(1);
  }, 60_000);

  it('answers a duplicate from the stored row even after the process that wrote it is gone', async () => {
    const idempotencyKey = key('survivor');
    const before = await orderCount();

    const placed = await place(second, idempotencyKey);
    expect(placed.status).toBe(201);

    await second.stop();

    // The survivor process never saw the original request.
    const replay = await place(first, idempotencyKey);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(placed.body);
    expect(await orderCount()).toBe(before + 1);

    second = await boot();
  }, 90_000);

  it('refunds once when the same cancellation races both processes', async () => {
    const { orderId, paid } = await placePaidOrder(first, 'cancel-race');
    const idempotencyKey = key('cancel-same-key');

    const [a, b] = await Promise.all([
      cancelOrder(first, orderId, idempotencyKey),
      cancelOrder(second, orderId, idempotencyKey)
    ]);

    for (const response of [a, b]) {
      expect([200, 409], JSON.stringify(response.body)).toContain(response.status);
    }
    const answered = [a, b].filter((response) => response.status === 200);
    expect(answered.length).toBeGreaterThan(0);
    // A replay is the same answer, so every 200 describes the same refund.
    expect(new Set(answered.map((response) => response.body.refund.id)).size).toBe(1);

    // The money that went back is the money that came in, once.
    const refunds = await refundsFor(orderId);
    expect(refunds.count).toBe(1);
    expect(refunds.total).toBe(paid);
  }, 60_000);

  it('never refunds twice when two different keys race both processes', async () => {
    const { orderId, paid } = await placePaidOrder(first, 'refund-race');

    // Different keys, so the idempotency guard cannot help: what refuses the second one is
    // the write transaction deciding the order has no money left to give back.
    const [a, b] = await Promise.all([
      cancelOrder(first, orderId, key('cancel-a')),
      cancelOrder(second, orderId, key('cancel-b'))
    ]);

    const refunds = await refundsFor(orderId);
    expect(refunds.count).toBeLessThanOrEqual(1);
    expect(refunds.total).toBeLessThanOrEqual(paid);
    // Exactly one of the two ended the order; the other was refused rather than paying the
    // customer twice.
    expect([a.status, b.status].filter((status) => status === 200).length).toBe(1);
  }, 60_000);
});
