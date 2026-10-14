import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTempDatabaseDir,
  removeTempDatabaseDir,
  startServer,
  type RunningServer
} from './apiTestClient';

/**
 * A 429 names its wait twice: `error.details.retryAfterSeconds` for clients that read
 * JSON, and the standard `Retry-After` response header for HTTP stacks — mobile
 * networking layers included — that back off without parsing the body. Both must agree.
 */
let tempDir: string;
const servers: RunningServer[] = [];

async function boot(name: string, max: number): Promise<RunningServer> {
  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    databaseFile: `${tempDir}/${name}.sqlite`,
    rateLimit: { max, windowMs: 60000 }
  });
  servers.push(server);
  return server;
}

async function rawPost(
  target: RunningServer,
  path: string,
  body: unknown
): Promise<{ status: number; headers: Headers; body: any }> {
  const response = await fetch(`${target.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

beforeAll(() => {
  tempDir = createTempDatabaseDir();
});

afterAll(async () => {
  for (const server of servers) {
    await server?.close();
  }
  removeTempDatabaseDir(tempDir);
});

describe('Retry-After on throttled responses', () => {
  it('sends a Retry-After header that agrees with the body on the global rate limit', async () => {
    const app = await boot('global-limit', 4);
    let last = await rawPost(app, '/api/v1/auth/otp/request', {});
    for (let i = 0; i < 4; i += 1) {
      last = await rawPost(app, '/api/v1/auth/otp/request', {});
    }
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    const fromBody = last.body.error.details.retryAfterSeconds;
    expect(fromBody).toBeGreaterThan(0);
    expect(last.headers.get('retry-after')).toBe(String(fromBody));
  });

  it('names the OTP resend wait in details and in the header', async () => {
    const app = await boot('otp-cooldown', 100);
    const phone = '+8801900000001';
    const first = await rawPost(app, '/api/v1/auth/otp/request', { phone });
    expect(first.status).toBe(200);
    const second = await rawPost(app, '/api/v1/auth/otp/request', { phone });
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    const fromBody = second.body.error.details.retryAfterSeconds;
    expect(fromBody).toBeGreaterThan(0);
    expect(second.headers.get('retry-after')).toBe(String(fromBody));
  });
});
