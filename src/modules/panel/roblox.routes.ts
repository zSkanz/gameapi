import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../../core/http/envelope';
import { requireScope } from '../../core/http/guards';
import { Errors } from '../../core/errors/app-error';
import { GameParams, parseBody } from './panel.schemas';
import { MESSAGE_MAX, TOPIC_MAX, findRobloxConfig, publish, recordOutcome } from './roblox';

const SetRobloxBody = z
  .object({
    // Roblox universe ids are numeric; a place id pasted here is the classic mistake, and it
    // fails at publish time with an opaque 404. Shape-checking at least rules out a URL.
    universeId: z.string().regex(/^\d{1,20}$/, 'The universe ID is the number from the Creator Dashboard.'),
    apiKey: z.string().min(20).max(2000),
  })
  .strict();

const PublishBody = z
  .object({
    topic: z.string().min(1).max(TOPIC_MAX),
    message: z.string().min(1).max(MESSAGE_MAX),
  })
  .strict();

/** Never returns api_key — it can publish to a real experience, so it goes in and stays in. */
function view(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  return {
    universeId: row.universe_id as string,
    lastStatus: row.last_status === null ? null : Number(row.last_status),
    lastError: (row.last_error as string | null) ?? null,
    lastApi: (row.last_api as string | null) ?? null,
    lastOkAt: row.last_ok_at ? (row.last_ok_at as Date).toISOString() : null,
    lastAttemptAt: row.last_attempt_at ? (row.last_attempt_at as Date).toISOString() : null,
    createdBy: (row.created_by as string | null) ?? null,
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

const COLS = `game_id, universe_id, last_status, last_error, last_api, last_ok_at, last_attempt_at, created_by, updated_at`;

export function registerPanelRobloxRoutes(app: FastifyInstance): void {
  const owner = (what: string) => ({
    config: { session: true },
    preHandler: [requireScope('panel:owner', `Only an owner can ${what} the Roblox connection.`)],
  });

  app.get('/games/:gameId/roblox', { config: { session: true }, preHandler: [requireScope('panel:read')] }, async (req) => {
    const { gameId } = GameParams.parse(req.params);
    const r = await app.pg.query(`SELECT ${COLS} FROM game_roblox WHERE game_id = $1`, [gameId]);
    return ok({ gameId, roblox: view(r.rows[0]) }, req.id);
  });

  app.put('/games/:gameId/roblox', owner('change'), async (req) => {
    const { gameId } = GameParams.parse(req.params);
    const { universeId, apiKey } = parseBody(SetRobloxBody, req.body);
    const r = await app.pg.query(
      `INSERT INTO game_roblox (game_id, universe_id, api_key, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (game_id) DO UPDATE
         SET universe_id = EXCLUDED.universe_id, api_key = EXCLUDED.api_key, updated_at = now(),
             last_status = NULL, last_error = NULL, last_api = NULL, last_attempt_at = NULL
       RETURNING ${COLS}`,
      [gameId, universeId, apiKey, `panel:${req.panel!.userId}`],
    );
    return ok({ gameId, roblox: view(r.rows[0]) }, req.id);
  });

  app.delete('/games/:gameId/roblox', owner('remove'), async (req) => {
    const { gameId } = GameParams.parse(req.params);
    const r = await app.pg.query(`DELETE FROM game_roblox WHERE game_id = $1 RETURNING game_id`, [gameId]);
    if (r.rowCount === 0) throw Errors.notFound('No Roblox connection is configured for this game.');
    return ok({ gameId, removed: true }, req.id);
  });

  /**
   * Publish one message to the experience's live servers.
   *
   * Awaited, unlike the Discord webhook: you pressed Send and the whole point is to learn
   * whether it landed. Roblox answers 200 with an empty body on success.
   */
  app.post(
    '/games/:gameId/roblox/publish',
    { config: { session: true }, preHandler: [requireScope('panel:write')] },
    async (req) => {
      const { gameId } = GameParams.parse(req.params);
      const { topic, message } = parseBody(PublishBody, req.body);

      const cfg = await findRobloxConfig(app.pg, gameId);
      if (!cfg) throw Errors.notFound('Connect this game to Roblox first — universe ID and an Open Cloud API key.');

      const outcome = await publish(cfg, topic, message);
      await recordOutcome(app.pg, gameId, outcome);
      if (!outcome.ok) {
        app.log.warn({ gameId, status: outcome.status, api: outcome.api }, 'roblox publish failed');
        // Roblox's own words, which say far more than we could ("Invalid API key", "universe
        // not found", a 429). The api key is not in them.
        throw Errors.conflict(outcome.error ?? 'Roblox rejected the message.', {
          gameId,
          status: outcome.status,
        });
      }
      return ok({ gameId, topic, delivered: true, api: outcome.api }, req.id);
    },
  );
}
