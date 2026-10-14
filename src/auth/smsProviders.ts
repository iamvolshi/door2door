import { env } from '../config/env';
import { Logger, logger } from '../core/logger';

export type SmsProviderName = 'greenweb' | 'bulksmsbd';

/** Providers with a real client implementation behind them. */
export const SUPPORTED_SMS_PROVIDERS: readonly SmsProviderName[] = ['greenweb', 'bulksmsbd'];

export type SmsFetch = typeof fetch;

export interface SmsSendResult {
  /** True only when the provider accepted the message for delivery. */
  delivered: boolean;
  provider: string;
  attempts: number;
  latencyMs: number;
  /** The provider's own status token, e.g. `SENT` or `202`. */
  providerStatus?: string;
  /** Provider-side message identifier, when the gateway returns one. */
  messageId?: string;
  /** Human-readable reason the message was not accepted. */
  reason?: string;
  /** Stable machine code for the failure. */
  code?: string;
}

export interface SmsProviderClient {
  readonly name: string;
  send(to: string, message: string): Promise<SmsSendResult>;
}

export interface SmsClientOptions {
  /** Total attempts including the first. Defaults to SMS_MAX_ATTEMPTS. */
  maxAttempts?: number;
  /** Per-attempt network timeout. Defaults to SMS_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Backoff base; attempt N waits base * 2^(N-1). Defaults to SMS_RETRY_BASE_DELAY_MS. */
  baseDelayMs?: number;
  endpoint?: string;
  /** Injectable for tests. */
  fetchImpl?: SmsFetch;
  /** Injectable for tests so backoff does not sleep for real. */
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
}

interface Interpretation {
  accepted: boolean;
  retryable: boolean;
  providerStatus?: string;
  messageId?: string;
  reason?: string;
  code?: string;
}

/** HTTP statuses worth retrying: transient upstream failures and throttling. */
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function truncate(text: string, max = 200): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Keeps enough of a number for operators to find it in a provider dashboard while
 * keeping the full subscriber number out of application logs.
 */
export function maskPhone(phone: string): string {
  const cleaned = phone.replace(/\s/g, '');
  if (cleaned.length <= 8) return '*'.repeat(cleaned.length);
  return `${cleaned.slice(0, 4)}${'*'.repeat(cleaned.length - 8)}${cleaned.slice(-4)}`;
}

/** Normalizes to the `8801XXXXXXXXX` form BulkSMSBD documents (no leading `+`). */
export function toBulkSmsBdNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('880')) return digits;
  if (digits.startsWith('0')) return `88${digits}`;
  return digits;
}

/**
 * Shared transport for the gateway clients: bounded retries with exponential
 * backoff, a per-attempt timeout, and one structured log line per attempt so a
 * lost code can always be traced to what the provider actually answered.
 */
abstract class HttpSmsClient implements SmsProviderClient {
  public abstract readonly name: string;

  protected readonly maxAttempts: number;
  protected readonly timeoutMs: number;
  protected readonly baseDelayMs: number;
  protected readonly fetchImpl: SmsFetch;
  protected readonly sleep: (ms: number) => Promise<void>;
  protected readonly log: Logger;

  constructor(options: SmsClientOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? env.SMS_MAX_ATTEMPTS;
    this.timeoutMs = options.timeoutMs ?? env.SMS_REQUEST_TIMEOUT_MS;
    this.baseDelayMs = options.baseDelayMs ?? env.SMS_RETRY_BASE_DELAY_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.log = options.log ?? logger;
  }

  protected abstract buildRequest(to: string, message: string): { url: string; init: RequestInit };

  /** Classifies a 2xx provider response. */
  protected abstract interpret(httpStatus: number, bodyText: string): Interpretation;

