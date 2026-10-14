import {
  serializeRegistration,
  serializeProfile,
  serializeReadiness,
} from './adminSerializers.js';
import {
  API_PREFIX,
  parseApprovableFilter,
  parseApprovalAddress,
  parseApprovalRider,
  parseReviewLimit,
  parseRoleFilter,
  parseStatusFilter,
} from './adminShared.js';
import type { AdminRouteDeps } from './adminShared.js';
import {
  authenticatedUser,
  sessionMetaFromRequest,
  type Route,
  type RouteResult,
} from '../../httpUtils';

export function createRegistrationRoutes(deps: AdminRouteDeps): Route[] {
  return [
  {
    method: 'GET',
    path: `${API_PREFIX}/admin/registrations`,
    requiresAuth: true,
    permission: 'registration:read',
    handler: async (ctx): Promise<RouteResult> => {
      const status = parseStatusFilter(ctx.query.get('status'));
      const role = parseRoleFilter(ctx.query.get('role'));
      const approvable = parseApprovableFilter(ctx.query.get('approvable'));
      const limit = parseReviewLimit(ctx.query.get('limit'));

      const applications = await deps.registrationService.list({ status, role, limit });

      // The judgement is made here rather than stored: it depends on the account (a store
      // that already exists clears every merchant blocker) and on the rest of the platform
      // (whether its trade licence now belongs to somebody else).
      const assessed = await Promise.all(
        applications.map(async (user) => ({
          user,
          readiness: await deps.registrationService.readiness(user)
        }))
      );

      const blocked = assessed.filter((entry) => !entry.readiness.approvable).length;
      const page =
        approvable === undefined
          ? assessed
          : assessed.filter((entry) => entry.readiness.approvable === approvable);

      return {
        status: 200,
        body: {
          success: true,
          count: page.length,
          // Counted over the status and role filters alone, so the ratio between workable
          // and blocked applications survives narrowing the list to one of them. It covers
          // the applications this response assessed, which is what `possiblyTruncated`
          // admits to: a bounded answer says it is bounded instead of reading like a
          // complete one.
          summary: {
            count: assessed.length,
            approvable: assessed.length - blocked,
            blocked,
            possiblyTruncated: applications.length === limit
          },
          registrations: page.map((entry) => ({
            ...serializeRegistration(entry.user),
            readiness: serializeReadiness(entry.readiness)
          }))
        }
      };
    }
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/admin/registrations/:userId/approve`,
    requiresAuth: true,
    permission: 'registration:review',
    handler: async (ctx): Promise<RouteResult> => {
      const address = parseApprovalAddress(ctx.body);
      const rider = parseApprovalRider(ctx.body);

      const { user, profile } = await deps.registrationService.review(
        ctx.params.userId,
        'APPROVE',
        authenticatedUser(ctx),
        undefined,
        sessionMetaFromRequest(ctx),
        { ...(address ? { address } : {}), ...(rider ? { rider } : {}) }
      );

      return {
        status: 200,
        body: {
          success: true,
          registration: serializeRegistration(user),
          // What the approval created, so a failed or skipped profile is visible here
          // rather than only discoverable when dispatch finds nothing.
          profile: serializeProfile(profile)
        }
      };
    }
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/admin/registrations/:userId/reject`,
    requiresAuth: true,
    permission: 'registration:review',
    handler: async (ctx): Promise<RouteResult> => {
      // The refusal is the review: it records the decision, the reason and the reviewer,
      // and raises the notice that tells the applicant a human looked and said no.
      const { user } = await deps.registrationService.review(
        ctx.params.userId,
        'REJECT',
        authenticatedUser(ctx),
        typeof ctx.body.reason === 'string' ? ctx.body.reason : '',
        sessionMetaFromRequest(ctx)
      );

      return {
        status: 200,
        body: {
          success: true,
          registration: serializeRegistration(user)
        }
      };
    }
  },
  ];
}
