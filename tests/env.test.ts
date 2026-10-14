import { describe, it, expect } from 'vitest';
import { assertSecureProductionConfig, validateEnv, envSchema } from '../src/config/env';

describe('Environment Configuration', () => {
  it('loads valid default values for development', () => {
    const parsed = validateEnv({});
    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.PORT).toBe(4000);
    expect(parsed.RATE_LIMIT_MAX).toBe(100);
    expect(parsed.APP_NAME).toBe('CoxBazarDoor2Door');
    // No proxy by default: the socket address is used and forwarded headers are ignored.
    expect(parsed.TRUST_PROXY).toBe('');
  });

  it('accepts a trusted proxy list and refuses one it cannot use', () => {
    expect(validateEnv({ TRUST_PROXY: 'loopback,10.0.0.0/8' }).TRUST_PROXY).toBe(
      'loopback,10.0.0.0/8'
    );
    // A typo must stop the boot rather than silently trusting nobody, or everybody.
    expect(() => validateEnv({ TRUST_PROXY: 'proxy.example.com' })).toThrow(
      /proxy\.example\.com/
    );
    expect(() => validateEnv({ TRUST_PROXY: '10.0.0.0/33' })).toThrow(/Invalid environment variables/);
  });

  it('accepts the three forwarded-header modes and refuses anything else', () => {
    expect(validateEnv({}).TRUSTED_FORWARD_HEADER).toBe('x-forwarded-for');
    expect(validateEnv({ TRUSTED_FORWARD_HEADER: 'forwarded' }).TRUSTED_FORWARD_HEADER).toBe(
      'forwarded'
    );
    expect(validateEnv({ TRUSTED_FORWARD_HEADER: 'both' }).TRUSTED_FORWARD_HEADER).toBe('both');
    // A near-miss is refused rather than silently read as "no header at all".
    expect(() => validateEnv({ TRUSTED_FORWARD_HEADER: 'xforwardedfor' })).toThrow(
      /TRUSTED_FORWARD_HEADER/
    );
  });

  it('coerces string port and rate limit to numbers', () => {
    const parsed = validateEnv({
      PORT: '8080',
      RATE_LIMIT_MAX: '250',
      JWT_SECRET: 'a_very_long_custom_secret_key_12345'
    });
    expect(parsed.PORT).toBe(8080);
    expect(parsed.RATE_LIMIT_MAX).toBe(250);
    expect(parsed.JWT_SECRET).toBe('a_very_long_custom_secret_key_12345');
  });

  it('throws on invalid NODE_ENV', () => {
    expect(() => validateEnv({ NODE_ENV: 'staging' })).toThrow(/Invalid environment variables/);
  });

  it('throws on too short JWT_SECRET when explicitly passed short string', () => {
    expect(() => validateEnv({ JWT_SECRET: 'short' })).toThrow(/Invalid environment variables/);
  });

  it('refuses a production boot that could not actually deliver OTPs', () => {
    const production = {
      NODE_ENV: 'production',
      JWT_SECRET: 'a_very_long_custom_secret_key_12345',
      ENCRYPTION_KEY: '1234567890123456789012345678901234',
      SMS_MOCK_MODE: 'false',
      SMS_PROVIDER: 'greenweb',
      GREENWEB_API_TOKEN: 'real-token'
    };

    expect(() => assertSecureProductionConfig(validateEnv(production))).not.toThrow();
    expect(() => assertSecureProductionConfig(validateEnv({ ...production, SMS_MOCK_MODE: 'true' }))).toThrow(
      /SMS_MOCK_MODE/
    );
    expect(() => assertSecureProductionConfig(validateEnv({ ...production, SMS_PROVIDER: 'none' }))).toThrow(
      /SMS_PROVIDER/
    );
    expect(() =>
      assertSecureProductionConfig(validateEnv({ ...production, GREENWEB_API_TOKEN: '' }))
    ).toThrow(/credential/);
  });
});