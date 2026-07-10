import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/env';

export function createPool(config: AppConfig): Pool {
  return new Pool({
    connectionString: config.env.DATABASE_URL,
    password: config.pgPassword,
    max: config.env.PG_POOL_MAX,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    // Keep statements bounded so a stuck fallback query cannot pin a connection forever.
    statement_timeout: 5_000,
  });
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
