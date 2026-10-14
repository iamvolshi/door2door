import { env } from '../../config/env';
import { ForbiddenError, UnauthorizedError } from '../../core/errors';
import { normalizePhoneNumber, phoneAuth, type PhoneAuthService } from '../../auth/phoneAuth';
import {
  assertOtpDeliverySupported,
  describeDispatchBlocker,
  dispatchOtp,
  getOtpDeliveryStatus,
  type OtpDispatchResult
} from '../../auth/otpDelivery';
import type { OtpDeliveryAttempt, OtpDeliveryLog } from '../../auth/otpDeliveryLog';
import type { ClientAddressRetention } from '../../auth/clientAddressRetention';
import {
  parseRegistrationApplication,
  type RegistrationService
} from '../../auth/registrationService';
import type { SessionService, IssuedSession } from '../../auth/sessionService';
import type { UserRepository } from '../../db/repositories';
import type { UserRecord } from '../../db/schema';
import {
  authenticatedUser,
  requireString,
  sessionMetaFromRequest as sessionMeta,
  type Route,
  type RouteResult
} from '../httpUtils';

const API_PREFIX = '/api/v1';

export interface AuthRouteDeps {
  userRepo: UserRepository;
  sessionService: SessionService;
  registrationService: RegistrationService;
  /** Injectable for tests; defaults to the shared OTP service. */
  otpService?: PhoneAuthService;
  /** Writes the SMS attempt trail; omitted by callers that do not persist it. */
  otpDeliveryLog?: OtpDeliveryLog;
  /**
   * Replaces client addresses past their retention window. Login is the path that creates
   * these rows, so the sweep rides along with it rather than needing a scheduler.
   */
  retention?: ClientAddressRetention;
  /** Injectable for tests; defaults to the configured SMS gateway. */
  dispatchOtp?: (phone: string, otp: string, expiresInSeconds: number) => Promise<OtpDispatchResult>;
}

export function serializeUser(user: UserRecord): Record<string, unknown> {
  return {
    id: user.id,
    fullName: user.fullName,
    phone: user.phone,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    approvalStatus: user.approvalStatus ?? 'APPROVED',
    approvalReason: user.approvalReason ?? null,
    createdAt: user.createdAt
  };
}

function sessionResponse(session: IssuedSession): Record<string, unknown> {
  return {
    tokens: {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: session.accessExpiresInSeconds,
      tokenType: session.tokenType
    },
    session: {
      id: session.sessionId,
      refreshExpiresAt: session.refreshExpiresAt
    }
  };
}

