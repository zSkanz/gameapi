import type { FastifyInstance } from 'fastify';
import { Errors } from '../errors/app-error';

/**
 * Fixed-window rate limiter using plain Redis INCR + EXPIRE (no Lua). Two windows per
 * request — per API key and per game (fairness). The limiter FAILS OPEN: if Redis is
 * unreachable we skip limiting rather than block traffic (Redis is not the source of
 * truth here — Postgres is).
 */
export async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  const { env } = app.config;
  const prefix = env.REDIS_KEY_PREFIX;
  const WINDOW_SEC = 60;

  async function take(bucket: string, limit: number): Promise<void> {
    const n = await app.redis.incr(bucket);
    if (n === 1) await app.redis.expire(bucket, WINDOW_SEC);
    if (n > limit) {
      const ttl = await app.redis.ttl(bucket);
      throw Errors.rateLimited(Math.max(1, ttl));
    }
  }

  app.addHook('onRequest', async (req) => {
    if (req.routeOptions.config?.public) return;
    const principal = req.principal;
    if (!principal) return; // auth already rejected

    const gameId = (req.params as { gameId?: string } | undefined)?.gameId;
    try {
      await take(`${prefix}rl:key:${principal.keyId}`, env.RATE_LIMIT_KEY_PER_MIN);
      if (gameId) await take(`${prefix}rl:game:${gameId}`, env.RATE_LIMIT_GAME_PER_MIN);
    } catch (err) {
      if (err instanceof Error && err.name === 'AppError') throw err; // real 429
      app.log.warn({ err }, 'rate limiter unavailable — failing open');
    }
  });
}