  public async send(to: string, message: string): Promise<SmsSendResult> {
    const startedAt = Date.now();
    const maskedPhone = maskPhone(to);
    let lastReason = 'SMS was not sent';
    let lastCode: string | undefined = 'SMS_NOT_SENT';
    let lastStatus: string | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let interpretation: Interpretation;

      try {
        const { url, init } = this.buildRequest(to, message);
        const response = await this.fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        const bodyText = await response.text();

        interpretation =
          response.status >= 200 && response.status < 300
            ? this.interpret(response.status, bodyText)
            : {
                accepted: false,
                retryable: RETRYABLE_HTTP_STATUS.has(response.status),
                providerStatus: String(response.status),
                reason: `Provider responded HTTP ${response.status}`,
                code: `SMS_HTTP_${response.status}`
              };
      } catch (error) {
        const isTimeout =
          error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        interpretation = {
          accepted: false,
          // A timeout or socket error may have been received after the send; retry.
          retryable: true,
          reason: isTimeout
            ? `Provider did not respond within ${this.timeoutMs}ms`
            : `Provider request failed: ${error instanceof Error ? error.message : String(error)}`,
          code: isTimeout ? 'SMS_TIMEOUT' : 'SMS_NETWORK_ERROR'
        };
      }

      const latencyMs = Date.now() - startedAt;

      if (interpretation.accepted) {
        this.log.info(`SMS accepted by ${this.name}`, {
          provider: this.name,
          phone: maskedPhone,
          attempt,
          maxAttempts: this.maxAttempts,
          providerStatus: interpretation.providerStatus,
          messageId: interpretation.messageId,
          latencyMs
        });
        return {
          delivered: true,
          provider: this.name,
          attempts: attempt,
          latencyMs,
          providerStatus: interpretation.providerStatus,
          messageId: interpretation.messageId
        };
      }

      lastReason = interpretation.reason ?? 'Provider rejected the message';
      lastCode = interpretation.code ?? 'SMS_REJECTED';
      lastStatus = interpretation.providerStatus;

      const context = {
        provider: this.name,
        phone: maskedPhone,
        attempt,
        maxAttempts: this.maxAttempts,
        providerStatus: interpretation.providerStatus,
        code: lastCode,
        reason: lastReason,
        retryable: interpretation.retryable,
        latencyMs
      };

      // A permanent rejection (bad number, insufficient balance, disabled sender ID)
      // must stop here; retrying it only wastes quota and delays the error.
      if (!interpretation.retryable || attempt === this.maxAttempts) {
        this.log.error(`SMS delivery failed permanently via ${this.name}`, undefined, context);
        return {
          delivered: false,
          provider: this.name,
          attempts: attempt,
          latencyMs,
          providerStatus: lastStatus,
          reason: lastReason,
          code: lastCode
        };
      }

      const delayMs = this.baseDelayMs * 2 ** (attempt - 1);
      this.log.warn(`SMS delivery attempt ${attempt} failed; retrying in ${delayMs}ms`, {
        ...context,
        retryDelayMs: delayMs
      });
      await this.sleep(delayMs);
    }

    return {
      delivered: false,
      provider: this.name,
      attempts: this.maxAttempts,
      latencyMs: Date.now() - startedAt,
      providerStatus: lastStatus,
      reason: lastReason,
      code: lastCode
    };
  }
}

export interface GreenwebClientOptions extends SmsClientOptions {
  token: string;
  senderId?: string;
}

/**
 * Greenweb (api.greenweb.com.bd): form-urlencoded POST with `token`, `to` and
 * `message`; `?json` selects the machine-readable array response. Greenweb has no
 * per-message id and no public delivery-report API, so `SENT` means "accepted for
 * delivery", not "handset receipt".
 */
export class GreenwebSmsClient extends HttpSmsClient {
  public readonly name: SmsProviderName = 'greenweb';

  private readonly token: string;
  private readonly endpoint: string;

  constructor(options: GreenwebClientOptions) {
    super(options);
    this.token = options.token.trim();
    const base = (options.endpoint ?? env.GREENWEB_API_URL).trim();
    const separator = base.includes('?') ? '&' : '?';
    this.endpoint = base.endsWith('?json') || base.includes('json') ? base : `${base}${separator}json`;
  }

