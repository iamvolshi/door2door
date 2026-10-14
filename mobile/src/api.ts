import * as SecureStore from 'expo-secure-store';
import { API_BASE_URL } from './config';

export const REFRESH_TOKEN_KEY = 'cxb.refreshToken';
export const ORDER_IDS_KEY = 'cxb.orderIds';

export class ApiError extends Error {
  status: number;
  code: string;
  details: any;
  retryAfter: number | null;
  constructor(status: number, code: string, message: string, details: any, retryAfter: number | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

/** Follows the mobile contract in docs/API.md: one refresh in flight, reuse is terminal. */
class ApiClient {
  accessToken: string | null = null;
  onAuthLost: (() => void) | null = null;
  private refreshPromise: Promise<boolean> | null = null;

  setAccessToken(token: string | null) {
    this.accessToken = token;
  }

  async request(
    method: string,
    path: string,
    opts: { body?: unknown; auth?: boolean; idempotencyKey?: string } = {},
    retried = false
  ): Promise<any> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth && this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const retryAfter = response.headers.get('retry-after');
    let data: any = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (response.ok) return data;

    const err = data?.error ?? {};
    const code: string = err.code ?? 'UNKNOWN';
    const details = err.details ?? null;

    // Access token expired but the session may be fine: exactly one refresh goes out,
    // concurrent requests share it, and the original call is retried once.
    if (response.status === 401 && opts.auth && code === 'UNAUTHORIZED' && !retried) {
      const refreshed = await this.refreshOnce();
      if (refreshed) return this.request(method, path, opts, true);
    }

    // Spent refresh token (theft or a lost refresh race): the family is burned. Wipe
    // everything and force a fresh login — never loop here.
    if (response.status === 401 && (code === 'REFRESH_TOKEN_REUSE' || (opts.auth && retried))) {
      await this.signOutLocal();
    }

    throw new ApiError(
      response.status,
      code,
      err.message ?? `Request failed (${response.status})`,
      details,
      retryAfter !== null ? Number(retryAfter) : (details?.retryAfterSeconds ?? null)
    );
  }

  private refreshOnce(): Promise<boolean> {
    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        try {
          const stored = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
          if (!stored) return false;
          const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ refreshToken: stored }),
          });
          const data = await response.json().catch(() => null);
          if (!response.ok || !data?.tokens) {
            await this.signOutLocal();
            return false;
          }
          this.accessToken = data.tokens.accessToken;
          await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, data.tokens.refreshToken);
          return true;
        } catch {
          return false;
        } finally {
          this.refreshPromise = null;
        }
      })();
    }
    return this.refreshPromise;
  }

  async signOutLocal() {
    this.accessToken = null;
    try {
      await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
    } catch {
      /* already gone */
    }
    this.onAuthLost?.();
  }

  get(path: string, auth = true) {
    return this.request('GET', path, { auth });
  }

  post(path: string, body?: unknown, opts: { auth?: boolean; idempotencyKey?: string } = {}) {
    return this.request('POST', path, { body, auth: opts.auth ?? true, idempotencyKey: opts.idempotencyKey });
  }
}

export const api = new ApiClient();

export function newIdempotencyKey(): string {
  return 'app-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

export async function rememberOrderId(orderId: string) {
  try {
    const raw = await SecureStore.getItemAsync(ORDER_IDS_KEY);
    const ids: string[] = raw ? JSON.parse(raw) : [];
    if (!ids.includes(orderId)) {
      ids.unshift(orderId);
      await SecureStore.setItemAsync(ORDER_IDS_KEY, JSON.stringify(ids.slice(0, 20)));
    }
  } catch {
    /* tracking is best-effort */
  }
}

export async function savedOrderIds(): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(ORDER_IDS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
