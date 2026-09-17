import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ok } from '../../core/http/envelope';
import { Errors } from '../../core/errors/app-error';
import { GAME_ID_REGEX } from '../../core/constants';
import {
  MAX_UNIVERSE_IDS,
  RobloxUpstreamError,
  getPlaceUniverse,
  getUniverses,
  newRobloxState,
  type Budget,
  type Deps,
  type FetchLike,
} from './roblox';
import { MAX_USER_IDS, USERNAME_REGEX, getGroup, getUserGroups, getUserProfile, getUsers, getUsersByUsername } from './roblox.users';
import { BADGE_PAGE_SIZES, CURSOR_REGEX, MAX_PAGE_SIZE, getBadges, getGamePasses } from './roblox.catalog';

const robloxId = (message: string) =>
  z.coerce.number({ invalid_type_error: message }).int(message).positive(message).max(Number.MAX_SAFE_INTEGER, message);

/** `?x=a,b,c` — trimmed, deduplicated, order kept, 1..max of them, each checked by `item`. */
function csv<T extends z.ZodTypeAny>(param: string, item: T, max: number, example: string) {
  return z
    .string({ required_error: `${param} is required, e.g. ?${param}=${example}` })
    .transform((s) => [...new Set(s.split(',').map((p) => p.trim()).filter((p) => p.length > 0))])
    .pipe(
      z
        .array(item)
        .min(1, `${param} must list at least one value, e.g. ?${param}=${example}`)
        .max(max, `${param} may list at most ${max} values`),
    );
}

export const UniversesQuery = z.object({
  ids: csv('ids', robloxId('ids must be comma-separated universe IDs, e.g. ?ids=383310974,1818'), MAX_UNIVERSE_IDS, '383310974'),
});
export const UsersQuery = z.object({
  ids: csv('ids', robloxId('ids must be comma-separated user IDs, e.g. ?ids=1,156'), MAX_USER_IDS, '1,156'),
});
export const UsernamesQuery = z.object({
  names: csv(
    'names',
    z.string().regex(USERNAME_REGEX, 'names must be Roblox usernames (3-20 letters, digits or _)'),
    MAX_USER_IDS,
    'builderman',
  ),
});
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(MAX_PAGE_SIZE),
  cursor: z.string().regex(CURSOR_REGEX, 'cursor must be a nextCursor value from a previous page').optional(),
});

const game = { gameId: z.string().regex(GAME_ID_REGEX) };
const PlaceParams = z.object({ ...game, placeId: robloxId('placeId must be a Roblox place ID') });
const UserParams = z.object({ ...game, userId: robloxId('userId must be a Roblox user ID') });
const GroupParams = z.object({ ...game, groupId: robloxId('groupId must be a Roblox group ID') });
const UniverseParams = z.object({ ...game, universeId: robloxId('universeId must be a Roblox universe ID') });

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw Errors.validation(r.error.issues[0]?.message, { issues: r.error.issues });
  return r.data;
}

/**
 * Roblox being down or throttling us is a retryable 503 — the Luau client already backs off on it.
 * A 400 is Roblox rejecting what we passed through (in practice: a stale or foreign cursor).
 */
export function upstream(err: unknown): never {
  if (err instanceof RobloxUpstreamError) {
    if (err.status === 400) throw Errors.validation('Roblox rejected the request — if you passed a cursor, it is not valid here.');
    throw Errors.unavailable(`${err.message} Try again shortly.`, err.status === 429 ? 30 : 5);
  }
  throw err;
}

function found<T>(value: T | null, what: string): T {
  if (value === null) throw Errors.notFound(`Roblox has no ${what}.`);
  return value;
}

