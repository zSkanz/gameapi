import type { FastifyInstance } from 'fastify';
import { Errors } from '../errors/app-error';

/**
 * Sliding-window-counter rate limiter (no Lua). Weights the previous fixed window by how
 * much of it still overlaps, so it avoids the 2x burst a plain fixed window allows at the
 * minute boundary. Per API key + per game (fairness). FAILS OPEN if Redis is unreachable.
 */
export async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  const { env } = app.config;
  const prefix = env.REDIS_KEY_PREFIX;
  const WINDOW_MS = 60_000;

  async function take(id: string, limit: number, cost = 1): Promise<void> {
    const now = Date.now(); // all containers share the VPS host clock
    const win = Math.floor(now / WINDOW_MS);
    const elapsed = now % WINDOW_MS;
    const curKey = `${prefix}rl:${id}:${win}`;
    const prevKey = `${prefix}rl:${id}:${win - 1}`;

    const res = await app.redis.multi().incrby(curKey, cost).expire(curKey, 120).get(prevKey).exec();
    const cur = Number(res?.[0]?.[1] ?? 0);
    const prev = Number(res?.[2]?.[1] ?? 0);

    const estimate = cur + prev * ((WINDOW_MS - elapsed) / WINDOW_MS);
    if (estimate > limit) throw Errors.rateLimited(Math.max(1, Math.ceil((WINDOW_MS - elapsed) / 1000)));
  }

  /**
   * The same sliding window for anything else worth metering — the Roblox module charges its cache
   * misses here. `cost` lets one request spend more than one unit (a batch of 100 uncached ids).
   * Throws RATE_LIMITED; like the request limiter, a Redis failure lets the call through.
   */
  app.decorate('rateLimit', async (id: string, limit: number, cost = 1): Promise<void> => {
    try {
      await take(id, limit, cost);
    } catch (err) {
      if (err instanceof Error && err.name === 'AppError') throw err;
      app.log.warn({ err, id }, 'rate limiter unavailable — failing open');
    }
  });

  app.addHook('onRequest', async (req) => {
    if (req.routeOptions.config?.public) return;
    const principal = req.principal;
    if (!principal) return; // auth already rejected

    const gameId = (req.params as { gameId?: string } | undefined)?.gameId;
    try {
      if (req.routeOptions.config?.rateLimitBucket === 'config-poll') {
        // Config polls: every server of a game, every 15s, on one key. Metered on their own so a
        // big fleet polling cannot push the key over the limit its purchases depend on. 10x the
        // key budget is ~15,000 servers at the default interval.
        await take(`poll:key:${principal.keyId}`, env.RATE_LIMIT_KEY_PER_MIN * 10);
        return;
      }
      await take(`key:${principal.keyId}`, env.RATE_LIMIT_KEY_PER_MIN);
      if (gameId) await take(`game:${gameId}`, env.RATE_LIMIT_GAME_PER_MIN);
    } catch (err) {
      if (err instanceof Error && err.name === 'AppError') throw err; // real 429
      app.log.warn({ err }, 'rate limiter unavailable — failing open');
    }
  });
}
