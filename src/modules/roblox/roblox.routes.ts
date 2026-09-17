import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../../core/http/envelope';
import { Errors } from '../../core/errors/app-error';
import { GAME_ID_REGEX } from '../../core/constants';
import {
  MAX_UNIVERSE_IDS,
  RobloxUpstreamError,
  getPlaceUniverse,
  getUniverses,
  type Cache,
  type FetchLike,
} from './roblox';

const robloxId = (message: string) =>
  z.coerce.number({ invalid_type_error: message }).int(message).positive(message).max(Number.MAX_SAFE_INTEGER, message);

/** `?ids=1,2,3` — deduplicated, order kept, 1..50 of them. */
export const UniversesQuery = z.object({
  ids: z
    .string({ required_error: 'ids is required, e.g. ?ids=383310974' })
    .transform((s) => [...new Set(s.split(',').map((p) => p.trim()).filter((p) => p.length > 0))])
    .pipe(
      z
        .array(robloxId('ids must be comma-separated universe IDs, e.g. ?ids=383310974,1818'))
        .min(1, 'ids must list at least one universe ID')
        .max(MAX_UNIVERSE_IDS, `ids may list at most ${MAX_UNIVERSE_IDS} universe IDs`),
    ),
});

const PlaceParams = z.object({ gameId: z.string().regex(GAME_ID_REGEX), placeId: robloxId('placeId must be a Roblox place ID') });

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw Errors.validation(r.error.issues[0]?.message, { issues: r.error.issues });
  return r.data;
}

/** Roblox being down or throttling us is a retryable 503 — the Luau client already backs off on it. */
function upstream(err: unknown): never {
  if (err instanceof RobloxUpstreamError) {
    throw Errors.unavailable(`${err.message} Try again shortly.`, err.status === 429 ? 30 : 5);
  }
  throw err;
}

/**
 * Public Roblox game data. Mounted at /v1/games/:gameId/roblox.
 *
 * No scope of its own, on purpose: this is data anyone can read on roblox.com, so a scope would
 * protect nothing and would 403 every key minted before this module existed. Any valid key for
 * :gameId may call it, and the per-key rate limit still applies. It may look up ANY experience,
 * not just this game's — comparing against other games is half the point.
 */
export function registerRobloxRoutes(app: FastifyInstance): void {
  const redis = app.redis;
  const cache: Cache = {
    mget: (keys) => redis.mget(keys),
    setMany: async (entries, ttl) => {
      const p = redis.pipeline();
      for (const [k, v] of entries) p.set(k, v, 'EX', ttl);
      await p.exec();
    },
  };
  const deps = {
    cache,
    prefix: app.config.env.REDIS_KEY_PREFIX,
    fetchImpl: fetch as FetchLike,
    onCacheError: (err: unknown) => app.log.warn({ err }, 'roblox cache unavailable — reading live'),
  };

  app.get(
    '/universes',
    {
      config: {
        docs: {
          group: 'Roblox',
          summary:
            `Public stats for up to ${MAX_UNIVERSE_IDS} experiences by universe ID (game.GameId in a server): ` +
            'live players, visits, favorites, likes/dislikes and like ratio, name, creator, icon. Any experience, ' +
            'not only this one. Cached ~60s; if Roblox is unreachable, the last copy is served and fetchedAt shows ' +
            'its age. Unknown IDs come back in `missing`. Query: ?ids=383310974,1818',
          params: { gameId: 'Game identifier (path).' },
          exampleQuery: '?ids=383310974',
          responseExample: {
            items: [
              {
                universeId: 383310974,
                rootPlaceId: 920587237,
                name: 'Adopt Me!',
                description: 'Adopt and raise pets…',
                creator: { id: 295182, name: 'Uplift Games', type: 'Group', hasVerifiedBadge: true },
                playing: 108678,
                visits: 44749017960,
                favorites: 29601386,
                upVotes: 9456317,
                downVotes: 1511618,
                likeRatio: 0.8622,
                maxPlayers: 35,
                genre: 'Roleplay & Avatar Sim',
                createdAt: '2017-07-14T19:26:21.347Z',
                updatedAt: '2026-09-16T15:00:09.263Z',
                iconUrl: 'https://tr.rbxcdn.com/…/512/512/Image/Png/noFilter',
                url: 'https://www.roblox.com/games/920587237',
                fetchedAt: '2026-09-17T12:00:00.000Z',
              },
            ],
            missing: [],
          },
        },
      },
    },
    async (req) => {
      const { ids } = parse(UniversesQuery, req.query);
      return ok(await getUniverses(ids, deps).catch(upstream), req.id);
    },
  );

  app.get(
    '/places/:placeId/universe',
    {
      config: {
        docs: {
          group: 'Roblox',
          summary:
            'Resolve a place ID (the number in a roblox.com/games/<id> URL) to its universe ID, which the stats ' +
            'endpoint takes. universeId is null for a place that does not exist. Cached for 30 days.',
          params: { gameId: 'Game identifier (path).', placeId: 'Roblox place ID (path).' },
          responseExample: { placeId: 920587237, universeId: 383310974 },
        },
      },
    },
    async (req) => {
      const { placeId } = parse(PlaceParams, req.params);
      const universeId = await getPlaceUniverse(placeId, deps).catch(upstream);
      return ok({ placeId, universeId }, req.id);
    },
  );
}
