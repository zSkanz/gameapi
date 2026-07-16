import type { FastifyInstance } from 'fastify';
import { ok } from '../../core/http/envelope';
import { requireScope } from '../../core/http/guards';
import { Errors } from '../../core/errors/app-error';
import { generateApiKey } from '../../core/auth/key-format';
import { CreateKeyBody, GameParams, KeyListQuery, KeyParams, parseBody } from './panel.schemas';

/**
 * Per-game API keys.
 *
 * Every `:keyId` statement carries `AND game_id = $gameId`. `api_keys.key_id` is a GLOBAL
 * primary key, so without that predicate an admin looking at game A could revoke or read a key
 * belonging to game B just by pasting its id into the URL. The path's gameId is authorization;
 * the keyId alone is not.
 *
 * There is no PATCH: rotation (create new, revoke old) is already the zero-downtime path, and
 * an editable scope list is a privilege-escalation primitive for no benefit.
 */
export function registerPanelKeysRoutes(app: FastifyInstance): void {
  app.get(
    '/games/:gameId/keys',
    { config: { session: true }, preHandler: [requireScope('keys:read')] },
    async (req) => {
      const { gameId } = GameParams.parse(req.params);
      const { includeRevoked, limit, offset } = KeyListQuery.parse(req.query);
      // secret_hash is never selected. It is not a secret worth leaking even as a hash, and a
      // column that is never read cannot be logged by accident.
      const r = await app.pg.query(
        `SELECT key_id, label, scopes, tier, created_at, last_used_at, revoked_at, created_by,
                COUNT(*) OVER() AS total
         FROM api_keys
         WHERE game_id = $1 AND ($4::boolean OR revoked_at IS NULL)
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [gameId, limit, offset, includeRevoked],
      );
      const total = r.rowCount && r.rowCount > 0 ? Number(r.rows[0].total) : 0;
      return ok(
        {
          gameId,
          total,
          limit,
          offset,
          items: r.rows.map((row) => ({
            keyId: row.key_id,
            label: row.label,
            scopes: row.scopes as string[],
            createdAt: (row.created_at as Date).toISOString(),
            lastUsedAt: row.last_used_at ? (row.last_used_at as Date).toISOString() : null,
            revokedAt: row.revoked_at ? (row.revoked_at as Date).toISOString() : null,
            createdBy: (row.created_by as string | null) ?? null,
          })),
        },
        req.id,
      );
    },
  );

  app.post(
    '/games/:gameId/keys',
    { config: { session: true }, preHandler: [requireScope('keys:write')] },
    async (req, reply) => {
      const { gameId } = GameParams.parse(req.params);
      const { label, scopes } = parseBody(CreateKeyBody, req.body, 'VALIDATION_ERROR');

      // game.max_keys has existed since the first migration and nothing ever enforced it.
      // Counted inside the INSERT's transaction window would be better, but the quota is a
      // noisy-neighbour guard, not a security boundary — a race costs one extra key.
      const game = await app.pg.query(
        `SELECT g.max_keys, (SELECT COUNT(*) FROM api_keys k WHERE k.game_id = g.game_id AND k.revoked_at IS NULL) AS live
         FROM game g WHERE g.game_id = $1`,
        [gameId],
      );
      if (game.rowCount === 0) throw Errors.notFound('Game not found.');
      const maxKeys = Number(game.rows[0].max_keys);
      if (Number(game.rows[0].live) >= maxKeys) {
        throw Errors.conflict(`This game already has its maximum of ${maxKeys} active keys.`, { gameId, maxKeys });
      }

      const generated = generateApiKey();
      await app.pg.query(
        `INSERT INTO api_keys (key_id, game_id, secret_hash, scopes, label, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [generated.keyId, gameId, generated.secretHash, scopes, label, req.panel!.userId],
      );

      reply.code(201);
      // fullKey exists here and nowhere else — only its sha256 is stored. If the operator
      // loses it, the answer is to revoke and mint another.
      return ok(
        {
          key: {
            keyId: generated.keyId,
            label,
            scopes,
            createdAt: new Date().toISOString(),
            lastUsedAt: null,
            revokedAt: null,
            createdBy: req.panel!.userId,
          },
          fullKey: generated.fullKey,
        },
        req.id,
      );
    },
  );

  app.post(
    '/games/:gameId/keys/:keyId/revoke',
    { config: { session: true }, preHandler: [requireScope('keys:write')] },
    async (req) => {
      const { gameId, keyId } = KeyParams.parse(req.params);
      const r = await app.pg.query(
        `UPDATE api_keys SET revoked_at = now()
         WHERE key_id = $1 AND game_id = $2 AND revoked_at IS NULL
         RETURNING key_id, label, revoked_at`,
        [keyId, gameId],
      );
      if (r.rowCount === 0) {
        // 404 whether it is missing, already revoked, or belongs to another game: telling the
        // caller which would confirm the existence of another tenant's key.
        throw Errors.notFound('No active key with that id for this game.');
      }
      const row = r.rows[0];
      return ok(
        {
          keyId: row.key_id,
          label: row.label,
          revokedAt: (row.revoked_at as Date).toISOString(),
          // Honest, not a caveat buried in docs: resolve() caches hits in-process for 30s.
          effectiveWithinSeconds: 30,
        },
        req.id,
      );
    },
  );
}
