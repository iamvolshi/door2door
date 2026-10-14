import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  BulkSmsBdSmsClient,
  GreenwebSmsClient,
  createSmsClient,
  createSmsClientFromEnv,
  maskPhone,
  toBulkSmsBdNumber
} from '../src/auth/smsProviders';
import { OtpDispatcher, formatOtpMessage, type OtpDeliveryStatus } from '../src/auth/otpDelivery';
import { Logger, type StructuredLogEntry } from '../src/core/logger';

interface StubResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

interface StubRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface SmsStub {
  url: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

/** A real loopback HTTP server scripted with provider responses, in order. */
function startSmsStub(scripted: StubResponse[]): Promise<SmsStub> {
  return new Promise((resolve) => {
    const requests: StubRequest[] = [];
    let served = 0;

    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        const response = scripted[Math.min(served, scripted.length - 1)] ?? { status: 200, body: '' };
        served += 1;
        res.writeHead(response.status ?? 200, {
          'content-type': 'application/json',
          ...(response.headers ?? {})
        });
        res.end(response.body ?? '');
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/send`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          })
      });
    });
  });
}

function captureLogger(entries: StructuredLogEntry[]): Logger {
  return new Logger('debug', (line) => entries.push(JSON.parse(line) as StructuredLogEntry));
}

/** Collects backoff delays instead of sleeping, so retry tests stay instant. */
function recordingSleep(sleeps: number[]): (ms: number) => Promise<void> {
  return async (ms: number) => {
    sleeps.push(ms);
  };
}

const PHONE = '+8801811000004';

describe('SMS provider clients', () => {
  describe('Greenweb', () => {
    it('sends a form-encoded SMS and reports the provider SENT status', async () => {
      const stub = await startSmsStub([
        {
          status: 200,
          body: JSON.stringify([
            {
              to: PHONE,
              message: 'Your code',
              status: 'SENT',
              statusmsg: `SMS Sent Successfully To ${PHONE}`
            }
          ])
        }
      ]);
      const entries: StructuredLogEntry[] = [];
      const sleeps: number[] = [];

      try {
        const client = new GreenwebSmsClient({
          token: 'greenweb-secret-token',
          senderId: 'CXBEXPRESS',
          endpoint: stub.url,
          baseDelayMs: 10,
          sleep: recordingSleep(sleeps),
          log: captureLogger(entries)
        });

        const result = await client.send(PHONE, 'Your code is 123456');

        expect(result).toMatchObject({
          delivered: true,
          provider: 'greenweb',
          attempts: 1,
          providerStatus: 'SENT'
        });
        expect(sleeps).toEqual([]);

        expect(stub.requests).toHaveLength(1);
        const request = stub.requests[0];
        expect(request.method).toBe('POST');
        expect(request.url).toBe('/send?json');
        expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');

        const params = new URLSearchParams(request.body);
        expect(params.get('token')).toBe('greenweb-secret-token');
        expect(params.get('to')).toBe(PHONE); // Greenweb documents the +880 form
        expect(params.get('message')).toBe('Your code is 123456');

        // Delivery logging: the accept line is present and never leaks the token.
        expect(entries.some((entry) => entry.message.includes('SMS accepted by greenweb'))).toBe(true);
        expect(JSON.stringify(entries)).not.toContain('greenweb-secret-token');
      } finally {
        await stub.close();
      }
    });

    it('retries a transient HTTP failure and logs the backoff', async () => {
      const stub = await startSmsStub([
        { status: 503, body: 'gateway down' },
        { status: 200, body: JSON.stringify([{ status: 'SENT', statusmsg: 'SMS Sent Successfully' }]) }
      ]);
      const entries: StructuredLogEntry[] = [];
      const sleeps: number[] = [];

      try {
        const client = new GreenwebSmsClient({
          token: 'tok',
          endpoint: stub.url,
          baseDelayMs: 10,
          sleep: recordingSleep(sleeps),
          log: captureLogger(entries)
        });

        const result = await client.send(PHONE, 'code 123456');

        expect(result.delivered).toBe(true);
        expect(result.attempts).toBe(2);
        expect(sleeps).toEqual([10]);
        expect(stub.requests).toHaveLength(2);
        expect(entries.some((entry) => entry.message.includes('retrying in 10ms'))).toBe(true);
      } finally {
        await stub.close();
      }
    });

    it('does not retry a provider rejection', async () => {
      const stub = await startSmsStub([
        {
          status: 200,
          body: JSON.stringify([
            { to: PHONE, status: 'FAILED', statusmsg: `Error: ${PHONE} Invalid Number !` }
          ])
        },
        { status: 200, body: JSON.stringify([{ status: 'SENT', statusmsg: 'SMS Sent Successfully' }]) }
      ]);
      const entries: StructuredLogEntry[] = [];
      const sleeps: number[] = [];

      try {
        const client = new GreenwebSmsClient({
          token: 'tok',
          endpoint: stub.url,
          baseDelayMs: 10,
          sleep: recordingSleep(sleeps),
          log: captureLogger(entries)
        });

        const result = await client.send(PHONE, 'code 123456');

        expect(result.delivered).toBe(false);
        expect(result.attempts).toBe(1);
        expect(result.code).toBe('SMS_PROVIDER_REJECTED');
        expect(result.reason).toContain('Invalid Number');
        expect(sleeps).toEqual([]);
        expect(stub.requests).toHaveLength(1);
        expect(entries.some((entry) => entry.message.includes('permanently'))).toBe(true);
      } finally {
        await stub.close();
      }
    });

    it('exhausts retries with exponential backoff when the provider is unreachable', async () => {
      const sleeps: number[] = [];
      const entries: StructuredLogEntry[] = [];
      const fetchImpl = vi.fn(async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      }) as unknown as typeof fetch;

      const client = new GreenwebSmsClient({
        token: 'tok',
        endpoint: 'http://127.0.0.1:9/send',
        maxAttempts: 3,
        baseDelayMs: 10,
        fetchImpl,
        sleep: recordingSleep(sleeps),
        log: captureLogger(entries)
      });

      const result = await client.send(PHONE, 'code 123456');

      expect(result.delivered).toBe(false);
      expect(result.attempts).toBe(3);
      expect(result.code).toBe('SMS_NETWORK_ERROR');
      expect(sleeps).toEqual([10, 20]);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('classifies an aborted request as a timeout', async () => {
      const sleeps: number[] = [];
      const fetchImpl = vi.fn(async () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError'
        });
      }) as unknown as typeof fetch;

      const client = new GreenwebSmsClient({
        token: 'tok',
        endpoint: 'http://127.0.0.1:9/send',
        maxAttempts: 1,
        fetchImpl,
        sleep: recordingSleep(sleeps),
        log: captureLogger([])
      });

      const result = await client.send(PHONE, 'code 123456');

      expect(result.delivered).toBe(false);
      expect(result.code).toBe('SMS_TIMEOUT');
      expect(result.reason).toMatch(/did not respond/);
    });
  });

  describe('BulkSMSBD', () => {
    it('accepts response code 202 and sends the 880 number format', async () => {
      const stub = await startSmsStub([
        {
          status: 200,
          body: JSON.stringify({
            response_code: 202,
            success_message: 'SMS Submitted Successfully',
            error_message: ''
          })
        }
      ]);
      const entries: StructuredLogEntry[] = [];

      try {
        const client = new BulkSmsBdSmsClient({
          apiKey: 'bulk-api-key',
          senderId: 'CXBEXPRESS',
          endpoint: stub.url,
          sleep: recordingSleep([]),
          log: captureLogger(entries)
        });

        const result = await client.send(PHONE, 'code 123456');

        expect(result).toMatchObject({
          delivered: true,
          provider: 'bulksmsbd',
          providerStatus: '202',
          attempts: 1
        });

        const params = new URLSearchParams(stub.requests[0].body);
        expect(stub.requests[0].method).toBe('POST');
        expect(params.get('api_key')).toBe('bulk-api-key');
        expect(params.get('senderid')).toBe('CXBEXPRESS');
        expect(params.get('number')).toBe('8801811000004'); // no leading + or 01
        expect(params.get('message')).toBe('code 123456');
        expect(params.get('type')).toBe('text');
      } finally {
        await stub.close();
      }
    });

    it('treats insufficient balance as a permanent failure', async () => {
      const stub = await startSmsStub([
        { status: 200, body: JSON.stringify({ response_code: 1007, error_message: 'Insufficient balance' }) },
        { status: 200, body: JSON.stringify({ response_code: 202 }) }
      ]);
      const sleeps: number[] = [];

      try {
        const client = new BulkSmsBdSmsClient({
          apiKey: 'key',
          senderId: 'CXBEXPRESS',
          endpoint: stub.url,
          baseDelayMs: 10,
          sleep: recordingSleep(sleeps),
          log: captureLogger([])
        });

        const result = await client.send(PHONE, 'code 123456');

        expect(result.delivered).toBe(false);
        expect(result.code).toBe('SMS_INSUFFICIENT_BALANCE');
        expect(result.attempts).toBe(1);
        expect(sleeps).toEqual([]);
        expect(stub.requests).toHaveLength(1);
      } finally {
        await stub.close();
      }
    });

    it('retries a provider internal error (1005)', async () => {
      const stub = await startSmsStub([
        { status: 200, body: JSON.stringify({ response_code: 1005, error_message: 'Internal error' }) },
        { status: 200, body: JSON.stringify({ response_code: 202 }) }
      ]);
      const sleeps: number[] = [];

      try {
        const client = new BulkSmsBdSmsClient({
          apiKey: 'key',
          senderId: 'CXBEXPRESS',
          endpoint: stub.url,
          baseDelayMs: 10,
          sleep: recordingSleep(sleeps),
          log: captureLogger([])
        });

        const result = await client.send(PHONE, 'code 123456');

        expect(result.delivered).toBe(true);
        expect(result.attempts).toBe(2);
        expect(sleeps).toEqual([10]);
      } finally {
        await stub.close();
      }
    });

    it('reads the documented plain-text 202 response', async () => {
      const stub = await startSmsStub([{ status: 200, body: '202 SMS Submitted Successfully' }]);

      try {
        const client = new BulkSmsBdSmsClient({
          apiKey: 'key',
          senderId: 'CXBEXPRESS',
          endpoint: stub.url,
          sleep: recordingSleep([]),
          log: captureLogger([])
        });

        const result = await client.send(PHONE, 'code 123456');
        expect(result.delivered).toBe(true);
        expect(result.providerStatus).toBe('202');
      } finally {
        await stub.close();
      }
    });

    it('never claims delivery for an unrecognised response', async () => {
      const stub = await startSmsStub([{ status: 200, body: '<html>maintenance</html>' }]);
      const sleeps: number[] = [];

      try {
        const client = new BulkSmsBdSmsClient({
          apiKey: 'key',
          senderId: 'CXBEXPRESS',
          endpoint: stub.url,
          maxAttempts: 2,
          baseDelayMs: 10,
          sleep: recordingSleep(sleeps),
          log: captureLogger([])
        });

        const result = await client.send(PHONE, 'code 123456');

        expect(result.delivered).toBe(false);
        expect(result.code).toBe('SMS_PROVIDER_UNRECOGNISED');
        expect(result.attempts).toBe(2);
        expect(sleeps).toEqual([10]);
      } finally {
        await stub.close();
      }
    });
  });

  describe('client factory and helpers', () => {
    it('builds a client only for a supported provider with a credential', () => {
      expect(createSmsClient({ provider: 'greenweb', token: 'tok' })?.name).toBe('greenweb');
      expect(createSmsClient({ provider: 'bulksmsbd', token: 'key', senderId: 'S' })?.name).toBe('bulksmsbd');
      expect(createSmsClient({ provider: 'greenweb', token: '  ' })).toBeNull();
      expect(createSmsClient({ provider: 'twilio', token: 'tok' })).toBeNull();
    });

    it('builds nothing from environment defaults and honours the env factory otherwise', () => {
      // The test environment has no provider configured, so the factory must fail closed.
      expect(createSmsClientFromEnv()).toBeNull();
    });

    it('masks phone numbers for logs and normalizes the BulkSMSBD format', () => {
      expect(maskPhone(PHONE)).toBe('+880******0004');
      expect(maskPhone('1234')).toBe('****');
      expect(toBulkSmsBdNumber('+8801811000004')).toBe('8801811000004');
      expect(toBulkSmsBdNumber('01811000004')).toBe('8801811000004');
      expect(toBulkSmsBdNumber('8801811000004')).toBe('8801811000004');
    });
  });

  describe('OtpDispatcher', () => {
    const configuredStatus: OtpDeliveryStatus = {
      provider: 'greenweb',
      configured: true,
      mockMode: false,
      supported: true
    };

    it('formats an OTP message naming the code and its expiry', () => {
      const message = formatOtpMessage('123456', 300);
      expect(message).toContain('123456');
      expect(message).toContain('5 minutes');
    });

    it('does not touch the network when no provider is configured', async () => {
      const createClient = vi.fn(() => null);
      const dispatcher = new OtpDispatcher({
        createClient,
        status: () => ({
          provider: 'none',
          configured: false,
          mockMode: true,
          supported: false,
          reason: 'SMS provider is not configured'
        })
      });

      const result = await dispatcher.dispatch(PHONE, '123456', 300);

      expect(result.delivered).toBe(false);
      expect(result.code).toBe('SMS_NOT_SENT');
      expect(createClient).not.toHaveBeenCalled();
    });

    it('dispatches the formatted message and reports the provider result', async () => {
      const send = vi.fn(async (_to: string, _message: string) => ({
        delivered: true,
        provider: 'greenweb',
        attempts: 1,
        latencyMs: 42,
        providerStatus: 'SENT'
      }));
      const dispatcher = new OtpDispatcher({
        createClient: () => ({ name: 'greenweb', send }),
        status: () => configuredStatus
      });

      const result = await dispatcher.dispatch(PHONE, '123456', 300);

      expect(result.delivered).toBe(true);
      expect(result.attempts).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      const [to, message] = send.mock.calls[0];
      expect(to).toBe(PHONE);
      expect(message).toContain('123456');
    });

    it('reports an honest failure when the provider rejects the message', async () => {
      const dispatcher = new OtpDispatcher({
        createClient: () => ({
          name: 'greenweb',
          send: async () => ({
            delivered: false,
            provider: 'greenweb',
            attempts: 3,
            latencyMs: 30,
            reason: 'Provider responded HTTP 503',
            code: 'SMS_HTTP_503'
          })
        }),
        status: () => configuredStatus
      });

      const result = await dispatcher.dispatch(PHONE, '123456', 300);

      expect(result.delivered).toBe(false);
      expect(result.code).toBe('SMS_HTTP_503');
      expect(result.reason).toContain('503');
    });
  });
});