/**
 * Cache misses per minute — only what reaches Roblox and adds to Redis is charged; cached reads are
 * free, so a busy game with a warm cache never meets these. [per API key, per game].
 *
 * Why they exist: Redis runs noeviction with a 2 GB cap and also holds stock, sessions and the
 * request limiter, and Roblox's per-IP budget is shared by every tenant. Without a meter, one key
 * requesting 100 random user ids at the request limit (6000/min) writes ~600k keys a minute and
 * fills Redis in about twenty minutes. With these, one key's worst case is bounded to megabytes:
 * light 600 ids/min x 1h keep, heavy 20 lookups/min x 6h keep.
 */
export const MISS_LIMITS: Record<Budget, [perKey: number, perGame: number]> = {
  light: [600, 1_200],
  heavy: [20, 40],
};

/** The Redis + fetch wiring every Roblox read needs. Exported so the panel reuses the same cache. */
export function robloxDeps(app: FastifyInstance): Deps {
  const redis = app.redis;
  return {
    state: newRobloxState(),
    onRefreshError: (err: unknown) => app.log.warn({ err }, 'roblox background refresh failed — stale copy served'),
    cache: {
      mget: (keys) => redis.mget(keys),
      setMany: async (entries) => {
        const p = redis.pipeline();
        for (const [k, v, ttl] of entries) p.set(k, v, 'EX', ttl);
        await p.exec();
      },
    },
    prefix: app.config.env.REDIS_KEY_PREFIX,
    fetchImpl: fetch as FetchLike,
    onCacheError: (err: unknown) => app.log.warn({ err }, 'roblox cache unavailable — reading live'),
  };
}

const USER_EXAMPLE = {
  userId: 156,
  username: 'builderman',
  displayName: 'builderman',
  hasVerifiedBadge: true,
  avatarUrl: 'https://tr.rbxcdn.com/…/150/150/AvatarHeadshot/Png/noFilter',
  profileUrl: 'https://www.roblox.com/users/156/profile',
  fetchedAt: '2026-09-17T12:00:00.000Z',
};

/**
 * Public Roblox data. Mounted at /v1/games/:gameId/roblox.
 *
 * No scope of its own, on purpose: this is data anyone can read on roblox.com, so a scope would
 * protect nothing and would 403 every key minted before this module existed. Any valid key for
 * :gameId may call it, and the per-key rate limit still applies. Lookups are not limited to this
 * game's own experience, users or group — comparing against others is half the point.
 */
