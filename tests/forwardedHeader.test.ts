import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { logger, type StructuredLogEntry } from '../src/core/logger';
import {
  createTempDatabaseDir,
  postJson,
  removeTempDatabaseDir,
  startServer,
  type RunningServer
} from './apiTestClient';

/**
 * Which header carries the client, and what happens when a deployment maintains the RFC
 * 7239 one, through the running API. Every assertion here is about *buckets*, because the
 * rate limiter is where an address choice becomes observable without reading logs.
 */
let tempDir: string;
const booted: RunningServer[] = [];

/** A proxy on the same host, a small burst so a bucket is cheap to exhaust. */
async function boot(name: string, header: string, max = 2): Promise<RunningServer> {
  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    databaseFile: `${tempDir}/${name}.sqlite`,
    trustProxy: 'loopback',
    trustedForwardHeader: header,
    rateLimit: { max, windowMs: 60000 }
  });
  booted.push(server);
  return server;
}

/** Any route works: it is rejected for a missing token after the limiter has counted it. */
function quote(
  target: RunningServer,
  headers: Record<string, string> = {}
): Promise<number> {
  return postJson(target, '/api/v1/orders/quote', {}, { headers }).then(
    (response) => response.status
  );
}

beforeAll(() => {
  tempDir = createTempDatabaseDir();
});

afterAll(async () => {
  for (const server of booted) {
    await server?.close();
  }
  removeTempDatabaseDir(tempDir);
});

describe('RFC 7239 Forwarded as the maintained header', () => {
  it('counts the client the RFC header names, and ignores X-Forwarded-For', async () => {
    const server = await boot('forwarded', 'forwarded');
    const rfc = { forwarded: 'for=203.0.113.9;proto=https;host=orders.example' };

    expect(await quote(server, rfc)).toBe(401);
    expect(await quote(server, rfc)).toBe(401);
    // The bucket is the one the RFC header named...
    expect(await quote(server, rfc)).toBe(429);

    // ...and a request that only has the legacy header is a different client entirely,
    // which is the point of declaring which header the proxies maintain.
    expect(await quote(server, { 'x-forwarded-for': '198.51.100.7' })).toBe(401);
    // It landed in the peer's bucket, not a new one: one more bare request exhausts it.
    expect(await quote(server)).toBe(401);
    expect(await quote(server)).toBe(429);
  });

  it('still refuses to read any header from an untrusted peer', async () => {
    // No trusted proxy configured, so the forwarded header means nothing and every
    // request is counted as the peer.
    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile: `${tempDir}/untrusted.sqlite`,
      trustedForwardHeader: 'forwarded',
      rateLimit: { max: 2, windowMs: 60000 }
    });
    booted.push(server);

    expect(await quote(server, { forwarded: 'for=203.0.113.9' })).toBe(401);
    expect(await quote(server, { forwarded: 'for=198.51.100.7' })).toBe(401);
    expect(await quote(server, { forwarded: 'for=203.0.113.10' })).toBe(429);
  });
});

describe('Both headers maintained at once', () => {
  it('uses the agreed client when the two headers agree', async () => {
    const server = await boot('agree', 'both');
    const agreed = { forwarded: 'for=203.0.113.9', 'x-forwarded-for': '203.0.113.9' };

    expect(await quote(server, agreed)).toBe(401);
    expect(await quote(server, { 'x-forwarded-for': '203.0.113.9' })).toBe(401);
    expect(await quote(server, agreed)).toBe(429);
  });

  it('believes neither and counts the peer when they disagree', async () => {
    const server = await boot('conflict', 'both');
    const conflicting = { forwarded: 'for=198.51.100.7', 'x-forwarded-for': '203.0.113.9' };

    // Two requests that name two different clients, then a bare request: if the conflicting
    // pair had been counted as either claimant, the peer's bucket would still be empty.
    expect(await quote(server, conflicting)).toBe(401);
    expect(await quote(server, conflicting)).toBe(401);
    expect(await quote(server)).toBe(429);

    // And neither claimant was charged for them: each still has a window of its own.
    expect(await quote(server, { forwarded: 'for=198.51.100.7' })).toBe(401);
    expect(await quote(server, { 'x-forwarded-for': '203.0.113.9' })).toBe(401);
  });

  it('does not let a client invent the RFC header when the default mode is in force', async () => {
    const server = await boot('legacy-default', 'x-forwarded-for');
    const decoy = { forwarded: 'for=1.2.3.4', 'x-forwarded-for': '203.0.113.9' };

    expect(await quote(server, decoy)).toBe(401);
    expect(await quote(server, decoy)).toBe(401);
    // The legacy header is the one that counted, so it is the one that is now exhausted.
    expect(await quote(server, { 'x-forwarded-for': '203.0.113.9' })).toBe(429);

    // A Forwarded header the proxies do not maintain buys a caller nothing: two requests
    // naming themselves through it are counted where a bare request would be counted, and
    // the third request in that bucket is refused.
    expect(await quote(server, { forwarded: 'for=203.0.113.11' })).toBe(401);
    expect(await quote(server, { forwarded: 'for=203.0.113.12' })).toBe(401);
    expect(await quote(server)).toBe(429);
  });
});

describe('What the trusted hop disclosed about the connection', () => {
  it('reports the protocol and host it was told, and nothing when it was told nothing', async () => {
    const server = await boot('disclosure', 'forwarded', 100);
    const captured: StructuredLogEntry[] = [];
    logger.setOutputStream((line: string) => {
      captured.push(JSON.parse(line) as StructuredLogEntry);
    });

    try {
      captured.length = 0;
      await quote(server, { forwarded: 'for=203.0.113.9;proto=https;host=orders.example' });
      const disclosed = captured.filter((entry) => entry.message === 'Request completed');
      expect(disclosed).toHaveLength(1);
      expect(disclosed[0].context).toMatchObject({
        protocol: 'https',
        host: 'orders.example'
      });

      captured.length = 0;
      await quote(server, {});
      const bare = captured.filter((entry) => entry.message === 'Request completed');
      expect(bare).toHaveLength(1);
      // Absent, not empty: a direct request has no disclosed scheme to report.
      expect(bare[0].context).not.toHaveProperty('protocol');
      expect(bare[0].context).not.toHaveProperty('host');
    } finally {
      logger.setOutputStream((line: string) => console.log(line));
    }
  });
});
