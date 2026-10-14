import { describe, expect, it } from 'vitest';
import { DatabaseRateLimiter } from '../src/http/rateLimiter';
import { DatabaseClient } from '../src/db/client';
import { RateLimitRepository } from '../src/db/repositories';
import { SqliteDriver } from '../src/db/sqliteDriver';

const SECRET = 'rate_limit_test_secret_at_least_32_chars';
const MAX = 3;
const WINDOW_MS = 60_000;
const NOW = 1_700_000_000_000;

async function freshRepo(): Promise<{ client: DatabaseClient; repo: RateLimitRepository }> {
  const client = new DatabaseClient(new SqliteDriver(':memory:'));
  await client.migrate();
  return { client, repo: new RateLimitRepository(client) };
}

function limiter(repo: RateLimitRepository, overrides: Partial<{ secret: string }> = {}) {
  return new DatabaseRateLimiter({
    repo,
    max: MAX,
    windowMs: WINDOW_MS,
    secret: overrides.secret ?? SECRET
  });
}

async function rows(
  client: DatabaseClient
): Promise<Array<{ key: string; hits: number; windowStart: number; sessionId: string | null }>> {
  const result = await client.query<{
    key: string;
    hits: number;
    windowStart: number;
    sessionId: string | null;
  }>(`SELECT key, hits, windowStart, sessionId FROM request_rate_limits`);
  return result.rows;
}

