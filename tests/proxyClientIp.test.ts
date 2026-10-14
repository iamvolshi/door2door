import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SEEDED,
  createTempDatabaseDir,
  postJson,
  removeTempDatabaseDir,
  startServer,
  type RunningServer
} from './apiTestClient';

/**
 * The API behind a reverse proxy: every real request arrives from the proxy's address, so
 * both the rate-limit bucket and the audit trail are only as good as the decision about
 * which forwarded address to believe.
 */
let tempDir: string;
/** No proxy configured: the forwarded header must change nothing at all. */
let noProxy: RunningServer;
/** A proxy on the same host: the forwarded header decides the client. */
let behindLoopback: RunningServer;
/** Room to spare for the audit assertions, which must not trip the limiter. */
let recording: RunningServer;

const CLIENT = '203.0.113.9';
const OTHER_CLIENT = '198.51.100.7';

/** Any route works: it is rejected for a missing token after the limiter has counted it. */
async function quote(target: RunningServer, forwarded?: string): Promise<number> {
  const response = await postJson(
    target,
    '/api/v1/orders/quote',
    {},
    forwarded === undefined ? {} : { headers: { 'x-forwarded-for': forwarded } }
  );
  return response.status;
}

beforeAll(async () => {
  tempDir = createTempDatabaseDir();
  noProxy = await startServer({
    port: 0,
    host: '127.0.0.1',
    databaseFile: `${tempDir}/no-proxy.sqlite`,
    rateLimit: { max: 3, windowMs: 60000 }
  });
  behindLoopback = await startServer({
    port: 0,
    host: '127.0.0.1',
    databaseFile: `${tempDir}/loopback.sqlite`,
    rateLimit: { max: 3, windowMs: 60000 },
    trustProxy: 'loopback'
  });
  recording = await startServer({
    port: 0,
    host: '127.0.0.1',
    databaseFile: `${tempDir}/recording.sqlite`,
    rateLimit: { max: 100, windowMs: 60000 },
    trustProxy: 'loopback'
  });
});

afterAll(async () => {
  await noProxy?.close();
  await behindLoopback?.close();
  await recording?.close();
  removeTempDatabaseDir(tempDir);
});

describe('Client addresses when the API sits behind a reverse proxy', () => {
  it('does not let an unconfigured header split the rate-limit bucket', async () => {
    // Four requests, four different claimed clients, one socket address: one bucket.
    expect(await quote(noProxy, '203.0.113.9')).toBe(401);
    expect(await quote(noProxy, '198.51.100.7')).toBe(401);
    expect(await quote(noProxy, '203.0.113.10')).toBe(401);
    expect(await quote(noProxy, '203.0.113.11')).toBe(429);

    // Spoofing the header is not a way to reset a limit, and no header is not one either.
    expect(await quote(noProxy, '203.0.113.12')).toBe(429);
    expect(await quote(noProxy)).toBe(429);
  });

  it('limits each forwarded client separately when the proxy is trusted', async () => {
    // The claim on the left is discarded; what the proxy observed is what counts.
    expect(await quote(behindLoopback, `1.2.3.4, ${CLIENT}`)).toBe(401);
    expect(await quote(behindLoopback, `5.6.7.8, ${CLIENT}`)).toBe(401);
    expect(await quote(behindLoopback, CLIENT)).toBe(401);

    // Same client, exhausted — the left-hand claims above shared this bucket.
    expect(await quote(behindLoopback, CLIENT)).toBe(429);
    expect(await quote(behindLoopback, `9.9.9.9, ${CLIENT}`)).toBe(429);

    // A genuinely different client is unaffected by the first one's spending.
    expect(await quote(behindLoopback, OTHER_CLIENT)).toBe(401);
  });

  it('records the proven client, not the proxy, in the security trail', async () => {
    const forwarded = '203.0.113.200';
    const otpRequest = await postJson(
      recording,
      '/api/v1/auth/otp/request',
      { phone: SEEDED.customer.phone },
      { headers: { 'x-forwarded-for': forwarded } }
    );
    expect(otpRequest.status).toBe(200);

    const verify = await postJson(
      recording,
      '/api/v1/auth/otp/verify',
      { phone: SEEDED.customer.phone, otp: otpRequest.body.devOtp },
      { headers: { 'x-forwarded-for': forwarded } }
    );
    expect(verify.status).toBe(200);

    // The delivery trail answers "did the code leave, and to whom does it belong?" — the
    // proxy's address would make that unanswerable.
    const deliveries = await recording.client.query<{ ipAddress: string | null }>(
      'SELECT ipAddress FROM otp_deliveries WHERE phone = ?',
      [SEEDED.customer.phone]
    );
    expect(deliveries.rows.map((row) => row.ipAddress)).toEqual([forwarded]);

    // The session row is what a customer is told about when a family is burned.
    const sessions = await recording.client.query<{ ipAddress: string | null }>(
      'SELECT ipAddress FROM auth_sessions WHERE userId = ?',
      [SEEDED.customer.id]
    );
    expect(sessions.rows.map((row) => row.ipAddress)).toEqual([forwarded]);
  });

  it('falls back to the peer when the forwarded header proves nothing', async () => {
    // Junk is neither stored nor believed: the value a caller typed never becomes the
    // address recorded against its own request.
    const junk = await postJson(
      recording,
      '/api/v1/auth/otp/request',
      { phone: SEEDED.driver.phone },
      { headers: { 'x-forwarded-for': 'not-an-address, <script>' } }
    );
    expect(junk.status).toBe(200);

    const deliveries = await recording.client.query<{ ipAddress: string | null }>(
      'SELECT ipAddress FROM otp_deliveries WHERE phone = ?',
      [SEEDED.driver.phone]
    );
    expect(deliveries.rows.map((row) => row.ipAddress)).toEqual(['127.0.0.1']);

    // And a request with no header at all is attributed to the peer.
    const bare = await postJson(recording, '/api/v1/auth/otp/request', {
      phone: SEEDED.merchant.phone
    });
    expect(bare.status).toBe(200);

    const bareDeliveries = await recording.client.query<{ ipAddress: string | null }>(
      'SELECT ipAddress FROM otp_deliveries WHERE phone = ?',
      [SEEDED.merchant.phone]
    );
    expect(bareDeliveries.rows.map((row) => row.ipAddress)).toEqual(['127.0.0.1']);
  });
});
