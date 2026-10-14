import { serializeSecurityNotice } from './adminSerializers.js';
import {
  API_PREFIX,
  isNoticeFollowUp,
  isNoticeLockedOut,
  noticeOutOfBandState,
  parseBooleanFilter,
  parseNoticeLimit,
  parseNoticeStateFilter,
  parseNoticeTypeFilter,
  parseSince,
  summarizeNotices,
} from './adminShared.js';
import type { AdminRouteDeps } from './adminShared.js';
import type {
  Route,
  RouteResult,
} from '../../httpUtils';

export function createSecurityNoticeRoutes(deps: AdminRouteDeps): Route[] {
  return [
  {
    method: 'GET',
    path: `${API_PREFIX}/admin/security-notices`,
    requiresAuth: true,
    permission: 'audit:read',
    handler: async (ctx): Promise<RouteResult> => {
      const type = parseNoticeTypeFilter(ctx.query.get('type'));
      const rawUserId = ctx.query.get('userId');
      const userId = rawUserId === null || rawUserId.trim() === '' ? undefined : rawUserId.trim();
      const state = parseNoticeStateFilter(ctx.query.get('state'));
      const followUpOnly = parseBooleanFilter(ctx.query.get('followUpOnly'), 'followUpOnly');
      const lockedOutOnly = parseBooleanFilter(ctx.query.get('lockedOutOnly'), 'lockedOutOnly');
      const since = parseSince(ctx.query.get('since'));
      const limit = parseNoticeLimit(ctx.query.get('limit'));

      // The account and time filters scope the set the summary counts; the state and
      // worklist filters narrow only the page, so the ratio beside it survives.
      const scoped = await deps.notificationRepo.listOperatorNotices({
        ...(type === undefined ? {} : { type }),
        ...(userId === undefined ? {} : { userId }),
        ...(since === undefined ? {} : { since })
      });
      const summary = summarizeNotices(scoped);

      let entries = scoped;
      if (state !== undefined) {
        entries = entries.filter((notice) => noticeOutOfBandState(notice) === state);
      }
      if (followUpOnly) entries = entries.filter(isNoticeFollowUp);
      if (lockedOutOnly) entries = entries.filter(isNoticeLockedOut);
      entries = entries.slice(0, limit);

      return {
        status: 200,
        body: {
          success: true,
          count: entries.length,
          notices: entries.map(serializeSecurityNotice),
          summary
        }
      };
    }
  }
  ];
}
