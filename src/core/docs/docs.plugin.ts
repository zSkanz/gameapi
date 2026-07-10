import type { FastifyInstance } from 'fastify';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import { ok } from '../http/envelope';
import type { CollectedRoute, RouteDoc, EndpointDoc } from './types';
import { renderDocsHtml } from './render';

/** Cast avoids zod-to-json-schema's deep generic instantiation (TS2589) on ZodTypeAny. */
function jsonSchema(schema: ZodTypeAny): unknown {
  return zodToJsonSchema(schema as never, { target: 'openApi3', $refStrategy: 'none' });
}

/** Build a minimal valid example body from a JSON Schema (fallback when a route gives no
 *  explicit requestExample), so future routes still show a usable example. */
function sampleFromJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return undefined;
  const s = schema as Record<string, unknown>;
  if (s.type === 'object' && s.properties && typeof s.properties === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.properties as Record<string, unknown>)) out[k] = sampleFromJsonSchema(v);
    return out;
  }
  if (s.type === 'integer' || s.type === 'number') {
    const min = typeof s.minimum === 'number' ? s.minimum : 0;
    const max = typeof s.maximum === 'number' ? s.maximum : Number.MAX_SAFE_INTEGER;
    return Math.min(Math.max(1, min), max);
  }
  if (s.type === 'string') return Array.isArray(s.enum) ? s.enum[0] : 'string';
  if (s.type === 'boolean') return true;
  if (s.type === 'array') return [sampleFromJsonSchema(s.items)];
  return null;
}

/**
 * Self-documenting API. An onRoute hook captures every route as it registers, so any new
 * module/route appears automatically. Serves a human page at /docs and JSON at /docs.json.
 * Register this BEFORE other route-owning plugins/modules so it captures them all.
 */
export async function docsPlugin(app: FastifyInstance): Promise<void> {
  const routes: CollectedRoute[] = [];

  app.addHook('onRoute', (r) => {
    const cfg = r.config as { public?: boolean; docs?: RouteDoc } | undefined;
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) {
      routes.push({ method: String(m), url: r.url, public: cfg?.public ?? false, doc: cfg?.docs });
    }
  });

  const build = (): EndpointDoc[] =>
    routes
      .filter((r) => !r.url.startsWith('/docs') && r.method !== 'HEAD')
      .map((r): EndpointDoc => {
        const body = r.doc?.body ? jsonSchema(r.doc.body) : undefined;
        return {
          method: r.method,
          path: r.url,
          group: r.doc?.group ?? (r.public ? 'System' : 'Other'),
          summary: r.doc?.summary ?? '',
          auth: !r.public,
          idempotency: r.doc?.idempotency ?? false,
          params: r.doc?.params,
          body,
          requestExample: r.doc?.requestExample ?? (body ? sampleFromJsonSchema(body) : undefined),
          responseExample: r.doc?.responseExample,
        };
      })
      .sort((a, b) => (a.group + a.path).localeCompare(b.group + b.path));

  app.get('/docs.json', { config: { public: true } }, async (req) =>
    ok({ service: 'GameApi', generatedAt: new Date().toISOString(), endpoints: build() }, req.id),
  );

  app.get('/docs', { config: { public: true } }, async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return renderDocsHtml(build());
  });
}
