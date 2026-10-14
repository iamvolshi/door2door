import {
  API_PREFIX,
  parseLimit,
  parsePhoneQuery,
  parseSince,
} from './adminShared.js';
import type { AdminRouteDeps } from './adminShared.js';
import type {
  Route,
  RouteResult,
} from '../../httpUtils';

export function createPhoneLoginRoutes(deps: AdminRouteDeps): Route[] {
  return [
  {
    method: 'GET',
    path: `${API_PREFIX}/admin/phone-logins`,
    requiresAuth: true,
    permission: 'otp:read',
    handler: async (ctx): Promise<RouteResult> => {
      const phone = parsePhoneQuery(ctx.query.get('phone'));
      const since = parseSince(ctx.query.get('since'));
      const limit = parseLimit(ctx.query.get('limit'));
      const activities = await deps.otpDeliveryRepo.findRecentLoginActivity({
        phone: phone ?? undefined,
        since,
        limit
      });

      return {
        status: 200,
        body: {
          success: true,
          count: activities.length,
          phone,
          since: since ?? null,
          activities: activities.map((row) => ({
            phone: row.phone,
            attempts: row.attempts,
            lockedOut: row.lockedOut,
            codeLive: row.codeLive,
            createdAt: row.createdAt
          }))
        }
      };
    }
  },
  ];
}