export function registerRobloxRoutes(app: FastifyInstance): void {
  const shared = robloxDeps(app);
  // Same cache, state and fetch for every request; only who gets charged for a miss differs.
  const depsFor = (req: FastifyRequest): Deps => {
    const keyId = req.principal!.keyId;
    const { gameId } = req.params as { gameId: string };
    return {
      ...shared,
      beforeLoad: async (budget, cost) => {
        const [perKey, perGame] = MISS_LIMITS[budget];
        await app.rateLimit(`rbx:${budget}:key:${keyId}`, perKey, cost);
        await app.rateLimit(`rbx:${budget}:game:${gameId}`, perGame, cost);
      },
    };
  };
  const docs = (summary: string, extra: Record<string, unknown> = {}) => ({
    config: { docs: { group: 'Roblox', params: { gameId: 'Game identifier (path).' }, summary, ...extra } },
  });

  // ---- experiences ----

  app.get(
    '/universes',
    docs(
      `Public stats for up to ${MAX_UNIVERSE_IDS} experiences by universe ID (game.GameId in a server): live players, ` +
        'visits, favorites, likes/dislikes and like ratio, name, creator, icon. Cached ~60s; if Roblox is unreachable ' +
        'the last copy is served and fetchedAt shows its age. Unknown IDs come back in `missing`.',
      {
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
    ),
    async (req) => {
      const { ids } = parse(UniversesQuery, req.query);
      return ok(await getUniverses(ids, depsFor(req)).catch(upstream), req.id);
    },
  );

  app.get(
    '/places/:placeId/universe',
    docs(
      'Resolve a place ID (the number in a roblox.com/games/<id> URL) to its universe ID. universeId is null for a ' +
        'place that does not exist. Cached for 30 days.',
      {
        params: { gameId: 'Game identifier (path).', placeId: 'Roblox place ID (path).' },
        responseExample: { placeId: 920587237, universeId: 383310974 },
      },
    ),
    async (req) => {
      const { placeId } = parse(PlaceParams, req.params);
      return ok({ placeId, universeId: await getPlaceUniverse(placeId, depsFor(req)).catch(upstream) }, req.id);
    },
  );

  app.get(
    '/universes/:universeId/badges',
    docs(
      `An experience's badges with award statistics, one page at a time. limit is one of ${BADGE_PAGE_SIZES.join('/')} ` +
        '(default 100); pass nextCursor back as cursor for the next page. Cached 5 minutes.',
      {
        params: { gameId: 'Game identifier (path).', universeId: 'Roblox universe ID (path).' },
        exampleQuery: '?limit=100',
        responseExample: {
          universeId: 383310974,
          items: [
            {
              badgeId: 2124439922,
              name: 'Tiny Isles',
              description: 'You managed to conquer the hardest obby in all of Adopt Me!',
              enabled: true,
              iconUrl: 'https://tr.rbxcdn.com/…/150/150/Image/Png/noFilter',
              awardedCount: 1553140,
              pastDayAwardedCount: 152,
              winRatePercentage: 0,
              createdAt: '2018-10-17T12:43:51.29+00:00',
              updatedAt: '2018-10-17T12:43:51.29+00:00',
            },
          ],
          nextCursor: null,
          fetchedAt: '2026-09-17T12:00:00.000Z',
        },
      },
    ),
    async (req) => {
      const { universeId } = parse(UniverseParams, req.params);
      const { limit, cursor } = parse(PageQuery, req.query);
      if (!(BADGE_PAGE_SIZES as readonly number[]).includes(limit)) {
        throw Errors.validation(`limit must be one of ${BADGE_PAGE_SIZES.join(', ')} for badges.`);
      }
      const page = await getBadges(universeId, limit, cursor, depsFor(req)).catch(upstream);
      return ok(found(page, `experience with universe ID ${universeId}`), req.id);
    },
  );

  app.get(
    '/universes/:universeId/game-passes',
    docs(
      "An experience's game passes with price (Robux, null when not for sale) and icon, one page at a time. limit " +
        `1-${MAX_PAGE_SIZE} (default ${MAX_PAGE_SIZE}); pass nextCursor back as cursor. Cached 5 minutes.`,
      {
        params: { gameId: 'Game identifier (path).', universeId: 'Roblox universe ID (path).' },
        exampleQuery: '?limit=100',
        responseExample: {
          universeId: 383310974,
          items: [
            {
              gamePassId: 3196348,
              productId: 101545651,
              name: 'VIP',
              description: '',
              price: 480,
              isForSale: true,
              iconUrl: 'https://tr.rbxcdn.com/…/150/150/Image/Png/noFilter',
              createdAt: '2018-08-01T00:00:00.000Z',
              updatedAt: '2026-09-13T03:14:16.160Z',
            },
          ],
          nextCursor: null,
          fetchedAt: '2026-09-17T12:00:00.000Z',
        },
      },
    ),
    async (req) => {
      const { universeId } = parse(UniverseParams, req.params);
      const { limit, cursor } = parse(PageQuery, req.query);
      const page = await getGamePasses(universeId, limit, cursor, depsFor(req)).catch(upstream);
      return ok(found(page, `experience with universe ID ${universeId}`), req.id);
    },
  );

  // ---- users ----

  app.get(
    '/users',
    docs(
      `Up to ${MAX_USER_IDS} users by ID: username, display name, verified badge, avatar headshot. Cached 10 minutes. ` +
        'Unknown IDs come back in `missing`.',
      { exampleQuery: '?ids=1,156', responseExample: { items: [USER_EXAMPLE], missing: [] } },
    ),
    async (req) => {
      const { ids } = parse(UsersQuery, req.query);
      return ok(await getUsers(ids, depsFor(req)).catch(upstream), req.id);
    },
  );

  app.get(
    '/users/by-username',
    docs(
      `Up to ${MAX_USER_IDS} users by username (case-insensitive). Same fields as /users plus requestedUsername. ` +
        'Names that match no account come back in `missing`, spelled as you sent them.',
      {
        exampleQuery: '?names=builderman',
        responseExample: { items: [{ ...USER_EXAMPLE, requestedUsername: 'builderman' }], missing: [] },
      },
    ),
    async (req) => {
      const { names } = parse(UsernamesQuery, req.query);
      return ok(await getUsersByUsername(names, depsFor(req)).catch(upstream), req.id);
    },
  );

  app.get(
    '/users/:userId',
    docs(
      'One full profile: the /users fields plus description, account creation date, ban status and friend / ' +
        'follower / following counts (a count is null if Roblox would not give it). Cached 10 minutes — Roblox ' +
        'allows this lookup only 30 times a minute per server.',
      {
        params: { gameId: 'Game identifier (path).', userId: 'Roblox user ID (path).' },
        responseExample: {
          ...USER_EXAMPLE,
          description: '',
          createdAt: '2006-03-08T17:17:52.9Z',
          isBanned: false,
          friends: 0,
          followers: 71339720,
          following: 67853764,
        },
      },
    ),
    async (req) => {
      const { userId } = parse(UserParams, req.params);
      return ok(found(await getUserProfile(userId, depsFor(req)).catch(upstream), `user with ID ${userId}`), req.id);
    },
  );

  app.get(
    '/users/:userId/groups',
    docs('Every group a user is in, with their role name and rank there. Cached 5 minutes.', {
      params: { gameId: 'Game identifier (path).', userId: 'Roblox user ID (path).' },
      responseExample: {
        userId: 156,
        items: [
          {
            groupId: 7,
            name: 'Roblox',
            memberCount: 8000000,
            hasVerifiedBadge: true,
            role: { roleId: 41, name: 'Owner', rank: 255 },
          },
        ],
        fetchedAt: '2026-09-17T12:00:00.000Z',
      },
    }),
    async (req) => {
      const { userId } = parse(UserParams, req.params);
      return ok(found(await getUserGroups(userId, depsFor(req)).catch(upstream), `user with ID ${userId}`), req.id);
    },
  );

  // ---- groups ----

  app.get(
    '/groups/:groupId',
    docs(
      'One group: name, description, owner, member count, current shout, whether anyone can join, icon, and every ' +
        'role with its rank and member count. Cached 10 minutes — Roblox allows group lookups only 7 times a minute ' +
        'per server, so a new group may briefly 503 under load while cached ones keep answering.',
      {
        params: { gameId: 'Game identifier (path).', groupId: 'Roblox group ID (path).' },
        responseExample: {
          groupId: 295182,
          name: 'Uplift Games',
          description: 'Welcome to Uplift Games, the studio behind Adopt Me!',
          owner: { userId: 13953438, username: 'NewFissy', displayName: 'NewFissy' },
          memberCount: 14730967,
          shout: null,
          publicEntryAllowed: true,
          hasVerifiedBadge: true,
          iconUrl: 'https://tr.rbxcdn.com/…/150/150/Image/Png/noFilter',
          url: 'https://www.roblox.com/communities/295182',
          roles: [
            { roleId: 1680415, name: 'Guest', rank: 0, memberCount: 0 },
            { roleId: 1680414, name: 'Dreamer', rank: 1, memberCount: 14733924 },
          ],
          fetchedAt: '2026-09-17T12:00:00.000Z',
        },
      },
    ),
    async (req) => {
      const { groupId } = parse(GroupParams, req.params);
      return ok(found(await getGroup(groupId, depsFor(req)).catch(upstream), `group with ID ${groupId}`), req.id);
    },
  );
}
