import type { FastifyInstance } from 'fastify';
import { ok } from '../../core/http/envelope';
import { requireScope } from '../../core/http/guards';
import { Errors } from '../../core/errors/app-error';
import { CreateGameBody, GameListQuery, GameParams, parseBody } from './panel.schemas';

/**
 * Games (tenants) as the panel sees them.
 *
 * Deliberately NOT the same read as GET /v1/games: that one is game-facing and must not pay
 * for three subqueries per row. This one is a human clicking a list, so it can afford counts.
 */
export function registerPanelGamesRoutes(app: FastifyInstance): void {
  app.get('/games', { config: { session: true }, preHandler: [requireScope('panel:read')] }, async (req) => {
    const { q, limit, offset } = GameListQuery.parse(req.query);
    const r = await app.pg.query(
      `SELECT g.game_id, g.name, g.status, g.max_keys, g.created_at,
              (SELECT COUNT(*) FROM stock  s WHERE s.game_id = g.game_id AND s.deleted_at IS NULL) AS stock_keys,
              (SELECT COUNT(*) FROM serial x WHERE x.game_id = g.game_id AND x.deleted_at IS NULL) AS serial_keys,
              (SELECT COUNT(*) FROM api_keys k WHERE k.game_id = g.game_id AND k.revoked_at IS NULL) AS active_keys,
              COUNT(*) OVER() AS total
       FROM game g
       WHERE ($1::text IS NULL OR g.game_id ILIKE '%' || $1 || '%' OR g.name ILIKE '%' || $1 || '%')
       ORDER BY g.game_id LIMIT $2 OFFSET $3`,
      [q ?? null, limit, offset],
    );
    const total = r.rowCount && r.rowCount > 0 ? Number(r.rows[0].total) : 0;
    return ok(
      {
        total,
        limit,
        offset,
        items: r.rows.map((row) => ({
          gameId: row.game_id,
          name: row.name,
          status: row.status,
          maxKeys: Number(row.max_keys),
          createdAt: (row.created_at as Date).toISOString(),
          stockKeys: Number(row.stock_keys),
          serialKeys: Number(row.serial_keys),
          activeKeys: Number(row.active_keys),
        })),
      },
      req.id,
    );
  });

  /**
   * One game. Exists so the game-detail header does not have to fetch the whole list and filter
   * it client-side — that read grows with the number of projects and silently gets slower.
   */
  app.get('/games/:gameId', { config: { session: true }, preHandler: [requireScope('panel:read')] }, async (req) => {
    const { gameId } = GameParams.parse(req.params);
    const r = await app.pg.query(
      `SELECT g.game_id, g.name, g.status, g.max_keys, g.created_at,
              (SELECT COUNT(*) FROM stock  s WHERE s.game_id = g.game_id AND s.deleted_at IS NULL) AS stock_keys,
              (SELECT COUNT(*) FROM serial x WHERE x.game_id = g.game_id AND x.deleted_at IS NULL) AS serial_keys,
              (SELECT COUNT(*) FROM api_keys k WHERE k.game_id = g.game_id AND k.revoked_at IS NULL) AS active_keys
       FROM game g WHERE g.game_id = $1`,
      [gameId],
    );
    const row = r.rows[0];
    if (!row) throw Errors.notFound('Game not found.');
    return ok(
      {
        gameId: row.game_id,
        name: row.name,
        status: row.status,
        maxKeys: Number(row.max_keys),
        createdAt: (row.created_at as Date).toISOString(),
        stockKeys: Number(row.stock_keys),
        serialKeys: Number(row.serial_keys),
        activeKeys: Number(row.active_keys),
      },
      req.id,
    );
  });

  /**
   * The only way to onboard a project once BOOTSTRAP_API_KEY_ENABLED=false.
   *
   * Without it the migration deadlocks: minting a per-game key needs a `game` row (FK), and a
   * `game` row was only ever created as a side effect of an authenticated stock write — which
   * needs a key. An explicit create is also just better than a silent side effect, and the
   * panel is where a human onboards a project anyway.
   */
  app.post('/games', { config: { session: true }, preHandler: [requireScope('panel:owner')] }, async (req, reply) => {
    const { gameId, name, maxKeys } = parseBody(CreateGameBody, req.body, 'VALIDATION_ERROR');
    const r = await app.pg.query(
      `INSERT INTO game (game_id, name, max_keys) VALUES ($1, $2, $3)
       ON CONFLICT (game_id) DO NOTHING
       RETURNING game_id, name, status, max_keys, created_at`,
      [gameId, name, maxKeys],
    );
    if (r.rowCount === 0) throw Errors.conflict('That game already exists.', { gameId });
    const row = r.rows[0];
    reply.code(201);
    return ok(
      {
        gameId: row.game_id,
        name: row.name,
        status: row.status,
        maxKeys: Number(row.max_keys),
        createdAt: (row.created_at as Date).toISOString(),
        stockKeys: 0,
        serialKeys: 0,
        activeKeys: 0,
      },
      req.id,
    );
  });
}
