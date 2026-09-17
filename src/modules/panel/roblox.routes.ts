import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ok } from '../../core/http/envelope';
import { requireScope } from '../../core/http/guards';
import { AppError, Errors } from '../../core/errors/app-error';
import { GameParams, parseBody } from './panel.schemas';
import { MESSAGE_MAX, TOPIC_MAX, findRobloxConfig, publish, recordOutcome } from './roblox';
import { getPlaceUniverse, getUniverses, type Deps } from '../roblox/roblox';
import { getBadges, getGamePasses } from '../roblox/roblox.catalog';
import { USERNAME_REGEX, getGroup, getUserGroups, getUserProfile, getUsersByUsername } from '../roblox/roblox.users';
import { MISS_LIMITS, robloxDeps, upstream } from '../roblox/roblox.routes';

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

/** A free-text search box: a username, an id, or a pasted link. */
const LookupQuery = z.object({ q: z.string().trim().min(1, 'Type something to look up.').max(200) });
const GroupIdParams = z.object({
  groupId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER, 'That group ID is too large.'),
});

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
  // One set of deps for every panel request, so concurrent identical lookups share a flight and a
  // Roblox 429 pause applies panel-wide. Misses are metered per panel user, like per API key.
  const shared = robloxDeps(app);
  const depsFor = (req: FastifyRequest): Deps => ({
    ...shared,
    beforeLoad: async (budget, cost) => {
      await app.rateLimit(`rbx:${budget}:panel:${req.panel!.userId}`, MISS_LIMITS[budget][0], cost);
    },
  });

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
   * Same functions and Redis cache as the public /v1/games/:gameId/roblox routes.
   */
  app.get(
    '/games/:gameId/roblox/overview',
    { config: { session: true }, preHandler: [requireScope('panel:read')] },
    async (req) => {
      const { gameId } = GameParams.parse(req.params);
      const r = await app.pg.query(`SELECT universe_id FROM game_roblox WHERE game_id = $1`, [gameId]);
      const universeId = r.rows[0] ? Number(r.rows[0].universe_id) : null;
      if (universeId === null) return ok({ gameId, universeId: null, universe: null, badges: null, gamePasses: null, errors: {} }, req.id);
      return ok({ gameId, ...(await experience(universeId, depsFor(req))) }, req.id);
    },
  );

  // ---- lookup: any user, group or experience on Roblox, from the panel ----

  const read = { config: { session: true as const }, preHandler: [requireScope('panel:read')] };

  /** A username or a numeric user ID (all digits = ID). Profile plus every group they are in. */
  app.get('/roblox/users/lookup', read, async (req) => {
    const { q } = parseBody(LookupQuery, req.query);
    const deps = depsFor(req);
    let userId: number | null = null;
    if (/^\d{1,16}$/.test(q) && Number.isSafeInteger(Number(q)) && Number(q) > 0) userId = Number(q);
    else if (USERNAME_REGEX.test(q)) userId = (await getUsersByUsername([q], deps).catch(upstream)).items[0]?.userId ?? null;
    else throw Errors.validation('Enter a Roblox username or a numeric user ID.');
    if (userId === null) throw Errors.notFound(`No Roblox user is named "${q}".`);

    const [profile, groups] = await Promise.allSettled([getUserProfile(userId, deps), getUserGroups(userId, deps)]);
    const errors: Record<string, string> = {};
    const p = settled('profile', profile, errors);
    if (p === null && !errors.profile) throw Errors.notFound(`Roblox has no user with ID ${userId}.`);
    return ok({ profile: p, groups: settled('groups', groups, errors)?.items ?? null, errors }, req.id);
  });

  app.get('/roblox/groups/:groupId', read, async (req) => {
    const { groupId } = parseBody(GroupIdParams, req.params);
    const group = await getGroup(groupId, depsFor(req)).catch(upstream);
    if (group === null) throw Errors.notFound(`Roblox has no group with ID ${groupId}.`);
    return ok(group, req.id);
  });

  /**
   * A universe ID, a place ID, or a roblox.com/games/<placeId>/... link. A bare number is tried as a
   * universe first and then as a place — the two id spaces overlap, so the response says which it was.
   */
  app.get('/roblox/experiences/lookup', read, async (req) => {
    const { q } = parseBody(LookupQuery, req.query);
    const deps = depsFor(req);
    const link = /roblox\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?games\/(\d{1,16})/i.exec(q);
    const n = Number(link ? link[1] : q);
    if (!/^\d{1,16}$/.test(link ? link[1]! : q) || !Number.isSafeInteger(n) || n <= 0) {
      throw Errors.validation('Enter a universe ID, a place ID, or a roblox.com/games/… link.');
    }

    let universeId: number | null = null;
    let resolvedFrom: 'universe' | 'place' = 'place';
    if (!link && (await getUniverses([n], deps).catch(upstream)).items.length > 0) {
      universeId = n;
      resolvedFrom = 'universe';
    } else {
      universeId = await getPlaceUniverse(n, deps).catch(upstream);
    }
    if (universeId === null) throw Errors.notFound(`No Roblox experience matches ${link ? 'that link' : n}.`);
    return ok({ query: q, resolvedFrom, ...(await experience(universeId, deps)) }, req.id);
  });

  /** Stats + first page of badges and passes. Each section fails on its own. */
  async function experience(universeId: number, deps: Deps) {
    const [universe, badges, gamePasses] = await Promise.allSettled([
      getUniverses([universeId], deps).then((u) => u.items[0] ?? null),
      getBadges(universeId, 100, undefined, deps),
      getGamePasses(universeId, 100, undefined, deps),
    ]);
    const errors: Record<string, string> = {};
    return {
      universeId,
      universe: settled('universe', universe, errors),
      badges: settled('badges', badges, errors),
      gamePasses: settled('gamePasses', gamePasses, errors),
      errors,
    };
  }

  /** A section's value, or null with its error recorded. Roblox's own failures read fine to an admin; ours are logged. */
  function settled<T>(name: string, s: PromiseSettledResult<T>, errors: Record<string, string>): T | null {
    if (s.status === 'fulfilled') return s.value;
    try {
      upstream(s.reason);
    } catch (err) {
      if (err instanceof AppError) errors[name] = err.message;
      else {
        errors[name] = 'Could not load this section.';
        app.log.error({ err }, 'roblox panel section failed');
      }
    }
    return null;
  }
}
