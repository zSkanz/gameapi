import type { ZodTypeAny } from 'zod';

/** Optional per-route documentation metadata, attached via route `config.docs`. */
export interface RouteDoc {
  summary?: string;
  group?: string; // section header, e.g. 'Stock'
  idempotency?: boolean; // requires an Idempotency-Key header
  params?: Record<string, string>; // path param -> description
  body?: ZodTypeAny; // request body schema (rendered to JSON Schema automatically)
  requestExample?: unknown; // concrete example body (falls back to one generated from the schema)
  responseExample?: unknown;
}

/** A route captured by the onRoute hook. */
export interface CollectedRoute {
  method: string;
  url: string;
  public: boolean; // no x-api-key required
  doc?: RouteDoc;
}

/** A fully-resolved endpoint entry for the docs catalog. */
export interface EndpointDoc {
  method: string;
  path: string;
  group: string;
  summary: string;
  auth: boolean;
  idempotency: boolean;
  params?: Record<string, string>;
  body?: unknown; // JSON Schema
  requestExample?: unknown;
  responseExample?: unknown;
}
