import { describe, it, expect, vi } from 'vitest';
import { Logger, scrubSensitiveData, StructuredLogEntry } from '../src/core/logger';
import { ValidationError } from '../src/core/errors';

describe('Structured Logger & Scrubbing', () => {
  it('scrubs sensitive credentials and tokens recursively', () => {
    const payload = {
      user: 'test_user',
      password: 'supersecretpassword',
      auth: {
        token: 'jwt.token.here',
        apiKey: 'api-secret-123'
      },
      profile: {
        email: 'user@coxsbazar.com',
        phone_number: '+8801700000000'
      }
    };

    const scrubbed = scrubSensitiveData(payload);
    expect(scrubbed.password).toBe('[REDACTED]');
    expect(scrubbed.auth.token).toBe('[REDACTED]');
    expect(scrubbed.auth.apiKey).toBe('[REDACTED]');
    expect(scrubbed.profile.phone_number).toBe('[REDACTED]');
    expect(scrubbed.user).toBe('test_user');
    expect(scrubbed.profile.email).toBe('user@coxsbazar.com');
  });

  it('outputs structured JSON messages to stream', () => {
    const output: string[] = [];
    const loggerInstance = new Logger('debug', (line) => output.push(line));

    loggerInstance.info('Order placed successfully', { orderId: 'ORD-123' });
    expect(output.length).toBe(1);

    const parsed = JSON.parse(output[0]) as StructuredLogEntry;
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('Order placed successfully');
    expect(parsed.context?.orderId).toBe('ORD-123');
    expect(parsed.timestamp).toBeDefined();
  });

  it('invokes telemetry hooks when error level is logged', () => {
    const telemetrySpy = vi.fn();
    const loggerInstance = new Logger('info', () => {});
    loggerInstance.addTelemetryHook(telemetrySpy);

    const valErr = new ValidationError('Invalid parcel weight', { max: 10 });
    loggerInstance.error('Failed to create delivery task', valErr, { customerId: 'CUST-001' });

    expect(telemetrySpy).toHaveBeenCalledTimes(1);
    const callArg = telemetrySpy.mock.calls[0][0] as StructuredLogEntry;
    expect(callArg.level).toBe('error');
    expect(callArg.message).toBe('Failed to create delivery task');
    expect(callArg.error?.code).toBe('VALIDATION_ERROR');
    expect(callArg.context?.customerId).toBe('CUST-001');
  });
});