describe('Request rate limiting counted in the database', () => {
  it('allows the configured burst, then blocks until the window closes', async () => {
    const { client, repo } = await freshRepo();
    const service = limiter(repo);

    expect(await service.check('203.0.113.9', NOW)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
      // Nothing has been attributed to this client yet: the count happens before anything
      // proves which session is asking.
      sessionId: null
    });
    expect((await service.check('203.0.113.9', NOW + 10)).allowed).toBe(true);
    expect((await service.check('203.0.113.9', NOW + 20)).allowed).toBe(true);

    const blocked = await service.check('203.0.113.9', NOW + 1_000);
    expect(blocked.allowed).toBe(false);
    // The window opened with the first request, so what is left of it is what is reported.
    expect(blocked.retryAfterSeconds).toBe(59);

    // A blocked request must not extend the window it is blocked by.
    expect((await service.check('203.0.113.9', NOW + 30_000)).allowed).toBe(false);
    expect((await service.check('203.0.113.9', NOW + 60_001)).allowed).toBe(true);
    await client.close();
  });

  it('counts each client separately', async () => {
    const { client, repo } = await freshRepo();
    const service = limiter(repo);

    for (let i = 0; i < MAX; i += 1) {
      expect((await service.check('203.0.113.9', NOW)).allowed).toBe(true);
    }
    expect((await service.check('203.0.113.9', NOW)).allowed).toBe(false);

    // One client exhausting its allowance says nothing about another.
    expect((await service.check('198.51.100.7', NOW)).allowed).toBe(true);
    expect((await rows(client)).map((row) => row.key)).toHaveLength(2);
    await client.close();
  });

  it('shares one counter between limiter instances, which is what two processes are', async () => {
    const { client, repo } = await freshRepo();
    const first = limiter(repo);
    const second = limiter(repo);

    expect((await first.check('203.0.113.9', NOW)).allowed).toBe(true);
    expect((await first.check('203.0.113.9', NOW)).allowed).toBe(true);
    // The third request of the window arrives at the other process and still counts.
    expect((await second.check('203.0.113.9', NOW)).allowed).toBe(true);
    expect((await second.check('203.0.113.9', NOW)).allowed).toBe(false);
    expect((await first.check('203.0.113.9', NOW)).allowed).toBe(false);

    // Five requests were made — three allowed, then two refused — and a refused request is
    // still a request, so the row records what the client sent rather than what it got.
    expect((await rows(client)).reduce((total, row) => total + row.hits, 0)).toBe(5);
    await client.close();
  });

  it('keys the counter by a digest of the address, not the address', async () => {
    const { client, repo } = await freshRepo();
    await limiter(repo).check('203.0.113.9', NOW);

    const stored = await rows(client);
    expect(stored).toHaveLength(1);
    expect(stored[0].key).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(stored)).not.toContain('203.0.113.9');

    // The same client is the same key, which is what makes the count shared; a different
    // secret produces a different key, which is why the secret has to be the same one.
    const sameSecret = limiter(repo);
    await sameSecret.check('203.0.113.9', NOW);
    expect((await rows(client))[0].hits).toBe(2);

    const otherSecret = limiter(repo, { secret: 'a_different_secret_at_least_32_characters' });
    await otherSecret.check('203.0.113.9', NOW);
    expect((await rows(client)).map((row) => row.hits).sort()).toEqual([1, 2]);
    await client.close();
  });

  it('waits out the interval before sweeping closed windows', async () => {
    const { client, repo } = await freshRepo();
    const interval = 300_000;
    const service = new DatabaseRateLimiter({
      repo,
      max: MAX,
      windowMs: WINDOW_MS,
      secret: SECRET,
      pruneIntervalMs: interval
    });

    // Opens a window, and the first sweep runs (with nothing to drop) and claims the interval.
    await service.check('203.0.113.9', NOW);
    expect(await rows(client)).toHaveLength(1);

    // Long past the window, but too soon to sweep: the row stays, and rolls over in place.
    await service.check('203.0.113.9', NOW + 61_000);
    const rolled = await rows(client);
    expect(rolled).toHaveLength(1);
    expect(rolled[0].windowStart).toBe(NOW + 61_000);
    expect(rolled[0].hits).toBe(1);

    // A third window later the interval is due, and only the closed counter goes.
    const later = NOW + 61_000 + interval + 1;
    await service.check('198.51.100.7', later);
    const swept = await rows(client);
    expect(swept).toHaveLength(1);
    expect(swept[0].windowStart).toBe(later);
    await client.close();
  });

  it('names the session behind the requests it counted, and forgets it when the window rolls over', async () => {
    const { client, repo } = await freshRepo();
    const service = limiter(repo);

    // The count comes first and knows nothing about who asked; the name is written after.
    expect((await service.check('203.0.113.9', NOW)).sessionId).toBeNull();
    expect(await service.recordSession('203.0.113.9', 'sess_a', NOW)).toBe(true);
    expect((await rows(client))[0].sessionId).toBe('sess_a');

    // The next count reports what the row already says, which is what lets the caller skip a
    // write it does not need: one per device per window rather than one per request.
    expect((await service.check('203.0.113.9', NOW + 10)).sessionId).toBe('sess_a');

    // A second device behind the same address is now the one the row names.
    expect(await service.recordSession('203.0.113.9', 'sess_b', NOW + 20)).toBe(true);
    expect((await rows(client))[0].sessionId).toBe('sess_b');

    // A new window belongs to nobody until somebody is counted in it, so the previous
    // window's device is not carried forward as if it were still sending requests.
    expect((await service.check('203.0.113.9', NOW + 61_000)).sessionId).toBeNull();
    expect((await rows(client))[0].sessionId).toBeNull();

    // And a window that has closed is never named: it is about to be dropped, and a name on a
    // dead counter would read as a client that is still there.
    expect(await service.recordSession('203.0.113.9', 'sess_c', NOW + 200_000)).toBe(false);
    await client.close();
  });

  it('allows the request when the counter cannot be consulted', async () => {
    const unavailable = {
      count: async () => {
        throw new Error('database is gone');
      },
      recordSession: async () => {
        throw new Error('database is gone');
      }
    } as unknown as RateLimitRepository;

    const service = new DatabaseRateLimiter({
      repo: unavailable,
      max: MAX,
      windowMs: WINDOW_MS,
      secret: SECRET
    });

    // A limiter that cannot count must not become a blanket refusal: it reports the
    // request as allowed and says so in the log instead.
    await expect(service.check('203.0.113.9', NOW)).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
      sessionId: null
    });
    await expect(service.prune(NOW)).resolves.toBe(0);
    // Naming the session is best effort for the same reason: an authenticated request must
    // not fail because the row that counts it could not be stamped.
    await expect(service.recordSession('203.0.113.9', 'sess_a', NOW)).resolves.toBe(false);
  });
});
