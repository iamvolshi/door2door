import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createToken, verifyToken } from '../src/auth/tokens';
import { env } from '../src/config/env';

/**
 * The signature proves someone with the secret minted the token; the issuer check
 * proves that someone was *this* service. A token that verifies but names another
 * issuer — a JWT from a different service sharing a secret, or a payload stitched
 * onto a real signature — must be refused.
 */
function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function forge(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = base64UrlEncode(
    crypto.createHmac('sha256', env.JWT_SECRET).update(`${header}.${body}`).digest()
  );
  return `${header}.${body}.${signature}`;
}

const now = Math.floor(Date.now() / 1000);

describe('token issuer verification', () => {
  it('accepts a token this service minted', () => {
    const token = createToken({ userId: 'usr_x', role: 'CUSTOMER', type: 'access' }, 300);
    expect(verifyToken(token, 'access').userId).toBe('usr_x');
  });

  it('refuses a correctly signed token that names another issuer', () => {
    const forged = forge({
      userId: 'usr_x',
      role: 'CUSTOMER',
      type: 'access',
      iss: 'another-service',
      iat: now,
      exp: now + 300
    });
    expect(() => verifyToken(forged, 'access')).toThrow('Invalid token issuer');
  });

  it('refuses a correctly signed token with no issuer at all', () => {
    const forged = forge({ userId: 'usr_x', role: 'CUSTOMER', type: 'access', iat: now, exp: now + 300 });
    expect(() => verifyToken(forged, 'access')).toThrow('Invalid token issuer');
  });
});
