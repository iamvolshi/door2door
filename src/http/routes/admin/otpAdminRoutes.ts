import {
  dispatchOtp,
  getOtpDeliveryStatus,
} from '../../../auth/otpDelivery';
import type { OtpDeliveryAttempt } from '../../../auth/otpDeliveryLog';
import { normalizePhoneNumber } from '../../../auth/phoneAuth';
import { env } from '../../../config/env';
import {
  serializeDelivery,
  serializeChallenge,
} from './adminSerializers.js';
import {
  API_PREFIX,
  DELIVERY_SUMMARY_WINDOW_HOURS,
  parseDeliveredFilter,
  parseLimit,
  parsePhoneQuery,
  parseProviderFilter,
  parseReceiptFilter,
  parseSendFlag,
} from './adminShared.js';
import type { AdminRouteDeps } from './adminShared.js';
import { randomUUID } from 'node:crypto';
import {
  authenticatedUser,
  requireString,
  sessionMetaFromRequest,
  type Route,
  type RouteResult,
} from '../../httpUtils';export function createOtpAdminRoutes(deps: AdminRouteDeps): Route[] {
  const dispatch = deps.dispatchOtp ?? dispatchOtp;

  /** Records one SMS attempt on the delivery trail; a no-op unless one was supplied. */
  const recordDelivery = async (
    ctx: { requestId: string; clientIp: string },
    attempt: OtpDeliveryAttempt
  ): Promise<void> => {
    if (!deps.otpDeliveryLog) return;
    await deps.otpDeliveryLog.record({
      ...attempt,
      requestId: ctx.requestId,
      ipAddress: ctx.clientIp
    });
  };

  return [
  {
    method: 'GET',
    path: `${API_PREFIX}/admin/otp-deliveries`,
    requiresAuth: true,
    permission: 'otp:read',
    handler: async (ctx): Promise<RouteResult> => {
      const phone = parsePhoneQuery(ctx.query.get('phone'));
      const delivered = parseDeliveredFilter(ctx.query.get('delivered'));
      const provider = parseProviderFilter(ctx.query.get('provider'));
      const receipt = parseReceiptFilter(ctx.query.get('receipt'));
      const limit = parseLimit(ctx.query.get('limit'));

      const deliveries = await deps.otpDeliveryRepo.findRecent({
        ...(phone === undefined ? {} : { phone }),
        ...(delivered === undefined ? {} : { delivered }),
        ...(provider === undefined ? {} : { provider }),
        ...(receipt === undefined ? {} : { receipt }),
        limit
      });

      // The summary covers the window, not the listing: narrowing to failures must not
      // change the ratio it is read against.
      const since = new Date(
        Date.now() - DELIVERY_SUMMARY_WINDOW_HOURS * 3600 * 1000
      ).toISOString();
      const base = await deps.otpDeliveryRepo.summarize({ since });
      const receiptSummary = await deps.otpDeliveryRepo.summarizeReceipts({ since });

      return {
        status: 200,
        body: {
          success: true,
          count: deliveries.length,
          deliveries: deliveries.map(serializeDelivery),
          summary: {
            windowHours: DELIVERY_SUMMARY_WINDOW_HOURS,
            ...base,
            receipt: receiptSummary
          }
        }
      };
    }
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/admin/otp-challenges/reset`,
    requiresAuth: true,
    permission: 'otp:manage',
    handler: async (ctx): Promise<RouteResult> => {
      const admin = authenticatedUser(ctx);
      const phone = normalizePhoneNumber(requireString(ctx.body, 'phone'));
      const reason = requireString(ctx.body, 'reason');
      const send = parseSendFlag(ctx.body.send);
      const meta = sessionMetaFromRequest(ctx);

      // What the number held before anything moved, because what was actually cleared is
      // the answer the operator has to give back to the caller on the phone.
      const { before, released } = await deps.otpService.releaseCooldown(phone);

      // A forced send replaces whatever code was live, retiring the one the customer may
      // still be holding — which the desk has to say out loud. A quiet reset retires
      // nothing: the code in their hand stays valid.
      let previousCodeRetired = false;
      let code: Record<string, unknown> | null = null;
      let delivered = false;
      let provider = getOtpDeliveryStatus().provider || 'none';
      if (send) {
        previousCodeRetired = before.codeLive;
        const { otp, expiresInSeconds } = await deps.otpService.requestOtp(phone);
        const result = await dispatch(phone, otp, expiresInSeconds);
        delivered = result.delivered;
        provider = result.provider;

        await recordDelivery(ctx, {
          phone,
          provider: result.provider,
          delivered,
          providerStatus: result.providerStatus,
          failureCode: delivered ? undefined : result.code,
          failureReason: delivered ? undefined : result.reason,
          messageId: result.messageId,
          attempts: result.attempts,
          latencyMs: result.latencyMs
        });

        code = {
          sent: true,
          delivered,
          failure: delivered ? null : { code: result.code ?? 'SMS_NOT_SENT', reason: result.reason ?? null },
          // Development convenience only, the same one the number's own request makes:
          // with no SMS provider the code would otherwise be unreadable to the operator
          // who is supposed to read it out. Never exposed in production.
          ...(!delivered && env.NODE_ENV !== 'production' ? { devOtp: otp } : {})
        };
      }

      const after = await deps.otpService.describeChallenge(phone);

      // The act is an administrator's, and it is audited: who did it, from the token
      // rather than the body, and through which login. The row carries flags and counts,
      // never the challenge's own state — a code or the hash it is stored as would be a
      // credential on a table read by auditors.
      const audit = await deps.auditRepo.log({
        id: `aud_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        userId: admin.id,
        action: 'OTP_CHALLENGE_RESET',
        entityType: 'OTP_CHALLENGE',
        entityId: phone,
        oldValues: JSON.stringify({
          hadChallenge: before.hasChallenge,
          cooldownSecondsRemaining: before.secondsUntilResend
        }),
        newValues: JSON.stringify({
          reason,
          sent: send,
          delivered,
          provider,
          cooldownReleased: released,
          previousCodeRetired,
          codeLiveAfter: after.codeLive
        }),
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
        sessionId: meta.sessionId ?? null
      });

      return {
        status: 200,
        body: {
          success: true,
          phone,
          cleared: {
            hadChallenge: before.hasChallenge,
            cooldownSecondsRemaining: before.secondsUntilResend,
            cooldownReleased: released,
            codeRetired: previousCodeRetired
          },
          code,
          challenge: serializeChallenge(after),
          auditLogId: audit.id
        }
      };
    }
  },
  ];
}
