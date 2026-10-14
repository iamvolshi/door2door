import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from '../src/server';

/** Identifiers and phone numbers of the pilot dataset seeded by src/db/seed.ts. */
export const SEEDED = {
  admin: { id: 'usr_admin_001', phone: '+8801811000001' },
  merchant: { id: 'usr_merch_001', phone: '+8801811000002' },
  driver: { id: 'usr_driv_001', phone: '+8801811000003' },
  customer: { id: 'usr_cust_001', phone: '+8801811000004' },
  merchantId: 'merch_store_001',
  addressId: 'addr_cust_001',
  rupchandaId: 'cat_item_001', // 750 BDT
  coralId: 'cat_item_002' // 650 BDT
} as const;

export interface ApiResponse {
  status: number;
  body: any;
}

export interface RequestOptions {
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
}

export async function apiRequest(
  target: RunningServer,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: RequestOptions = {}
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const response = await fetch(`${target.url}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
  });

  return { status: response.status, body: await response.json() };
}

export function postJson(
  target: RunningServer,
  path: string,
  body: unknown,
  options: Omit<RequestOptions, 'body'> = {}
): Promise<ApiResponse> {
  return apiRequest(target, 'POST', path, { ...options, body });
}

export function getJson(
  target: RunningServer,
  path: string,
  options: Omit<RequestOptions, 'body'> = {}
): Promise<ApiResponse> {
  return apiRequest(target, 'GET', path, options);
}

export function patchJson(
  target: RunningServer,
  path: string,
  body: unknown,
  options: Omit<RequestOptions, 'body'> = {}
): Promise<ApiResponse> {
  return apiRequest(target, 'PATCH', path, { ...options, body });
}

export function deleteJson(
  target: RunningServer,
  path: string,
  options: Omit<RequestOptions, 'body'> = {}
): Promise<ApiResponse> {
  return apiRequest(target, 'DELETE', path, options);
}

export interface LoggedInAccount {
  accessToken: string;
  refreshToken: string;
  user: any;
  devOtp: string;
}

/**
 * Completes the full OTP flow for a seeded phone number. Fails loudly if the
 * development OTP is not returned, rather than passing silently.
 */
export async function login(target: RunningServer, phone: string): Promise<LoggedInAccount> {
  const request = await postJson(target, '/api/v1/auth/otp/request', { phone });
  if (request.status !== 200) {
    throw new Error(`OTP request failed (${request.status}): ${JSON.stringify(request.body)}`);
  }
  const devOtp = request.body.devOtp;
  if (!devOtp) {
    throw new Error(`No devOtp returned: ${JSON.stringify(request.body)}`);
  }

  const verify = await postJson(target, '/api/v1/auth/otp/verify', { phone, otp: devOtp });
  if (verify.status !== 200) {
    throw new Error(`OTP verification failed (${verify.status}): ${JSON.stringify(verify.body)}`);
  }

  return {
    accessToken: verify.body.tokens.accessToken,
    refreshToken: verify.body.tokens.refreshToken,
    user: verify.body.user,
    devOtp
  };
}

export function createTempDatabaseDir(): string {
  return mkdtempSync(join(tmpdir(), 'cxb-api-test-'));
}

export function removeTempDatabaseDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export { startServer, type RunningServer };
