import { describe, it, expect, beforeEach } from 'vitest';
import { hashPassword, verifyPassword, validatePasswordStrength } from '../src/auth/password';
import { generateTokenPair, createToken, verifyToken, decodeToken } from '../src/auth/tokens';
import { phoneAuth, normalizePhoneNumber } from '../src/auth/phoneAuth';
import { hasPermission, assertPermission, assertRole, ROLE_PERMISSIONS } from '../src/auth/rbac';
import { maskPhoneNumber, maskAddress, sanitizeCustomerData } from '../src/auth/pii';
import { UnauthorizedError, ForbiddenError, RateLimitError, ValidationError } from '../src/core/errors';

describe('Authentication & Authorization Security Suite', () => {
  describe('Password Hashing & Verification (scrypt)', () => {
    it('should validate password strength correctly', () => {
      const weak = validatePasswordStrength('weak');
      expect(weak.valid).toBe(false);
      expect(weak.reasons.length).toBeGreaterThan(0);

      const strong = validatePasswordStrength('SecureP@ssw0rd2025');
      expect(strong.valid).toBe(true);
      expect(strong.reasons).toHaveLength(0);
    });

    it('should securely hash password and verify valid match', async () => {
      const plain = 'StrongP@ss123';
      const hash = await hashPassword(plain);
      
      expect(hash).toMatch(/^scrypt:v1:/);
      const isValid = await verifyPassword(plain, hash);
      expect(isValid).toBe(true);
    });

    it('should reject incorrect password and corrupted hashes', async () => {
      const hash = await hashPassword('CorrectPassword1!');
      const isWrong = await verifyPassword('WrongPassword1!', hash);
      expect(isWrong).toBe(false);

      const corrupted = await verifyPassword('CorrectPassword1!', 'invalid:hash:format');
      expect(corrupted).toBe(false);
    });
  });

  describe('Token Generation, Claims & Verification (JWT)', () => {
    it('should generate valid access and refresh token pairs', () => {
      const tokens = generateTokenPair({
        id: 'usr-123',
        role: 'CUSTOMER',
        email: 'customer@coxsbazar.test'
      });

      expect(tokens.accessToken).toBeDefined();
      expect(tokens.refreshToken).toBeDefined();
      expect(tokens.tokenType).toBe('Bearer');

      const verifiedAccess = verifyToken(tokens.accessToken, 'access');
      expect(verifiedAccess.userId).toBe('usr-123');
      expect(verifiedAccess.role).toBe('CUSTOMER');
      expect(verifiedAccess.type).toBe('access');

      const verifiedRefresh = verifyToken(tokens.refreshToken, 'refresh');
      expect(verifiedRefresh.userId).toBe('usr-123');
      expect(verifiedRefresh.type).toBe('refresh');
    });

    it('should reject expired tokens', async () => {
      const expiredToken = createToken(
        { userId: 'usr-exp', role: 'DRIVER', type: 'access' },
        -10 // Expired 10 seconds ago
      );

      expect(() => verifyToken(expiredToken, 'access')).toThrow(UnauthorizedError);
    });

    it('should reject tampered token signatures', () => {
      const token = createToken({ userId: 'usr-test', role: 'MERCHANT', type: 'access' }, 300);
      const parts = token.split('.');
      const tamperedPayload = Buffer.from(JSON.stringify({ userId: 'usr-hacked', role: 'ADMIN' })).toString('base64');
      const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      expect(() => verifyToken(tamperedToken)).toThrow(UnauthorizedError);
    });
  });

  describe('Phone OTP Authentication Flow', () => {
    beforeEach(() => {
      phoneAuth.clear();
    });

    it('should normalize Bangladeshi phone numbers into E.164 format', () => {
      expect(normalizePhoneNumber('01712345678')).toBe('+8801712345678');
      expect(normalizePhoneNumber('8801812345678')).toBe('+8801812345678');
      expect(normalizePhoneNumber('+8801912345678')).toBe('+8801912345678');
      expect(() => normalizePhoneNumber('12345')).toThrow(ValidationError);
    });

    it('should issue and verify valid OTP code', async () => {
      const phone = '01711223344';
      const { otp } = await phoneAuth.requestOtp(phone);
      expect(otp).toHaveLength(6);

      const isVerified = await phoneAuth.verifyOtp(phone, otp);
      expect(isVerified).toBe(true);
    });

    it('should enforce cooldown rate limiting on rapid requests', async () => {
      const phone = '01811223344';
      await phoneAuth.requestOtp(phone);
      
      await expect(phoneAuth.requestOtp(phone)).rejects.toThrow(RateLimitError);
    });

    it('should invalidate OTP after exceeding maximum failed attempts', async () => {
      const phone = '01911223344';
      await phoneAuth.requestOtp(phone);

      expect(await phoneAuth.verifyOtp(phone, '000000')).toBe(false);
      expect(await phoneAuth.verifyOtp(phone, '111111')).toBe(false);
      expect(await phoneAuth.verifyOtp(phone, '222222')).toBe(false);
      
      // 4th attempt exceeds max attempts (3)
      await expect(phoneAuth.verifyOtp(phone, '333333')).rejects.toThrow(RateLimitError);
    });
  });

  describe('Role-Based Access Control (RBAC)', () => {
    it('should correctly authorize customer permissions', () => {
      expect(hasPermission('CUSTOMER', 'order:create')).toBe(true);
      expect(hasPermission('CUSTOMER', 'order:read:own')).toBe(true);
      expect(hasPermission('CUSTOMER', 'order:manage:all')).toBe(false);
      expect(hasPermission('CUSTOMER', 'pii:read:full')).toBe(false);
    });

    it('should correctly authorize merchant & driver permissions', () => {
      expect(hasPermission('MERCHANT', 'catalog:manage:merchant')).toBe(true);
      expect(hasPermission('MERCHANT', 'order:update:driver')).toBe(false);

      expect(hasPermission('DRIVER', 'order:accept:driver')).toBe(true);
      expect(hasPermission('DRIVER', 'catalog:manage:merchant')).toBe(false);
    });

    it('should give admin role complete privileges', () => {
      for (const perm of ROLE_PERMISSIONS.ADMIN) {
        expect(hasPermission('ADMIN', perm)).toBe(true);
      }
    });

    it('should throw ForbiddenError when permission assertion fails', () => {
      expect(() => assertPermission('CUSTOMER', 'order:manage:all')).toThrow(ForbiddenError);
      expect(() => assertRole('CUSTOMER', ['ADMIN', 'MERCHANT'])).toThrow(ForbiddenError);
    });
  });

  describe('PII Masking & Privacy Layer', () => {
    const rawPhone = '+8801712345678';
    const address = {
      id: 'addr-1',
      streetAddress: 'House 14, Road 5, Block B, Kolatoli',
      area: 'Kolatoli',
      city: 'Cox\'s Bazar'
    };

    it('should mask phone number for non-admin viewers', () => {
      const maskedForDriver = maskPhoneNumber(rawPhone, 'DRIVER');
      expect(maskedForDriver).toBe('+8801****678');

      const fullForAdmin = maskPhoneNumber(rawPhone, 'ADMIN');
      expect(fullForAdmin).toBe(rawPhone);
    });

    it('should mask address details for unauthorized viewers', () => {
      const masked = maskAddress(address, 'CUSTOMER', false);
      expect(masked.streetAddress).toBe('*** Masked for privacy ***');
      expect(masked.area).toBe('Kolatoli');
      expect(masked.city).toBe('Cox\'s Bazar');

      const full = maskAddress(address, 'DRIVER', true);
      expect(full.streetAddress).toBe('House 14, Road 5, Block B, Kolatoli');
    });

    it('should sanitize full customer payload preserving unmasked data only for admin or owner', () => {
      const profile = {
        id: 'usr-99',
        fullName: 'Rahim Uddin',
        phone: '+8801712345678',
        email: 'rahim@example.com',
        passwordHash: 'scrypt:secret',
        role: 'CUSTOMER' as const
      };

      const driverView = sanitizeCustomerData(profile, 'DRIVER', false);
      expect(driverView.phone).toBe('+8801****678');
      expect(driverView.email).toBe('ra***@example.com');
      expect(driverView.passwordHash).toBeUndefined();

      const ownView = sanitizeCustomerData(profile, 'CUSTOMER', true);
      expect(ownView.phone).toBe('+8801712345678');
      expect(ownView.email).toBe('rahim@example.com');
    });
  });
});
