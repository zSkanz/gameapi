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
      .map((r) => ({
        method: r.method,
        path: r.url,
        group: r.doc?.group ?? (r.public ? 'System' : 'Other'),
        summary: r.doc?.summary ?? '',
        auth: !r.public,
        idempotency: r.doc?.idempotency ?? false,
        params: r.doc?.params,
        body: r.doc?.body ? jsonSchema(r.doc.body) : undefined,
        responseExample: r.doc?.responseExample,
      }))
      .sort((a, b) => (a.group + a.path).localeCompare(b.group + b.path));

  app.get('/docs.json', { config: { public: true } }, async (req) =>
    ok({ service: 'GameApi', generatedAt: new Date().toISOString(), endpoints: build() }, req.id),
  );

  app.get('/docs', { config: { public: true } }, async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return renderDocsHtml(build());
  });
}
