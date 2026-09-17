import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../../core/http/envelope';
import { requireScope } from '../../core/http/guards';
import { AppError, Errors } from '../../core/errors/app-error';
import { GameParams, parseBody } from './panel.schemas';
import { MESSAGE_MAX, TOPIC_MAX, findRobloxConfig, publish, recordOutcome } from './roblox';
import { getUniverses } from '../roblox/roblox';
import { getBadges, getGamePasses } from '../roblox/roblox.catalog';
import { robloxDeps, upstream } from '../roblox/roblox.routes';

const SetRobloxBody = z
  .object({
    // Roblox universe ids are numeric; a place id pasted here is the classic mistake, and it
    // fails at publish time with an opaque 404. Shape-checking at least rules out a URL.
    // Same bounds as the public Roblox routes: not 0, and within what a JS number holds exactly —
    // a 20-digit id would round, and the stats would silently be for a different universe.
    universeId: z
      .string()
      .regex(/^[1-9]\d{0,15}$/, 'The universe ID is the number from the Creator Dashboard.')
      .refine((v) => Number.isSafeInteger(Number(v)), 'That universe ID is too large.'),
    // Optional: only publishing needs it. Omitted on an existing link = keep the stored key, so
    // changing the universe does not force re-pasting a secret nobody can read back.
    apiKey: z.string().min(20).max(2000).optional(),
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
    hasApiKey: row.has_api_key === true,
    lastStatus: row.last_status === null ? null : Number(row.last_status),
    lastError: (row.last_error as string | null) ?? null,
    lastApi: (row.last_api as string | null) ?? null,
    lastOkAt: row.last_ok_at ? (row.last_ok_at as Date).toISOString() : null,
    lastAttemptAt: row.last_attempt_at ? (row.last_attempt_at as Date).toISOString() : null,
    createdBy: (row.created_by as string | null) ?? null,
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

const COLS = `game_id, universe_id, api_key IS NOT NULL AS has_api_key, last_status, last_error, last_api, last_ok_at, last_attempt_at, created_by, updated_at`;

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
         SET universe_id = EXCLUDED.universe_id, api_key = COALESCE(EXCLUDED.api_key, game_roblox.api_key), updated_at = now(),
             last_status = NULL, last_error = NULL, last_api = NULL, last_attempt_at = NULL
       RETURNING ${COLS}`,
      [gameId, universeId, apiKey ?? null, `panel:${req.panel!.userId}`],
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
      if (!cfg.apiKey) {
        throw Errors.conflict('This game is linked for stats only. Add an Open Cloud API key to send messages.', { gameId });
      }

      const outcome = await publish({ ...cfg, apiKey: cfg.apiKey }, topic, message);
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
  /**
   * The linked experience at a glance: live stats plus the first page of badges and game passes.
   *
   * Same functions and the same Redis cache as the public /v1/games/:gameId/roblox routes, so the
   * panel never spends Roblox budget the games would have hit anyway. Each section fails on its
   * own — a Roblox hiccup on game passes should not blank the stats above it.
   */
  app.get(
    '/games/:gameId/roblox/overview',
    { config: { session: true }, preHandler: [requireScope('panel:read')] },
    async (req) => {
      const { gameId } = GameParams.parse(req.params);
      const r = await app.pg.query(`SELECT universe_id FROM game_roblox WHERE game_id = $1`, [gameId]);
      const universeId = r.rows[0] ? Number(r.rows[0].universe_id) : null;
      if (universeId === null) return ok({ gameId, universeId: null, universe: null, badges: null, gamePasses: null, errors: {} }, req.id);

      const deps = robloxDeps(app);
      const [universe, badges, gamePasses] = await Promise.allSettled([
        getUniverses([universeId], deps).then((u) => u.items[0] ?? null),
        getBadges(universeId, 100, undefined, deps),
        getGamePasses(universeId, 100, undefined, deps),
      ]);
      const errors: Record<string, string> = {};
      const value = <T>(name: string, s: PromiseSettledResult<T>): T | null => {
        if (s.status === 'fulfilled') return s.value;
        try {
          upstream(s.reason);
        } catch (err) {
          // Roblox's own failure (503/400) reads fine to an admin; anything else is our bug and
          // stays in the log rather than on the screen.
          if (err instanceof AppError) errors[name] = err.message;
          else {
            errors[name] = 'Could not load this section.';
            app.log.error({ err, gameId }, 'roblox overview failed');
          }
        }
        return null;
      };
      return ok(
        {
          gameId,
          universeId,
          universe: value('universe', universe),
          badges: value('badges', badges),
          gamePasses: value('gamePasses', gamePasses),
          errors,
        },
        req.id,
      );
    },
  );
}
