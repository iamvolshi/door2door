import { ValidationError } from '../../core/errors';
import type { NotificationRepository } from '../../db/repositories';
import type { NotificationRecord } from '../../db/schema';
import { authenticatedUser, type Route, type RouteResult } from '../httpUtils';

const API_PREFIX = '/api/v1';

/** How many notices a caller gets when it does not ask, and the most it may ask for. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface NotificationRouteDeps {
  notificationRepo: NotificationRepository;
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new ValidationError(
      `Query 'limit' must be an integer between 1 and ${MAX_LIMIT}`,
      { field: 'limit' }
    );
  }
  return value;
}

/**
 * The incident blob is a convenience for the client, never the message: a notice whose
 * details cannot be parsed still reads correctly, so a malformed blob is reported as absent
 * rather than turning the list into a 500.
 */
function parseDetails(raw?: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function serializeNotification(record: NotificationRecord): Record<string, unknown> {
  const readAt = record.readAt ?? null;
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    body: record.body,
    details: parseDetails(record.details),
    createdAt: record.createdAt,
    readAt,
    read: readAt !== null
  };
}

/**
 * Read ids out of a request body. `undefined` means "every notice", which is different from
 * an empty list, so an explicit empty array is refused rather than silently meaning all.
 */
function parseIds(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new ValidationError("Field 'ids' must be an array of notice ids", { field: 'ids' });
  }
  if (raw.length === 0) {
    throw new ValidationError(
      "Field 'ids' must name at least one notice, or be omitted to read every notice",
      { field: 'ids' }
    );
  }
  if (raw.length > MAX_LIMIT) {
    throw new ValidationError(`Field 'ids' may name at most ${MAX_LIMIT} notices`, {
      field: 'ids'
    });
  }
  return raw.map((value) => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ValidationError("Every entry of 'ids' must be a non-empty string", { field: 'ids' });
    }
    return value.trim();
  });
}

/**
 * The account holder's own notice list: warnings the platform owes them, readable after
 * signing in.
 *
 * This is the second channel beside SMS (see src/auth/securityNotices.ts), and it exists
 * because the SMS one cannot always deliver: with no provider configured, no handset, or a
 * gateway that refuses the message, the warning still has to reach the person it is about.
 * Both routes keep every query keyed to the token owner, so the list is a private one and a
 * caller cannot read or acknowledge anybody else's notice by naming its id.
 *
 * Neither route carries a route-level permission, for the same reason `/auth/me` does not:
 * a caller is reading its own record, so the permission would have to be one every role
 * holds — including an account still awaiting review, which has notices of its own and no
 * role permissions at all. What protects the rows is the token owner in the WHERE clause,
 * not a grant; see the declaration and exemption in tests/routeAuthorization.test.ts.
 */
export function createNotificationRoutes(deps: NotificationRouteDeps): Route[] {
  return [
    {
      method: 'GET',
      path: `${API_PREFIX}/notifications`,
      requiresAuth: true,
      // An account still awaiting review has the same need for its own warnings as anybody
      // else: a burned session does not wait for an administrator.
      allowUnapprovedAccount: true,
      handler: async (ctx): Promise<RouteResult> => {
        const user = authenticatedUser(ctx);
        const limit = parseLimit(ctx.query.get('limit'));
        // Left unread is the state a caller usually cares about, but the list defaults to
        // everything: a warning that scrolls out of an unread view is still worth finding.
        const unreadOnly = ctx.query.get('unreadOnly') === 'true';

        const page = await deps.notificationRepo.listForUser(user.id, { limit, unreadOnly });

        return {
          status: 200,
          body: {
            success: true,
            count: page.items.length,
            unreadCount: page.unreadCount,
            notifications: page.items.map(serializeNotification)
          }
        };
      }
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/notifications/read`,
      requiresAuth: true,
      allowUnapprovedAccount: true,
      handler: async (ctx): Promise<RouteResult> => {
        const user = authenticatedUser(ctx);
        const ids = parseIds(ctx.body.ids);

        const markedRead = await deps.notificationRepo.markRead(user.id, ids);
        // Reported rather than assumed: a second acknowledgement reports 0 changed, and the
        // unread count is what the caller's next render needs.
        return {
          status: 200,
          body: {
            success: true,
            markedRead,
            unreadCount: await deps.notificationRepo.countUnread(user.id)
          }
        };
      }
    }
  ];
}
