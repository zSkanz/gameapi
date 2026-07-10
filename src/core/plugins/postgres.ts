import { Pool, type PoolConfig } from 'pg';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/env';

/**
 * Build a pg Pool from DATABASE_URL, taking the password from the resolved secret
 * (PGPASSWORD_FILE / PGPASSWORD) when present.
 *
 * IMPORTANT: we parse DATABASE_URL into DISCRETE fields instead of passing
 * `connectionString` + `password` together. node-postgres merges a connectionString
 * OVER the rest of the config (Object.assign({}, config, parse(connectionString))), so a
 * password embedded in the URL silently wins and the docker-secret password is discarded.
 * Discrete fields make precedence unambiguous — the secret always wins.
 */
export function createPool(config: AppConfig): Pool {
  const url = new URL(config.env.DATABASE_URL);
  const urlPassword = url.password ? decodeURIComponent(url.password) : undefined;
  const sslmode = url.searchParams.get('sslmode');

  const poolConfig: PoolConfig = {
    host: url.hostname || undefined,
    port: url.port ? Number(url.port) : 5432,
    user: url.username ? decodeURIComponent(url.username) : undefined,
    database:
      url.pathname && url.pathname !== '/' ? decodeURIComponent(url.pathname.slice(1)) : undefined,
    // secret (PGPASSWORD_FILE) wins; fall back to the URL password for local dev
    password: config.pgPassword ?? urlPassword,
    max: config.env.PG_POOL_MAX,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    // Keep statements bounded so a stuck query cannot pin a connection forever.
    statement_timeout: 5_000,
    ssl:
      sslmode && sslmode !== 'disable'
        ? { rejectUnauthorized: sslmode === 'verify-full' || sslmode === 'verify-ca' }
        : undefined,
  };
  return new Pool(poolConfig);
}

/** Decorate the app with a shared pg Pool and drain it on shutdown. */
export async function postgresPlugin(app: FastifyInstance): Promise<void> {
  const pool = createPool(app.config);
  pool.on('error', (err) => app.log.error({ err }, 'pg pool error'));
  app.decorate('pg', pool);
  app.addHook('onClose', async () => {
    await pool.end().catch(() => {});
  });
}
