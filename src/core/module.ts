import type { FastifyInstance } from 'fastify';

/**
 * A resource system (stock, serial, funnel, config, roblox, ...). Each module is a self-contained
 * Fastify plugin mounted at /v1/games/:gameId/<name>. It inherits auth, rate limiting,
 * idempotency, and the response envelope for free.
 *
 * The shape: index.ts (this object) -> <name>.routes.ts -> <name>.repository.ts, plus
 * <name>.schemas.ts when the routes need their own zod schemas and sql/NNN_*.sql for tables.
 * Only the repository touches Postgres. There is deliberately no service layer: routes call the
 * repository directly, and a pass-through class in between would only add a file to edit.
 */
export interface ResourceModule {
  /** URL segment + logical namespace, e.g. 'stock'. */
  name: string;
  /** Register routes (and any hooks) on the already-prefixed scope. */
  register(scope: FastifyInstance): Promise<void> | void;
}
