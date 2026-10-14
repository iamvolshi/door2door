import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseClient } from '../src/db/client';
import { SqliteDriver } from '../src/db/sqliteDriver';
import {
  createTempDatabaseDir,
  postJson,
  removeTempDatabaseDir,
  startServer,
  type RunningServer
} from './apiTestClient';
import { bootServer, ensureBuiltServer, stopAll, type ServerProcess } from './serverProcesses';

/**
 * The claim this exists to hold up: `RATE_LIMIT_MAX` is the budget of the *deployment*,
 * not of each process in it. Two processes on one database, one client address.
 *
 * The first two sections prove it with two servers inside this process, which is the fast
 * way to test the counter's arithmetic and rollover. The last section proves it with two
 * real `node dist/main.js` processes sharing a file, which is the shape a deployment
 * actually runs and the only way to show the count is the database's rather than the
 * process's.
 */
let tempDir: string;
const booted: RunningServer[] = [];
const serverProcesses: (ServerProcess | undefined)[] = [];
let rateLimitReader: DatabaseClient;

/** Two processes over one database file, each configured with the same limit. */
async function bootPair(name: string, max: number): Promise<[RunningServer, RunningServer]> {
  const databaseFile = `${tempDir}/${name}.sqlite`;
  const first = await startServer({
    port: 0,
    host: '127.0.0.1',
    databaseFile,
    rateLimit: { max, windowMs: 60000 }
  });
  const second = await startServer({
    port: 0,
    host: '127.0.0.1',
    databaseFile,
    rateLimit: { max, windowMs: 60000 }
  });
  booted.push(first, second);
  return [first, second];
}

/** Any route works: it is rejected for a missing token after the limiter has counted it. */
function quote(target: RunningServer): Promise<number> {
  return postJson(target, '/api/v1/orders/quote', {}).then((response) => response.status);
}

beforeAll(() => {
  tempDir = createTempDatabaseDir();
});

afterAll(async () => {
  for (const server of booted) {
    await server?.close();
  }
  // The child processes hold the database open, so they go first.
  await stopAll(serverProcesses);
  if (rateLimitReader) await rateLimitReader.close();
  removeTempDatabaseDir(tempDir);
});

describe('One request budget shared by every process', () => {
  it('spends one allowance across two processes, not one each', async () => {
    const [first, second] = await bootPair('shared', 3);

    // Three requests in total: two handled by one process, one by the other.
    expect(await quote(first)).toBe(401);
    expect(await quote(first)).toBe(401);
    expect(await quote(second)).toBe(401);

    // The budget was spent by the deployment, so both processes refuse the next request —
    // including the one that had only served a single request so far.
    expect(await quote(second)).toBe(429);
    expect(await quote(first)).toBe(429);

    const refused = await postJson(second, '/api/v1/orders/quote', {});
    expect(refused.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(refused.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts concurrent requests from two processes exactly once each', async () => {
    const [first, second] = await bootPair('concurrent', 5);

    // Twenty requests at once, half to each process. If an increment could be lost or
    // counted twice, the number that got through would not be exactly the limit.
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        quote(index % 2 === 0 ? first : second)
      )
    );

    const allowed = responses.filter((status) => status === 401).length;
    const refused = responses.filter((status) => status === 429).length;
    expect(allowed).toBe(5);
    expect(refused).toBe(15);
  });

  it('lets both processes serve a new window once the old one closes', async () => {
    const databaseFile = `${tempDir}/rollover.sqlite`;
    const [first, second] = [
      await startServer({
        port: 0,
        host: '127.0.0.1',
        databaseFile,
        rateLimit: { max: 1, windowMs: 1000 }
      }),
      await startServer({
        port: 0,
        host: '127.0.0.1',
        databaseFile,
        rateLimit: { max: 1, windowMs: 1000 }
      })
    ];
    booted.push(first, second);

    expect(await quote(first)).toBe(401);
    expect(await quote(second)).toBe(429);

    // The window is anchored to the first request, so waiting past it opens a new one for
    // the whole deployment rather than per process.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await quote(second)).toBe(401);
    expect(await quote(first)).toBe(429);
  });
});

describe('One request budget shared by two real server processes', () => {
  /** Any route works: it is rejected for a missing token after the limiter has counted it. */
  async function quoteUrl(url: string): Promise<number> {
    const response = await fetch(`${url}/api/v1/orders/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    return response.status;
  }

  it('enforces the configured burst once, not once per process', async () => {
    ensureBuiltServer();

    // A database of its own, so this burst cannot collide with the servers above.
    const databaseFile = `${tempDir}/real-processes.sqlite`;
    const env = { RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' };
    const firstProcess = await bootServer({ databaseFile, env });
    const secondProcess = await bootServer({ databaseFile, env });
    serverProcesses.push(firstProcess, secondProcess);

    expect(firstProcess.pid).not.toBe(secondProcess.pid);

    // Three requests, split across the two processes: the deployment's three, not three each.
    expect(await quoteUrl(firstProcess.url)).toBe(401);
    expect(await quoteUrl(secondProcess.url)).toBe(401);
    expect(await quoteUrl(firstProcess.url)).toBe(401);

    // The fourth is refused by *both* — including the process that had served only one
    // request so far, which is the whole point: no process holds a budget of its own.
    expect(await quoteUrl(secondProcess.url)).toBe(429);
    expect(await quoteUrl(firstProcess.url)).toBe(429);

    const refused = await fetch(`${firstProcess.url}/api/v1/orders/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as { error?: { code?: string; details?: { retryAfterSeconds?: number } } };
    expect(body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(body.error?.details?.retryAfterSeconds).toBeGreaterThan(0);

    // The counter is a row in the platform database, not a number in either process.
    rateLimitReader = new DatabaseClient(new SqliteDriver(databaseFile));
    const counters = await rateLimitReader.query<{ key: string; hits: number }>(
      'SELECT key, hits FROM request_rate_limits'
    );
    expect(counters.rows).toHaveLength(1);
    // Every request was counted, refused ones included, and the window did not restart.
    expect(Number(counters.rows[0].hits)).toBeGreaterThanOrEqual(4);
    // The row identifies the client without holding the address: a digest, not `127.0.0.1`.
    expect(counters.rows[0].key).not.toContain('127.0.0.1');
    expect(counters.rows[0].key).toMatch(/^[0-9a-f]{32}$/);
  }, 120_000);

  it('lets both processes serve again once the shared window closes', async () => {
    const databaseFile = `${tempDir}/real-processes-rollover.sqlite`;
    const env = { RATE_LIMIT_MAX: '1', RATE_LIMIT_WINDOW_MS: '1000' };
    const firstProcess = await bootServer({ databaseFile, env });
    const secondProcess = await bootServer({ databaseFile, env });
    serverProcesses.push(firstProcess, secondProcess);

    expect(await quoteUrl(firstProcess.url)).toBe(401);
    expect(await quoteUrl(secondProcess.url)).toBe(429);

    // The window is anchored to the first request and stored with the counter, so it opens
    // for the whole deployment at once rather than separately in each process.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await quoteUrl(secondProcess.url)).toBe(401);
    expect(await quoteUrl(firstProcess.url)).toBe(429);
  }, 120_000);
});
