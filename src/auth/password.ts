import * as crypto from 'crypto';
import { ValidationError } from '../core/errors';

const SCRYPT_KEYLEN = 64;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_LENGTH = 16;

export interface PasswordStrengthResult {
  valid: boolean;
  reasons: string[];
}

/**
 * Validates password strength according to security standards.
 * Requires at least 8 characters, an uppercase letter, a lowercase letter, and a number.
 */
export function validatePasswordStrength(password: string): PasswordStrengthResult {
  const reasons: string[] = [];
  if (!password || password.length < 8) {
    reasons.push('Password must be at least 8 characters long');
  }
  if (password && password.length > 128) {
    reasons.push('Password must not exceed 128 characters');
  }
  if (!/[A-Z]/.test(password)) {
    reasons.push('Password must contain at least one uppercase letter');
  }
  if (!/[a-z]/.test(password)) {
    reasons.push('Password must contain at least one lowercase letter');
  }
  if (!/[0-9]/.test(password)) {
    reasons.push('Password must contain at least one numeric digit');
  }

  return {
    valid: reasons.length === 0,
    reasons
  };
}

/**
 * Hashes a plaintext password securely using scrypt with random salt.
 * Format: scrypt:v1:N:r:p:saltHex:hashHex
 */
export async function hashPassword(password: string): Promise<string> {
  if (!password || typeof password !== 'string') {
    throw new ValidationError('Invalid password provided for hashing');
  }

  return new Promise<string>((resolve, reject) => {
    const salt = crypto.randomBytes(SALT_LENGTH);
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (err, derivedKey) => {
        if (err) return reject(err);
        const saltHex = salt.toString('hex');
        const hashHex = derivedKey.toString('hex');
        resolve(`scrypt:v1:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${saltHex}:${hashHex}`);
      }
    );
  });
}

/**
 * Verifies a plaintext password against a stored scrypt hash in constant time.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!password || !storedHash || typeof storedHash !== 'string') {
    return false;
  }

  const parts = storedHash.split(':');
  if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== 'v1') {
    return false;
  }

  const n = parseInt(parts[2], 10);
  const r = parseInt(parts[3], 10);
  const p = parseInt(parts[4], 10);
  const salt = Buffer.from(parts[5], 'hex');
  const expectedHash = Buffer.from(parts[6], 'hex');

  return new Promise<boolean>((resolve) => {
    crypto.scrypt(
      password,
      salt,
      expectedHash.length,
      { N: n, r, p },
      (err, derivedKey) => {
        if (err) {
          return resolve(false);
        }
        try {
          const match = crypto.timingSafeEqual(derivedKey, expectedHash);
          resolve(match);
        } catch {
          resolve(false);
        }
      }
    );
  });
}