  protected buildRequest(to: string, message: string): { url: string; init: RequestInit } {
    const body = new URLSearchParams({ token: this.token, to, message });
    return {
      url: this.endpoint,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      }
    };
  }

  protected interpret(_httpStatus: number, bodyText: string): Interpretation {
    const parsed = tryParseJson(bodyText);

    if (Array.isArray(parsed) && parsed.length > 0) {
      const entry = (parsed[0] ?? {}) as Record<string, unknown>;
      const status = typeof entry.status === 'string' ? entry.status.toUpperCase() : '';
      const statusMessage = typeof entry.statusmsg === 'string' ? entry.statusmsg : undefined;
      const accepted = status === 'SENT' || status === 'OK' || /^ok:/i.test(statusMessage ?? '');

      return accepted
        ? { accepted: true, retryable: false, providerStatus: status || 'SENT' }
        : {
            accepted: false,
            retryable: false,
            providerStatus: status || undefined,
            reason: statusMessage ?? 'Provider rejected the message',
            code: 'SMS_PROVIDER_REJECTED'
          };
    }

    const text = bodyText.trim();
    if (/^ok:/i.test(text) || /sent successfully/i.test(text)) {
      return { accepted: true, retryable: false, providerStatus: 'SENT' };
    }
    if (/^error:/i.test(text)) {
      return {
        accepted: false,
        retryable: false,
        reason: truncate(text),
        code: 'SMS_PROVIDER_REJECTED'
      };
    }
    return {
      accepted: false,
      retryable: true,
      reason: text ? `Unrecognised provider response: ${truncate(text)}` : 'Empty provider response',
      code: 'SMS_PROVIDER_UNRECOGNISED'
    };
  }
}

export interface BulkSmsBdClientOptions extends SmsClientOptions {
  apiKey: string;
  senderId: string;
}

/** BulkSMSBD's documented response codes. */
function classifyBulkSmsBdCode(
  code: number,
  message: string | undefined,
  messageId: string | undefined
): Interpretation {
  switch (code) {
    case 202:
      return { accepted: true, retryable: false, providerStatus: '202', messageId };
    case 1005: // internal error
      return {
        accepted: false,
        retryable: true,
        providerStatus: '1005',
        reason: message ?? 'Provider internal error',
        code: 'SMS_PROVIDER_INTERNAL_ERROR'
      };
    case 1002:
      return {
        accepted: false,
        retryable: false,
        providerStatus: '1002',
        reason: message ?? 'Sender ID is incorrect or disabled',
        code: 'SMS_INVALID_SENDER_ID'
      };
    case 1003:
      return {
        accepted: false,
        retryable: false,
        providerStatus: '1003',
        reason: message ?? 'Required fields are missing',
        code: 'SMS_INVALID_REQUEST'
      };
    case 1006:
      return {
        accepted: false,
        retryable: false,
        providerStatus: '1006',
        reason: message ?? 'Balance validity unavailable',
        code: 'SMS_BALANCE_UNKNOWN'
      };
    case 1007:
      return {
        accepted: false,
        retryable: false,
        providerStatus: '1007',
        reason: message ?? 'Insufficient SMS balance',
        code: 'SMS_INSUFFICIENT_BALANCE'
      };
    case 1012:
      return {
        accepted: false,
        retryable: false,
        providerStatus: '1012',
        reason: message ?? 'Masking SMS must be sent in Bengali',
        code: 'SMS_LANGUAGE_REJECTED'
      };
    default:
      return {
        accepted: false,
        retryable: false,
        providerStatus: String(code),
        reason: message ?? `Provider returned code ${code}`,
        code: 'SMS_PROVIDER_REJECTED'
      };
  }
}

/**
 * BulkSMSBD (bulksmsbd.net): form-urlencoded POST with `api_key`, `senderid`,
 * `number`, `message` and `type=text`. It answers with numeric codes where `202`
 * means "submitted", not "delivered"; there is no public delivery-report endpoint,
 * so a `202` is the strongest signal available.
 */
export class BulkSmsBdSmsClient extends HttpSmsClient {
  public readonly name: SmsProviderName = 'bulksmsbd';

