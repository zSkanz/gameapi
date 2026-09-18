import type { FastifyInstance } from 'fastify';
import { ok } from '../../core/http/envelope';
import { requireScope } from '../../core/http/guards';
import { Errors } from '../../core/errors/app-error';
import { KEY_CACHE_TTL_SECONDS } from '../../core/auth/db-store';
import { CreateGameBody, GameListQuery, GameParams, parseBody } from './panel.schemas';

const mapGame = (row: Record<string, unknown>) => ({
  gameId: row.game_id as string,
  name: row.name as string,
  status: row.status as string,
  maxKeys: Number(row.max_keys),
  createdAt: (row.created_at as Date).toISOString(),
  deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
  stockKeys: Number(row.stock_keys ?? 0),
  serialKeys: Number(row.serial_keys ?? 0),
  activeKeys: Number(row.active_keys ?? 0),
  funnels: Number(row.funnels ?? 0),
  configs: Number(row.configs ?? 0),
});

/**
 * The per-game counts on the list, the detail header and the tabs. One copy: each new tab count
 * used to be three edits, and the create route's hand-built copy had already drifted.
 */
const COUNTS = `
              (SELECT COUNT(*) FROM stock  s WHERE s.game_id = g.game_id AND s.deleted_at IS NULL) AS stock_keys,
              (SELECT COUNT(*) FROM serial x WHERE x.game_id = g.game_id AND x.deleted_at IS NULL) AS serial_keys,
              (SELECT COUNT(*) FROM api_keys k WHERE k.game_id = g.game_id AND k.revoked_at IS NULL) AS active_keys,
              (SELECT COUNT(*) FROM funnel f WHERE f.game_id = g.game_id AND f.deleted_at IS NULL) AS funnels,
              -- The rows the Config tab lists: every key live or in the draft, so a staged removal
              -- still counts until it is published.
              (SELECT COUNT(*) FROM game_config c,
                 LATERAL (SELECT jsonb_object_keys(c.published) UNION SELECT jsonb_object_keys(COALESCE(c.draft, '{}'::jsonb))) AS k
               WHERE c.game_id = g.game_id) AS configs`;

/**
 * Games (tenants) as the panel sees them.
 *
 * Deliberately NOT the same read as GET /v1/games: that one is game-facing and must not pay
 * for the counts. This one is a human clicking a list, so it can afford counts.
 */
export function registerPanelGamesRoutes(app: FastifyInstance): void {
  const owner = (what: string) => ({
    config: { session: true },
    preHandler: [requireScope('panel:owner', `Only an owner can ${what}.`)],
  });
  app.get('/games', { config: { session: true }, preHandler: [requireScope('panel:read')] }, async (req) => {
    const { q, includeDeleted, limit, offset } = GameListQuery.parse(req.query);
    const r = await app.pg.query(
      `SELECT g.game_id, g.name, g.status, g.max_keys, g.created_at, g.deleted_at,
${COUNTS},
              COUNT(*) OVER() AS total
       FROM game g
       WHERE ($1::text IS NULL OR g.game_id ILIKE '%' || $1 || '%' OR g.name ILIKE '%' || $1 || '%')
         AND ($4::boolean OR g.deleted_at IS NULL)
       ORDER BY g.game_id LIMIT $2 OFFSET $3`,
      [q ?? null, limit, offset, includeDeleted],
    );
    const total = r.rowCount && r.rowCount > 0 ? Number(r.rows[0].total) : 0;
    return ok({ total, limit, offset, items: r.rows.map(mapGame) }, req.id);
  });

  /**
   * One game. Exists so the game-detail header does not have to fetch the whole list and filter
   * it client-side — that read grows with the number of projects and silently gets slower.
   */
  app.get('/games/:gameId', { config: { session: true }, preHandler: [requireScope('panel:read')] }, async (req) => {
    const { gameId } = GameParams.parse(req.params);
    // Not filtered on deleted_at: the panel must still be able to open a deleted game to
    // restore it. The row carries deletedAt so the UI can say so.
    const r = await app.pg.query(
      `SELECT g.game_id, g.name, g.status, g.max_keys, g.created_at, g.deleted_at,
${COUNTS}
       FROM game g WHERE g.game_id = $1`,
      [gameId],
    );
    const row = r.rows[0];
    if (!row) throw Errors.notFound('Game not found.');
    return ok(mapGame(row), req.id);
  });

  /**
   * Delete a game. Soft, and owner-only.
   *
   * The game's API keys stop authenticating immediately (within the 30s key cache) because
   * DbApiKeyStore joins game and requires deleted_at IS NULL — so the project goes quiet
   * without anything being destroyed. Its stock, serials, keys and ledgers are all still there,
   * and restore brings the whole thing back, integrations included.
   *
   * There is deliberately no purge for games: it would have to cascade through stock, serial,
   * both ledgers and api_keys, and "delete every trace of a project" is not something to bolt on
   * behind a confirm box. Soft delete is what "remove it from my panel" actually needs.
   */
  app.delete('/games/:gameId', owner('delete a game'), async (req) => {
    const { gameId } = GameParams.parse(req.params);
    const r = await app.pg.query(
      `UPDATE game SET deleted_at = now(), deleted_by = $2
       WHERE game_id = $1 AND deleted_at IS NULL
       RETURNING game_id, deleted_at,
                 (SELECT COUNT(*) FROM api_keys k WHERE k.game_id = game.game_id AND k.revoked_at IS NULL) AS active_keys`,
      [gameId, `panel:${req.panel!.userId}`],
    );
    if (r.rowCount === 0) {
      const ex = await app.pg.query(`SELECT deleted_at FROM game WHERE game_id = $1`, [gameId]);
      if (ex.rowCount === 0) throw Errors.notFound('Game not found.');
      throw Errors.conflict('That game is already deleted.', { gameId });
    }
    return ok(
      {
        gameId,
        deletedAt: (r.rows[0].deleted_at as Date).toISOString(),
        // Honest about the propagation bound rather than implying it is instant.
        keysDisabled: Number(r.rows[0].active_keys),
        effectiveWithinSeconds: KEY_CACHE_TTL_SECONDS,
      },
      req.id,
    );
  });

  app.post('/games/:gameId/restore', owner('restore a game'), async (req) => {
    const { gameId } = GameParams.parse(req.params);
    const r = await app.pg.query(
      `UPDATE game SET deleted_at = NULL, deleted_by = NULL
       WHERE game_id = $1 AND deleted_at IS NOT NULL
       RETURNING game_id`,
      [gameId],
    );
    if (r.rowCount === 0) {
      const ex = await app.pg.query(`SELECT 1 FROM game WHERE game_id = $1`, [gameId]);
      if (ex.rowCount === 0) throw Errors.notFound('Game not found.');
      throw Errors.conflict('That game is not deleted.', { gameId });
    }
    // Immediate, not KEY_CACHE_TTL_SECONDS: only successful lookups are cached, so nothing remembers
    // that these keys were refused while the game was deleted.
    return ok({ gameId, restored: true, effectiveWithinSeconds: 0 }, req.id);
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
       RETURNING game_id, name, status, max_keys, created_at, deleted_at`,
      [gameId, name, maxKeys],
    );
    if (r.rowCount === 0) throw Errors.conflict('That game already exists.', { gameId });
    reply.code(201);
    // A new game has nothing in it yet: mapGame reads the absent counts as 0.
    return ok(mapGame(r.rows[0]), req.id);
  });
}
