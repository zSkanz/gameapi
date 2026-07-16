import type { FastifyInstance } from 'fastify';
import { ok } from './http/envelope';
import { requireScope } from './http/guards';
import { ListQuery } from './http/schemas';

/** GET /v1/games — list every registered game (tenant). Cross-game/admin read. */
export function registerGamesRoutes(app: FastifyInstance): void {
  app.get(
    '/v1/games',
    {
      preHandler: [requireScope('games:read')],
      config: {
        docs: {
          group: 'Games',
          summary: 'List all registered games (tenants), paginated. Query: ?limit=100&offset=0.',
          responseExample: {
            total: 1,
            limit: 100,
            offset: 0,
            items: [
              { gameId: 'sword-sim', name: 'sword-sim', status: 'active', maxKeys: 10000, createdAt: '2026-07-10T20:00:00.000Z' },
            ],
          },
        },
      },
    },
    async (req) => {
      const { limit, offset } = ListQuery.parse(req.query);
      const r = await app.pg.query(
        `SELECT game_id, name, status, max_keys, created_at, COUNT(*) OVER() AS total
         FROM game ORDER BY game_id LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      const total = r.rowCount && r.rowCount > 0 ? Number(r.rows[0].total) : 0;
      const items = r.rows.map((row) => ({
        gameId: row.game_id,
        name: row.name,
        status: row.status,
        maxKeys: Number(row.max_keys),
        createdAt: (row.created_at as Date).toISOString(),
      }));
      return ok({ total, limit, offset, items }, req.id);
    },
  );
}
