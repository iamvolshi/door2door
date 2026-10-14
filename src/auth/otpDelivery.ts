import { env } from '../config/env';
import { AppError } from '../core/errors';
import { logger } from '../core/logger';
import {
  createSmsClientFromEnv,
  isSupportedSmsProvider,
  maskPhone,
  SUPPORTED_SMS_PROVIDERS,
  type SmsProviderClient
} from './smsProviders';

export interface OtpDeliveryStatus {
  provider: string;
  /** A supported provider with a credential, i.e. a client can actually be built. */
  configured: boolean;
  mockMode: boolean;
  /** The named provider has a real client implementation. */
  supported: boolean;
  /** Why delivery is unavailable, when it is. */
  reason?: string;
}

export interface OtpDispatchResult {
  delivered: boolean;
  provider: string;
  reason?: string;
  code?: string;
  messageId?: string;
  /** The gateway's own status token (`SENT`, `202`, `1007`, …); recorded for operators. */
  providerStatus?: string;
  attempts?: number;
  latencyMs?: number;
}

export function providerCredential(provider: string): string {
  if (provider === 'greenweb') return env.GREENWEB_API_TOKEN;
  if (provider === 'bulksmsbd') return env.BULKSMSBD_API_KEY;
  return '';
}

export function getOtpDeliveryStatus(): OtpDeliveryStatus {
  const provider = env.SMS_PROVIDER.trim().toLowerCase();
  const mockMode = env.SMS_MOCK_MODE;
  const supported = isSupportedSmsProvider(provider);
  const named = provider !== '' && provider !== 'none';
  const configured = supported && providerCredential(provider).trim() !== '';

  let reason: string | undefined;
  if (!named) {
    reason = 'SMS provider is not configured';
  } else if (!supported) {
    reason = `Unknown SMS provider '${provider}'. Supported providers: ${SUPPORTED_SMS_PROVIDERS.join(', ')}`;
  } else if (!configured) {
    reason = `No credential supplied for SMS provider '${provider}'`;
  }

  return { provider, configured, mockMode, supported, reason };
}

/**
 * Guards the OTP endpoint's configuration. Fails closed (503) when a provider is
 * selected but cannot be used — an unknown name or a missing credential — so the
 * endpoint never issues a code it cannot deliver. Mock mode and the default "no
 * provider" development setup pass through, and `dispatchOtp` reports honestly.
 */
export function assertOtpDeliverySupported(): void {
  const status = getOtpDeliveryStatus();
  if (status.mockMode) return;
  if (status.provider === '' || status.provider === 'none') return;

  if (!status.supported) {
    throw new AppError(
      `SMS delivery for provider '${status.provider}' is not implemented. Supported providers: ${SUPPORTED_SMS_PROVIDERS.join(', ')}. Set SMS_MOCK_MODE=true for development.`,
      503,
      'SMS_PROVIDER_UNAVAILABLE'
    );
  }

  if (!status.configured) {
    throw new AppError(
      `SMS provider '${status.provider}' is selected but has no credential configured, so no OTP could be delivered.`,
      503,
      'SMS_PROVIDER_UNCONFIGURED'
    );
  }
}

/**
 * Code and reason for an SMS that could not even be attempted — a provider name nothing
 * implements, or one selected with no credential. Shared by the two surfaces that can ask for
 * a code (the number's own request and the help desk's) so a blocked dispatch is reported and
 * recorded the same way by both.
 */
export function describeDispatchBlocker(error: unknown): { code: string; reason: string } {
  if (error instanceof AppError) {
    return { code: error.code, reason: error.message };
  }
  return {
    code: 'SMS_DISPATCH_BLOCKED',
    reason: error instanceof Error ? error.message : 'SMS dispatch could not be attempted'
  };
}

export function formatOtpMessage(otp: string, expiresInSeconds: number): string {
  const minutes = Math.max(1, Math.round(expiresInSeconds / 60));
  return `Your Cox's Bazar Door2Door verification code is ${otp}. It expires in ${minutes} minute${minutes === 1 ? '' : 's'}. Never share this code with anyone.`;
}

export interface OtpDispatcherOptions {
  /** Overridable for tests; defaults to building a client from the environment. */
  createClient?: () => SmsProviderClient | null;
  /** Overridable for tests; defaults to the validated environment configuration. */
  status?: () => OtpDeliveryStatus;
}

/**
 * Turns a generated OTP into an SMS. Every outcome is logged with the provider's
 * answer, and `delivered` is true only when a provider accepted the message.
 */
export class OtpDispatcher {
  private readonly createClient: () => SmsProviderClient | null;
  private readonly getStatus: () => OtpDeliveryStatus;

  constructor(options: OtpDispatcherOptions = {}) {
    this.createClient = options.createClient ?? createSmsClientFromEnv;
    this.getStatus = options.status ?? getOtpDeliveryStatus;
  }

  public async dispatch(
    phone: string,
    otp: string,
    expiresInSeconds: number
  ): Promise<OtpDispatchResult> {
    const status = this.getStatus();

    if (status.mockMode || status.provider === '' || status.provider === 'none') {
      const reason = status.reason ?? 'SMS_MOCK_MODE is enabled';
      logger.warn('OTP generated but not sent', {
        provider: status.provider || 'none',
        phone: maskPhone(phone),
        reason
      });
      return { delivered: false, provider: status.provider || 'none', reason, code: 'SMS_NOT_SENT', attempts: 0 };
    }

    const client = this.createClient();
    if (!client) {
      const reason = status.reason ?? 'No SMS client could be built';
      logger.error('OTP not sent: no usable SMS client', undefined, {
        provider: status.provider,
        phone: maskPhone(phone),
        reason
      });
      return {
        delivered: false,
        provider: status.provider,
        reason,
        code: 'SMS_CLIENT_UNAVAILABLE',
        attempts: 0
      };
    }

    const result = await client.send(phone, formatOtpMessage(otp, expiresInSeconds));

    if (result.delivered) {
      logger.info('OTP dispatched', {
        provider: result.provider,
        phone: maskPhone(phone),
        messageId: result.messageId,
        providerStatus: result.providerStatus,
        attempts: result.attempts,
        latencyMs: result.latencyMs
      });
    } else {
      logger.error('OTP delivery failed', undefined, {
        provider: result.provider,
        phone: maskPhone(phone),
        code: result.code,
        reason: result.reason,
        attempts: result.attempts,
        latencyMs: result.latencyMs
      });
    }

    return {
      delivered: result.delivered,
      provider: result.provider,
      reason: result.reason,
      code: result.code,
      messageId: result.messageId,
      providerStatus: result.providerStatus,
      attempts: result.attempts,
      latencyMs: result.latencyMs
    };
  }
}

export const otpDispatcher = new OtpDispatcher();

/** Sends the OTP through the configured provider. Reports `delivered: false` when it cannot. */
export function dispatchOtp(
  phone: string,
  otp: string,
  expiresInSeconds = 300
): Promise<OtpDispatchResult> {
  return otpDispatcher.dispatch(phone, otp, expiresInSeconds);
}

// Re-exported so consumers of the delivery seam can reach the provider layer.
export { maskPhone } from './smsProviders';
export type { SmsProviderClient } from './smsProviders';
