import type { FastifyInstance } from 'fastify';
import { httpDuration } from '../metrics';

/** Cross-cutting response hooks: correlation id, security headers, and latency metric. */
export async function httpHooksPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Request-Id', req.id);
    reply.header('X-Content-Type-Options', 'nosniff');
    // Keyed on the URL, never on handler intent: content-hashed SPA assets are immutable,
    // and everything else may carry a secret (an api key shown once, session state), so no
    // handler is able to opt its response out of no-store.
    reply.header(
      'Cache-Control',
      req.url.startsWith('/panel/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
    );
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unknown';
    httpDuration.labels(req.method, route, String(reply.statusCode)).observe(reply.elapsedTime / 1000);
  });
}
