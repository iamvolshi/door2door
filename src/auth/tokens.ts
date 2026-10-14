import * as crypto from 'crypto';
import { UnauthorizedError } from '../core/errors';
import { env } from '../config/env';
import { UserRole } from '../db/schema';

export interface TokenPayload {
  userId: string;
  role: UserRole;
  email?: string;
  phone?: string;
  /**
   * The session this token belongs to. Access tokens carry it so the server can check the
   * session's state on every call, which is what makes a revocation take effect at once
   * instead of when the 15-minute token happens to expire. Tokens minted before sessions
   * were bound simply have no value here and are refused.
   */
  sessionId?: string;
  type: 'access' | 'refresh';
  iat?: number;
  exp?: number;
  iss?: string;
  jti?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

const DEFAULT_ISSUER = 'coxsbazar-door2door-auth';

/**
 * Single source of truth for the signing secret: the validated configuration.
 * (assertSecureProductionConfig rejects the development default in production.)
 */
function getJwtSecret(): string {
  return env.JWT_SECRET;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input: string): string {
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Generates a signed JWT token with HS256 signature.
 */
export function createToken(
  payload: Omit<TokenPayload, 'iat' | 'exp' | 'iss' | 'jti'>,
  expiresInSeconds: number,
  secret: string = getJwtSecret()
): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: TokenPayload = {
    ...payload,
    iss: DEFAULT_ISSUER,
    iat: now,
    exp: now + expiresInSeconds,
    jti: crypto.randomBytes(16).toString('hex')
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(signatureInput);
  const signature = base64UrlEncode(hmac.digest());

  return `${signatureInput}.${signature}`;
}

/**
 * Generates access and refresh token pair for authenticated sessions.
 *
 * `options.sessionId` stamps the session onto both tokens, so revoking it retires both.
 */
export function generateTokenPair(
  user: { id: string; role: UserRole; email?: string; phone?: string },
  accessExpiresInSeconds: number = 900, // 15 mins
  refreshExpiresInSeconds: number = 604800, // 7 days
  options: { sessionId?: string } = {}
): TokenPair {
  const accessToken = createToken(
    {
      userId: user.id,
      role: user.role,
      email: user.email,
      phone: user.phone,
      sessionId: options.sessionId,
      type: 'access'
    },
    accessExpiresInSeconds
  );

  const refreshToken = createToken(
    {
      userId: user.id,
      role: user.role,
      sessionId: options.sessionId,
      type: 'refresh'
    },
    refreshExpiresInSeconds
  );

  return {
    accessToken,
    refreshToken,
    expiresIn: accessExpiresInSeconds,
    tokenType: 'Bearer'
  };
}

/**
 * Verifies and decodes a signed JWT token.
 */
export function verifyToken<T extends TokenPayload = TokenPayload>(
  token: string,
  expectedType?: TokenPayload['type'],
  secret: string = getJwtSecret()
): T {
  if (!token || typeof token !== 'string') {
    throw new UnauthorizedError('Missing or invalid authentication token');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new UnauthorizedError('Malformed authentication token');
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  const signatureInput = `${headerB64}.${payloadB64}`;

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(signatureInput);
  const expectedSignature = base64UrlEncode(hmac.digest());

  try {
    const sigBuf = Buffer.from(signatureB64);
    const expBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      throw new UnauthorizedError('Invalid token signature');
    }
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError('Invalid token signature verification');
  }

  let payload: T;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64)) as T;
  } catch {
    throw new UnauthorizedError('Invalid token payload encoding');
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new UnauthorizedError('Authentication token has expired');
  }

  if (expectedType && payload.type !== expectedType) {
    throw new UnauthorizedError(`Invalid token type: expected ${expectedType}, got ${payload.type}`);
  }

  // The signature proves *someone with the secret* minted this, and the issuer says who
  // that someone claims to be. A token that verifies but names another issuer — a JWT from
  // a different service that happens to share a secret, or a forged payload stitched onto
  // a real signature — is refused rather than trusted.
  if (payload.iss !== DEFAULT_ISSUER) {
    throw new UnauthorizedError('Invalid token issuer');
  }

  return payload;
}

/**
 * Decodes a token without verifying signature.
 */
export function decodeToken<T = TokenPayload>(token: string): T | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(base64UrlDecode(parts[1])) as T;
  } catch {
    return null;
  }
}