  private readonly apiKey: string;
  private readonly senderId: string;
  private readonly endpoint: string;

  constructor(options: BulkSmsBdClientOptions) {
    super(options);
    this.apiKey = options.apiKey.trim();
    this.senderId = options.senderId.trim();
    this.endpoint = (options.endpoint ?? env.BULKSMSBD_API_URL).trim();
  }

  protected buildRequest(to: string, message: string): { url: string; init: RequestInit } {
    const body = new URLSearchParams({
      api_key: this.apiKey,
      senderid: this.senderId,
      number: toBulkSmsBdNumber(to),
      message,
      type: 'text'
    });
    return {
      url: this.endpoint,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      }
    };
  }

  protected interpret(_httpStatus: number, bodyText: string): Interpretation {
    const parsed = tryParseJson(bodyText);

    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const rawCode = record.response_code ?? record.status ?? record.code;
      const message = pickString(record.error_message) ?? pickString(record.success_message);
      const messageId = pickString(record.sms_id) ?? pickString(record.message_id);

      if (rawCode !== undefined && Number.isFinite(Number(rawCode))) {
        return classifyBulkSmsBdCode(Number(rawCode), message, messageId);
      }
      if (message && /success/i.test(message)) {
        return { accepted: true, retryable: false, providerStatus: '202', messageId };
      }
    }

    const text = bodyText.trim();
    // Documented plain-text form: the body starts with the numeric response code.
    const codeMatch = text.match(/^(202|10\d{2})\b/);
    if (codeMatch) {
      return classifyBulkSmsBdCode(Number(codeMatch[1]), truncate(text), undefined);
    }
    if (/\b202\b/.test(text) && /success/i.test(text)) {
      return { accepted: true, retryable: false, providerStatus: '202' };
    }
    return {
      accepted: false,
      retryable: true,
      reason: text ? `Unrecognised provider response: ${truncate(text)}` : 'Empty provider response',
      code: 'SMS_PROVIDER_UNRECOGNISED'
    };
  }
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function pickString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number') return String(value);
  return undefined;
}

export function isSupportedSmsProvider(provider: string): provider is SmsProviderName {
  return (SUPPORTED_SMS_PROVIDERS as readonly string[]).includes(provider.trim().toLowerCase());
}

export interface SmsClientConfig extends SmsClientOptions {
  provider: string;
  token?: string;
  senderId?: string;
}

/**
 * Builds the client for a provider name, or `null` when the provider is unknown or
 * has no credential — callers must fail closed rather than report a send.
 */
export function createSmsClient(config: SmsClientConfig): SmsProviderClient | null {
  const provider = config.provider.trim().toLowerCase();
  const token = (config.token ?? '').trim();

  if (provider === 'greenweb') {
    if (token === '') return null;
    return new GreenwebSmsClient({ ...config, token });
  }
  if (provider === 'bulksmsbd') {
    if (token === '') return null;
    return new BulkSmsBdSmsClient({
      ...config,
      apiKey: token,
      senderId: (config.senderId ?? 'CXBEXPRESS').trim() || 'CXBEXPRESS'
    });
  }
  return null;
}

/** Convenience wrapper reading the validated configuration. */
export function createSmsClientFromEnv(overrides: SmsClientOptions = {}): SmsProviderClient | null {
  const provider = env.SMS_PROVIDER.trim().toLowerCase();
  if (provider === 'greenweb') {
    return createSmsClient({
      ...overrides,
      provider,
      token: env.GREENWEB_API_TOKEN,
      senderId: env.GREENWEB_SENDER_ID,
      endpoint: overrides.endpoint ?? env.GREENWEB_API_URL
    });
  }
  if (provider === 'bulksmsbd') {
    return createSmsClient({
      ...overrides,
      provider,
      token: env.BULKSMSBD_API_KEY,
      senderId: env.BULKSMSBD_SENDER_ID,
      endpoint: overrides.endpoint ?? env.BULKSMSBD_API_URL
    });
  }
  return null;
}
