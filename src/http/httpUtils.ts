import type { IncomingMessage } from 'node:http';
import type { Permission } from '../auth/rbac';
import { UnauthorizedError, ValidationError } from '../core/errors';
import type { UserRecord } from '../db/schema';

export const MAX_BODY_BYTES = 64 * 1024;

export interface AuthContext {
  user: UserRecord;
  /** The session the presented access token belongs to; verified live before the handler runs. */
  sessionId: string;
}

export interface RequestContext {
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  /**
   * The address this request is attributed to, used for rate limiting and session
   * auditing: the socket address, or the client a trusted proxy's forwarded chain proves
   * (see src/http/clientIp.ts).
   */
  clientIp: string;
  /**
   * The scheme the client used, when a trusted proxy disclosed it (RFC 7239 `proto`) —
   * the protocol of the connection the attributed address came from, not of some later
   * hop. Absent when nothing disclosed it, which is different from "http".
   */
  protocol?: string;
  /** The host the client addressed, when a trusted proxy disclosed it (RFC 7239 `host`). */
  host?: string;
  requestId: string;
  body: Record<string, unknown>;
  auth?: AuthContext;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

export type RouteMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface Route {
  method: RouteMethod;
  path: string;
  /** Rejects unauthenticated callers with 401 before the handler runs. */
  requiresAuth?: boolean;
  /** Requires the authenticated role to hold this permission (403 otherwise). */
  permission?: Permission;
  /**
   * Lets an account that is still awaiting review (or was rejected) through. Off by
   * default, so a pending merchant or rider holds no role permissions until approved;
   * only status-checking routes such as `/auth/me` opt in.
   */
  allowUnapprovedAccount?: boolean;
  handler: (ctx: RequestContext) => Promise<RouteResult>;
}

/**
 * Audit fields for a session or review decision, taken from the request.
 *
 * The session id travels with the address and the device string so that every audit row a
 * request writes says which login wrote it: `userId` answers "which account did this", and
 * this answers the next question an incident asks, "which of that account's devices did it".
 * It is absent, not invented, when the request was not authenticated by a bearer token —
 * login, refresh, logout and the OTP routes have no session behind them at this point, and a
 * row that guessed one would be worse than a row that says nothing.
 */
export function sessionMetaFromRequest(ctx: RequestContext): {
  ipAddress?: string;
  userAgent?: string;
  sessionId?: string;
} {
  const userAgent = ctx.headers['user-agent'];
  return {
    ipAddress: ctx.clientIp,
    userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent,
    sessionId: ctx.auth?.sessionId
  };
}

export function authenticatedUser(ctx: RequestContext): UserRecord {
  if (!ctx.auth) {
    throw new UnauthorizedError('Authentication required');
  }
  return ctx.auth.user;
}

export function matchPath(template: string, pathname: string): Record<string, string> | null {
  const templateParts = template.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (templateParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < templateParts.length; i += 1) {
    const expected = templateParts[i];
    if (expected.startsWith(':')) {
      try {
        params[expected.slice(1)] = decodeURIComponent(pathParts[i]);
      } catch {
        // A segment that is not valid percent-encoding cannot name anything here. Letting
        // the URIError escape answered a malformed request with 500 and an error log; the
        // route simply does not match instead.
        return null;
      }
    } else if (expected !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`Field '${field}' is required and must be a non-empty string`, { field });
  }
  return value.trim();
}

export function requireNumber(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`Field '${field}' is required and must be a finite number`, { field });
  }
  return value;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      throw new ValidationError(`Request body exceeds the maximum of ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Methods whose handler reads a JSON body. The router and the reader both consult this, so
 * a new write method cannot end up matched but silently bodiless.
 */
export function methodHasBody(method: string): boolean {
  return method === 'POST' || method === 'PATCH';
}

/**
 * The request's declared media type, without parameters, lowercased.
 */
function contentTypeOf(req: IncomingMessage): string {
  const raw = req.headers['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * A body, as an object, whoever sent it.
 *
 * JSON is the contract, but one caller is not a client we control: the SMS gateway posting a
 * delivery report, whose own outbound calls are form-encoded and which commonly offers only a
 * form-encoded POST or a query string as a callback. Refusing that shape with "not valid JSON"
 * would leave the report undispatched for a request that is perfectly well-formed — and the
 * values are strings either way, which is what every route's own validation already handles.
 * Nothing else about the reader changes: the size bound, the object requirement and the
 * rejection of anything else as malformed all still apply.
 */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!methodHasBody(req.method ?? '')) return {};
  const raw = await readBody(req);
  if (raw.trim() === '') return {};

  if (contentTypeOf(req) === 'application/x-www-form-urlencoded') {
    const form: Record<string, unknown> = {};
    for (const [key, value] of new URLSearchParams(raw)) {
      form[key] = value;
    }
    return form;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('Request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}
