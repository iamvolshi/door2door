import { serializeStatusAccount } from './adminSerializers.js';
import { API_PREFIX } from './adminShared.js';
import type { AdminRouteDeps } from './adminShared.js';
import {
  authenticatedUser,
  sessionMetaFromRequest,
  type Route,
  type RouteResult,
} from '../../httpUtils';

export function createUserModerationRoutes(deps: AdminRouteDeps): Route[] {
  return [
  {
    method: 'POST',
    path: `${API_PREFIX}/admin/users/:userId/suspend`,
    requiresAuth: true,
    permission: 'system:manage',
    handler: async (ctx): Promise<RouteResult> => {
      const admin = authenticatedUser(ctx);
      const reason = typeof ctx.body.reason === 'string' ? ctx.body.reason : '';
      const { user, revokedSessions } = await deps.accountStatus.suspend(
        ctx.params.userId,
        admin,
        reason,
        sessionMetaFromRequest(ctx)
      );
      return {
        status: 200,
        body: { success: true, account: serializeStatusAccount(user), revokedSessions }
      };
    }
  },
  {
    method: 'POST',
    path: `${API_PREFIX}/admin/users/:userId/reinstate`,
    requiresAuth: true,
    permission: 'system:manage',
    handler: async (ctx): Promise<RouteResult> => {
      const admin = authenticatedUser(ctx);
      const { user, revokedSessions } = await deps.accountStatus.reinstate(
        ctx.params.userId,
        admin,
        sessionMetaFromRequest(ctx)
      );
      return {
        status: 200,
        body: { success: true, account: serializeStatusAccount(user), revokedSessions }
      };
    }
  },
  ];
}
