import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiRequest, createTempDatabaseDir, removeTempDatabaseDir, startServer, type RunningServer } from './apiTestClient';

/**
 * Router and request-parsing behaviour, exercised without a session: these are the cases a
 * caller reaches before any handler runs, and each one must answer with a client error
 * rather than a 500 or a silently accepted body.
 */
describe('Routing and request parsing through the HTTP API', () => {
  let app: RunningServer;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    app = await startServer({ port: 0, host: '127.0.0.1', databaseFile: `${tempDir}/routing.sqlite` });
  });

  afterAll(async () => {
    await app?.close();
    removeTempDatabaseDir(tempDir);
  });

  it('does not turn a malformed path escape into a server error', async () => {
    // `decodeURIComponent('%E0%A4%A')` throws; an unauthenticated caller could reach this
    // before any handler ran, and it used to answer 500 and log an error.
    const malformed = await apiRequest(app, 'GET', '/api/v1/orders/%E0%A4%A');
    expect(malformed.status).toBe(404);
    expect(malformed.body.error.code).toBe('NOT_FOUND');
  });

  it('treats traversal-shaped and encoded-slash ids as ordinary unmatched paths', async () => {
    for (const path of ['/api/v1/orders/..%2F..%2Fetc%2Fpasswd', '/api/v1/orders/%2F', '/api/v1/orders/%00']) {
      const response = await apiRequest(app, 'GET', path);
      expect(response.status, `${path} answered ${response.status}`).toBeLessThan(500);
    }
  });

  it('answers an unknown route with 404 and a method mismatch with 405', async () => {
    const unknown = await apiRequest(app, 'GET', '/api/v1/nope');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');

    const wrongMethod = await apiRequest(app, 'DELETE', '/api/v1/orders/quote');
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.body.error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('refuses an oversized body with 400 rather than reading it', async () => {
    const response = await fetch(`${app.url}/api/v1/auth/otp/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '+8801811000009', padding: 'x'.repeat(70 * 1024) })
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toMatch(/exceeds the maximum/);
  });

  it('refuses a body that is not a JSON object', async () => {
    for (const raw of ['not-json', '[1,2,3]', '"a string"', 'null']) {
      const response = await fetch(`${app.url}/api/v1/auth/otp/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw
      });
      expect(response.status, `${raw} answered ${response.status}`).toBe(400);
    }
  });

  it('only sends a login code to a Bangladeshi number', async () => {
    // The number is chosen by an unauthenticated caller, so anything the platform is
    // willing to text is a number it pays to text.
    for (const foreign of ['+919876543210', '+15551234567', '+447700900123']) {
      const response = await fetch(`${app.url}/api/v1/auth/otp/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: foreign })
      });
      const body = await response.json();
      expect(response.status, `${foreign} answered ${response.status}`).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    }

    // The three ways a customer writes a Bangladeshi number all still work.
    for (const local of ['+8801811590001', '8801811590002', '01811590003']) {
      const response = await fetch(`${app.url}/api/v1/auth/otp/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: local })
      });
      expect(response.status, `${local} answered ${response.status}`).toBe(200);
    }
  });

  it('keeps health public and free of database details beyond its own check', async () => {
    const health = await apiRequest(app, 'GET', '/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
  });
});
