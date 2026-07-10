import IORedis, { type Redis, type RedisOptions } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/env';

/**
 * Build the Redis client from REDIS_URL, taking the password from the resolved secret
 * (REDIS_PASSWORD_FILE / REDIS_PASSWORD) when present.
 *
 * Parsed into DISCRETE fields rather than passing the URL string + password option:
 * ioredis merges via defaults(options, parseURL(url)), so a password in the URL can win
 * over the explicit option and discard the secret. Discrete fields make the secret win.
 */
export function createRedis(config: AppConfig): Redis {
  const url = new URL(config.env.REDIS_URL);
  const urlPassword = url.password ? decodeURIComponent(url.password) : undefined;
  const db = url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : 0;

  const options: RedisOptions = {
    host: url.hostname || '127.0.0.1',
    port: url.port ? Number(url.port) : 6379,
    db: Number.isFinite(db) ? db : 0,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    // secret (REDIS_PASSWORD_FILE) wins; fall back to the URL password
    password: config.redisPassword ?? urlPassword,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    // Fail fast instead of queueing while down — the stock hot path turns a fast
    // failure into a fail-open (rate limiter skips) rather than a stampede on recovery.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    connectTimeout: 3_000,
    commandTimeout: 3_000,
    lazyConnect: false,
  };
  return new IORedis(options);
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
