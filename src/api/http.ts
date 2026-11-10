// JSON response helpers with conservative headers.

import type { ErrorCode, ErrorResponse } from './contracts.ts';

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function error(status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}): Response {
  const body: ErrorResponse = { error: { code, message }, demonstrationsAvailable: true };
  return json(status, body, headers);
}