export function createAuthRoutes(deps: AuthRouteDeps): Route[] {
  const otpService = deps.otpService ?? phoneAuth;
  const dispatch = deps.dispatchOtp ?? dispatchOtp;

  /** Records one SMS attempt; a no-op unless a delivery log was supplied. */
  const recordAttempt = async (
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
      method: 'POST',
      path: `${API_PREFIX}/auth/otp/request`,
      handler: async (ctx): Promise<RouteResult> => {
        const phone = normalizePhoneNumber(requireString(ctx.body, 'phone'));

        // A refusal here sends no SMS, but it is the answer to "did the code actually go
        // out?" — so it is recorded as a failed attempt before the 503 is surfaced.
        try {
          assertOtpDeliverySupported();
        } catch (error) {
          const blocker = describeDispatchBlocker(error);
          await recordAttempt(ctx, {
            phone,
            provider: getOtpDeliveryStatus().provider || 'none',
            delivered: false,
            failureCode: blocker.code,
            failureReason: blocker.reason,
            attempts: 0
          });
          throw error;
        }

        const { otp, expiresInSeconds } = await otpService.requestOtp(phone);

        // Both an existing account and a new one can be reached with a verified code, so
        // the SMS goes out either way and the response is identical for both — this is
        // what makes registration possible without letting the endpoint enumerate accounts.
        const result = await dispatch(phone, otp, expiresInSeconds);
        const delivered = result.delivered;

        await recordAttempt(ctx, {
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
        // Opportunistic retention: the trail is pruned with the traffic that creates it,
        // and the same next login is when addresses past their window are redacted. Both
        // are best effort and neither can fail the login.
        await deps.otpDeliveryLog?.prune();
        await deps.retention?.sweepIfDue();

        const body: Record<string, unknown> = { success: true, expiresInSeconds, smsDelivered: delivered };
        if (!delivered && env.NODE_ENV !== 'production') {
          // Development convenience only: with no SMS provider the code would otherwise
          // be unreachable. Never exposed in production.
          body.devOtp = otp;
        }

        return { status: 200, body };
      }
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/auth/otp/verify`,
      handler: async (ctx): Promise<RouteResult> => {
        const phone = normalizePhoneNumber(requireString(ctx.body, 'phone'));
        const otp = requireString(ctx.body, 'otp');

        const account = await deps.userRepo.findByPhone(phone);

        // A verified code for an unknown number must survive so it can authorise the
        // registration that follows; every other path retires it as before.
        const isValid = await otpService.verifyOtp(phone, otp, { consume: account !== null });
        if (!isValid) {
          throw new UnauthorizedError('Incorrect verification code');
        }

        if (!account) {
          return { status: 200, body: { success: true, registrationRequired: true, phone } };
        }
        if (!account.isActive) {
          throw new ForbiddenError('Account is inactive');
        }

        const session = await deps.sessionService.startSession(account, sessionMeta(ctx));
        return {
          status: 200,
          body: { success: true, user: serializeUser(account), ...sessionResponse(session) }
        };
      }
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/auth/register`,
      handler: async (ctx): Promise<RouteResult> => {
        const phone = normalizePhoneNumber(requireString(ctx.body, 'phone'));
        const otp = requireString(ctx.body, 'otp');

        // Validate the application before touching the code, so a typo in the form does
        // not force the applicant to request a fresh OTP.
        const application = parseRegistrationApplication(ctx.body);

        // The code proves phone ownership and is retired here, so one verified code can
        // create at most one account. Customers are usable at once; merchants and riders
        // are created PENDING for an administrator to review.
        const isValid = await otpService.verifyOtp(phone, otp, { consume: true });
        if (!isValid) {
          throw new UnauthorizedError('Incorrect verification code');
        }

        const outcome = await deps.registrationService.createAccount(
          phone,
          application,
          sessionMeta(ctx)
        );

        const body: Record<string, unknown> = {
          success: true,
          user: serializeUser(outcome.user),
          approvalRequired: outcome.approvalRequired
        };
        if (outcome.approvalRequired) {
          body.message =
            'Registration received. An administrator will review this account before it can be used.';
        }
        if (outcome.session) {
          Object.assign(body, sessionResponse(outcome.session));
        }

        return { status: 201, body };
      }
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/auth/refresh`,
      handler: async (ctx): Promise<RouteResult> => {
        const refreshToken = requireString(ctx.body, 'refreshToken');
        const session = await deps.sessionService.rotate(refreshToken, sessionMeta(ctx));
        return { status: 200, body: { success: true, ...sessionResponse(session) } };
      }
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/auth/logout`,
      handler: async (ctx): Promise<RouteResult> => {
        const refreshToken = requireString(ctx.body, 'refreshToken');
        const revoked = await deps.sessionService.revoke(refreshToken);
        return { status: 200, body: { success: true, revoked } };
      }
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/auth/me`,
      requiresAuth: true,
      // An account waiting on (or refused) review can still check its own status; every
      // permission-bearing route stays closed until it is approved.
      allowUnapprovedAccount: true,
      handler: async (ctx): Promise<RouteResult> => ({
        status: 200,
        body: { success: true, user: serializeUser(authenticatedUser(ctx)) }
      })
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/auth/sessions`,
      requiresAuth: true,
      // Its own account's sessions, so there is nothing for a permission to grant, and an
      // account awaiting review holds no permission at all yet may still hold a phone it no
      // longer trusts. What confines the answer to the caller is the token's own user id in the
      // query, not a grant — the same reasoning as `GET /auth/me`.
      allowUnapprovedAccount: true,
      handler: async (ctx): Promise<RouteResult> => {
        const user = authenticatedUser(ctx);
        const sessions = await deps.sessionService.listActiveSessions(user.id);
        const currentSessionId = ctx.auth?.sessionId ?? null;

        return {
          status: 200,
          body: {
            success: true,
            count: sessions.length,
            // Which of them is this request. A device list without it makes the user guess
            // which entry to be careful about revoking.
            currentSessionId,
            sessions: sessions.map((session) => ({
              id: session.id,
              isCurrent: session.id === currentSessionId,
              familyId: session.familyId,
              // The owner's own address, as recorded for this session; `[redacted]` once it is
              // past the retention window. Never the token digest: see AuthSessionView.
              ipAddress: session.ipAddress,
              userAgent: session.userAgent,
              createdAt: session.createdAt,
              expiresAt: session.expiresAt
            }))
          }
        };
      }
    },
    {
      method: 'DELETE',
      path: `${API_PREFIX}/auth/sessions/:sessionId`,
      requiresAuth: true,
      // The same rows as the list, ended one at a time, and the same reasoning: the session
      // named has to be one of the caller's own, and the token's user id is what makes it so.
      allowUnapprovedAccount: true,
      handler: async (ctx): Promise<RouteResult> => {
        const user = authenticatedUser(ctx);
        const currentSessionId = ctx.auth?.sessionId ?? '';
        const ended = await deps.sessionService.endSession(
          user.id,
          ctx.params.sessionId,
          currentSessionId,
          sessionMeta(ctx)
        );

        return {
          status: 200,
          body: {
            success: true,
            revokedSessionId: ended.sessionId,
            // True only when the device that asked was the device it named, so a client can
            // tell "I ended that other phone" from "I just signed this one out".
            currentSessionRevoked: ended.currentSessionRevoked,
            message: ended.currentSessionRevoked
              ? 'This session has been ended. Sign in again to continue.'
              : 'That session has been ended. This one is still signed in.'
          }
        };
      }
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/auth/sessions/revoke-all`,
      requiresAuth: true,
      // Declared and gated exactly like the list above, for the same reason: ending your own
      // sessions is the one security action that must never depend on a grant somebody else
      // controls, and a pending merchant's account needs it most of all.
      allowUnapprovedAccount: true,
      handler: async (ctx): Promise<RouteResult> => {
        const user = authenticatedUser(ctx);
        const currentSessionId = ctx.auth?.sessionId ?? '';
        const outcome = await deps.sessionService.revokeAllSessions(
          user.id,
          currentSessionId,
          sessionMeta(ctx)
        );

        return {
          status: 200,
          body: {
            success: true,
            revokedSessions: outcome.revokedSessions,
            // Nothing is kept alive, this request's own session included: the next call with the
            // token that asked will be refused, and the client is told so rather than finding
            // out on its next request.
            currentSessionRevoked: outcome.currentSessionRevoked,
            message:
              'Every session for this account has been ended, including this one. Sign in again to continue.'
          }
        };
      }
    }
  ];
}
