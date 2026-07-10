import type { ErrorCode } from '../errors/app-error';

/** The single response envelope used by every module. */
export interface Meta {
  requestId: string;
  timestamp: string; // ISO-8601 UTC
}

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type ApiResponse<T> =
  | { ok: true; data: T; meta: Meta }
  | { ok: false; error: ApiError; meta: Meta };

function meta(requestId: string): Meta {
  return { requestId, timestamp: new Date().toISOString() };
}

export function ok<T>(data: T, requestId: string): ApiResponse<T> {
  return { ok: true, data, meta: meta(requestId) };
}

export function fail(error: ApiError, requestId: string): ApiResponse<never> {
  return { ok: false, error, meta: meta(requestId) };
}
