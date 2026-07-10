import type { FastifyInstance } from 'fastify';
import { httpDuration } from '../metrics';

/** Cross-cutting response hooks: correlation id, security headers, and latency metric. */
export async function httpHooksPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Request-Id', req.id);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unknown';
    httpDuration.labels(req.method, route, String(reply.statusCode)).observe(reply.elapsedTime / 1000);
  });
}
