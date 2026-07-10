import type { FastifyInstance } from 'fastify';
import { ok, fail } from '../http/envelope';
import { registry } from '../metrics';

/**
 * Health surface:
 *  - /health   liveness (process up). Docker HEALTHCHECK.
 *  - /ready    readiness gated on the SOURCE OF TRUTH (Postgres). The Caddy routing gate.
 *  - /degraded Redis (rate limiter) — an ALERT signal, never pulls a replica.
 * Redis is not on the stock path, so its outage must not fail readiness.
 */
export async function healthPlugin(app: FastifyInstance): Promise<void> {
  app.get('/health', { config: { public: true } }, async (req) => ok({ status: 'up' }, req.id));

  app.get('/ready', { config: { public: true } }, async (req, reply) => {
    try {
      await app.pg.query('SELECT 1');
      return ok({ status: 'ready' }, req.id);
    } catch (err) {
      app.log.error({ err }, 'not ready');
      return reply
        .code(503)
        .send(fail({ code: 'SERVICE_UNAVAILABLE', message: 'Postgres unavailable.' }, req.id));
    }
  });

  app.get('/degraded', { config: { public: true } }, async (req) => {
    const redis = await app.redis
      .ping()
      .then(() => true)
      .catch(() => false);
    return ok({ redis }, req.id);
  });

  if (app.config.env.METRICS_ENABLED) {
    app.get('/metrics', { config: { public: true } }, async (_req, reply) => {
      reply.header('Content-Type', registry.contentType);
      return registry.metrics();
    });
  }
}
