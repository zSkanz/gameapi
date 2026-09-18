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

  /**
   * Charge `cost` to every bucket in ONE Redis round trip; 429 at the first one over its limit.
   *
   * Same outcome as checking them one after another: the buckets after the one that refused are
   * refunded, because the sequential version never charged them — a key already over its own limit
   * must not also spend its game's budget, which the game's other keys share.
   */
  async function take(buckets: Array<{ id: string; limit: number }>, cost = 1): Promise<void> {
    const now = Date.now(); // all containers share the VPS host clock
    const win = Math.floor(now / WINDOW_MS);
    const elapsed = now % WINDOW_MS;
    const cur = (id: string) => `${prefix}rl:${id}:${win}`;

    const tx = app.redis.multi();
    for (const b of buckets) tx.incrby(cur(b.id), cost).expire(cur(b.id), 120).get(`${prefix}rl:${b.id}:${win - 1}`);
    const res = await tx.exec();

    const over = buckets.findIndex((b, i) => {
      const count = Number(res?.[i * 3]?.[1] ?? 0);
      const prev = Number(res?.[i * 3 + 2]?.[1] ?? 0);
      return count + prev * ((WINDOW_MS - elapsed) / WINDOW_MS) > b.limit;
    });
    if (over === -1) return;

    const refund = buckets.slice(over + 1);
    if (refund.length > 0) {
      const r = app.redis.multi();
      for (const b of refund) r.decrby(cur(b.id), cost);
      r.exec().catch(() => {}); // best effort; a lost refund over-counts by one request
    }
    throw Errors.rateLimited(Math.max(1, Math.ceil((WINDOW_MS - elapsed) / 1000)));
  }

  /**
   * The same sliding window for anything else worth metering — the Roblox module charges its cache
   * misses here. `cost` lets one request spend more than one unit (a batch of 100 uncached ids).
   * Throws RATE_LIMITED; like the request limiter, a Redis failure lets the call through.
   */
  app.decorate('rateLimit', async (id: string, limit: number, cost = 1): Promise<void> => {
    try {
      await take([{ id, limit }], cost);
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
        await take([{ id: `poll:key:${principal.keyId}`, limit: env.RATE_LIMIT_KEY_PER_MIN * 10 }]);
        return;
      }
      const buckets = [{ id: `key:${principal.keyId}`, limit: env.RATE_LIMIT_KEY_PER_MIN }];
      if (gameId) buckets.push({ id: `game:${gameId}`, limit: env.RATE_LIMIT_GAME_PER_MIN });
      await take(buckets);
    } catch (err) {
      if (err instanceof Error && err.name === 'AppError') throw err; // real 429
      app.log.warn({ err }, 'rate limiter unavailable — failing open');
    }
  });
}
