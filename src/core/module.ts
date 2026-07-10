import type { FastifyInstance } from 'fastify';

/**
 * A resource system (stock, and later leaderboards/cooldowns/...). Each module is a
 * self-contained Fastify plugin mounted at /v1/games/:gameId/<name>. It inherits auth,
 * rate limiting, idempotency, and the response envelope for free.
 *
 * The fixed 4-part shape per module: schemas -> routes -> service -> repository
 * (only the repository touches Postgres).
 */
export interface ResourceModule {
  /** URL segment + logical namespace, e.g. 'stock'. */
  name: string;
  /** Register routes on the already-prefixed scope; may also define Lua commands. */
  register(scope: FastifyInstance): Promise<void> | void;
}
