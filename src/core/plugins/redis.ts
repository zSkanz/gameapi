import IORedis, { type Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/env';

export function createRedis(config: AppConfig): Redis {
  return new IORedis(config.env.REDIS_URL, {
    password: config.redisPassword,
    // Fail fast instead of queueing while down — the stock hot path turns a fast
    // failure into the Postgres fallback rather than a stampede on recovery.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    connectTimeout: 3_000,
    commandTimeout: 3_000,
    lazyConnect: false,
  });
}

/** Decorate the app with a shared Redis client and close it on shutdown. */
export async function redisPlugin(app: FastifyInstance): Promise<void> {
  const redis = createRedis(app.config);
  redis.on('error', (err) => app.log.error({ err }, 'redis error'));
  app.decorate('redis', redis);
  app.addHook('onClose', async () => {
    await redis.quit().catch(() => redis.disconnect());
  });
}
