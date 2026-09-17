/**
 * Public Roblox data a game server cannot fetch itself: HttpService refuses every roblox.com
 * domain, so a game that wants its own like count, a player's groups or its badge stats has to
 * ask a proxy. This is that proxy — the shared plumbing, plus experiences (universes/places).
 * Users and groups live in roblox.users.ts, badges and game passes in roblox.catalog.ts.
 *
 * Sources are Roblox's public web APIs; Open Cloud has no endpoint for votes, visits, playing,
 * badge stats or group info. Their rate limits are per egress IP and shared by EVERY game on
 * this server — some are brutally low (group details: 7/min, user profile: 30/min) — which is
 * why every read goes through `cachedBatch`: fresh copies are served without calling Roblox,
 * and when Roblox errors or throttles, the last copy is served instead of failing.
 *
 * Limits measured 2026-09 and noted beside each call.
 */

export const MAX_UNIVERSE_IDS = 50;

/** Live counts move, but nobody needs them to the second — and 60s turns N servers into 1 call. */
export const FRESH_MS = 60_000;

const TIMEOUT_MS = 5_000;

/** Minimal cache surface, so the logic is testable without a Redis. */
export interface Cache {
  mget(keys: string[]): Promise<(string | null)[]>;
  setMany(entries: [key: string, value: string, ttlSeconds: number][]): Promise<void>;
}

export type FetchLike = (
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface Deps {
  cache: Cache;
  prefix: string;
  fetchImpl: FetchLike;
  now?: () => Date;
  onCacheError?: (err: unknown) => void;
}

export class RobloxUpstreamError extends Error {
  constructor(readonly status: number) {
    super(status === 429 ? 'Roblox is rate limiting this server.' : `Roblox answered HTTP ${status || 'no response'}.`);
  }
}

// ---- upstream HTTP ----

export async function getJson(fetchImpl: FetchLike, url: string, postBody?: unknown): Promise<unknown> {
  let res;
  try {
    res = await fetchImpl(url, {
      method: postBody === undefined ? 'GET' : 'POST',
      headers: postBody === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: postBody === undefined ? undefined : JSON.stringify(postBody),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new RobloxUpstreamError(0); // timeout / DNS / connection reset
  }
  if (!res.ok) throw new RobloxUpstreamError(res.status);
  return res.json();
}

/** For lookups where Roblox says "no such thing" with a 4xx: that is a null, not an outage. */
export async function getJsonOrNull(fetchImpl: FetchLike, url: string, notFound: number[]): Promise<unknown | null> {
  try {
    return await getJson(fetchImpl, url);
  } catch (err) {
    if (err instanceof RobloxUpstreamError && notFound.includes(err.status)) return null;
    throw err;
  }
}

/** Decoration (icons, secondary counts) must never cost the caller the data they asked for. */
export const optional = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

export const dataOf = (body: unknown): Record<string, unknown>[] =>
  Array.isArray((body as { data?: unknown } | null)?.data) ? (body as { data: Record<string, unknown>[] }).data : [];

export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** thumbnails.roblox.com answers { data: [{ targetId, imageUrl }] } for every kind of target. */
export async function thumbnails(fetchImpl: FetchLike, url: string): Promise<Map<number, string | null>> {
  const body = await optional(getJson(fetchImpl, url));
  return new Map(dataOf(body).map((t) => [num(t.targetId), str(t.imageUrl) || null]));
}

// ---- cache ----

interface Entry<T> {
  v: T | null; // null = Roblox said it does not exist; cached too, or an unknown id burns budget
  at: number;
}

function parseEntry<T>(raw: string | null | undefined): Entry<T> | null {
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as Entry<T>;
    return e !== null && typeof e === 'object' && typeof e.at === 'number' && 'v' in e ? e : null;
  } catch {
    return null; // an entry from an older format is a miss, not a crash
  }
}

export interface CachePolicy<K, T> {
  key: (id: K) => string;
  /** How long a copy is served without asking Roblox. */
  freshMs: number;
  /** How long it is kept as the fallback for when Roblox fails. May depend on the value. */
  keepSeconds: number | ((value: T | null) => number);
  /** One upstream round for the ids that are not fresh. Ids absent from the map do not exist. */
  load: (ids: K[], now: Date) => Promise<Map<K, T>>;
}

/**
 * Fresh cache hits are served as-is; everything else is loaded in one round. If that round fails,
 * ids with an older copy are served from it (a fetchedAt on the value says how old) and only a
 * request with no fallback at all fails. A Redis outage means a live read, never an error.
 */
export async function cachedBatch<K extends string | number, T>(
  ids: K[],
  deps: Deps,
  policy: CachePolicy<K, T>,
): Promise<{ items: T[]; missing: K[] }> {
  const now = deps.now ?? (() => new Date());

  let raw: (string | null)[] = ids.map(() => null);
  try {
    raw = await deps.cache.mget(ids.map(policy.key));
  } catch (err) {
    deps.onCacheError?.(err);
  }

  const known = new Map<K, Entry<T>>();
  const toFetch: K[] = [];
  ids.forEach((id, i) => {
    const entry = parseEntry<T>(raw[i]);
    if (entry) known.set(id, entry);
    if (!entry || now().getTime() - entry.at >= policy.freshMs) toFetch.push(id);
  });

  if (toFetch.length > 0) {
    try {
      const at = now();
      const loaded = await policy.load(toFetch, at);
      const writes: [string, string, number][] = toFetch.map((id) => {
        const entry: Entry<T> = { v: loaded.get(id) ?? null, at: at.getTime() };
        known.set(id, entry);
        const ttl = typeof policy.keepSeconds === 'function' ? policy.keepSeconds(entry.v) : policy.keepSeconds;
        return [policy.key(id), JSON.stringify(entry), ttl];
      });
      await deps.cache.setMany(writes).catch((err: unknown) => deps.onCacheError?.(err));
    } catch (err) {
      if (!(err instanceof RobloxUpstreamError) || err.status === 400 || toFetch.some((id) => !known.has(id))) throw err;
      // Every id has an older copy: serve those rather than fail the whole call.
    }
  }

  const items: T[] = [];
  const missing: K[] = [];
  for (const id of ids) {
    const v = known.get(id)?.v;
    if (v === null || v === undefined) missing.push(id);
    else items.push(v);
  }
  return { items, missing };
}

/** cachedBatch for a single value. */
export async function cachedOne<T>(
  key: string,
  deps: Deps,
  policy: Omit<CachePolicy<string, T>, 'key' | 'load'> & { load: (now: Date) => Promise<T | null> },
): Promise<T | null> {
  const r = await cachedBatch([key], deps, {
    ...policy,
    key: (k) => k,
    load: async (_ids, now) => {
      const v = await policy.load(now);
      return v === null ? new Map() : new Map([[key, v]]);
    },
  });
  return r.items[0] ?? null;
}

// ---- experiences ----

export interface UniverseInfo {
  universeId: number;
  rootPlaceId: number;
  name: string;
  description: string;
  creator: { id: number; name: string; type: 'User' | 'Group'; hasVerifiedBadge: boolean };
  playing: number;
  visits: number;
  favorites: number;
  upVotes: number;
  downVotes: number;
  /** upVotes / (upVotes + downVotes), 0..1 — what the site shows as the like percentage. null with no votes. */
  likeRatio: number | null;
  maxPlayers: number;
  genre: string | null;
  createdAt: string;
  updatedAt: string;
  iconUrl: string | null;
  url: string;
  /** When this was read from Roblox. Older than a minute means Roblox was unreachable. */
  fetchedAt: string;
}

/**
 * games.roblox.com/v1/games        50/req 300/min   name, creator, playing, visits, favorites
 * games.roblox.com/v1/games/votes  50/req 200/min   upVotes, downVotes
 * thumbnails .../games/icons       50/req 1200/min
 *
 * An unknown universe is NOT a 404 upstream: /v1/games answers a placeholder with id 0 and
 * "[TITLE UNAVAILABLE]". Anything whose id does not echo back is reported as missing.
 */
export async function fetchUniverses(ids: number[], fetchImpl: FetchLike, now = new Date()): Promise<Map<number, UniverseInfo>> {
  const list = ids.join(',');
  const [games, votes, icons] = await Promise.all([
    getJson(fetchImpl, `https://games.roblox.com/v1/games?universeIds=${list}`),
    getJson(fetchImpl, `https://games.roblox.com/v1/games/votes?universeIds=${list}`),
    thumbnails(
      fetchImpl,
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${list}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`,
    ),
  ]);

  const voteById = new Map(dataOf(votes).map((v) => [num(v.id), v]));
  const wanted = new Set(ids);
  const out = new Map<number, UniverseInfo>();

  for (const g of dataOf(games)) {
    const id = num(g.id);
    if (id === 0 || !wanted.has(id)) continue; // the "[TITLE UNAVAILABLE]" placeholder
    const creator = obj(g.creator);
    const v = voteById.get(id) ?? {};
    const up = num(v.upVotes);
    const down = num(v.downVotes);
    const rootPlaceId = num(g.rootPlaceId);
    out.set(id, {
      universeId: id,
      rootPlaceId,
      name: str(g.name),
      description: str(g.description),
      creator: {
        id: num(creator.id),
        name: str(creator.name),
        type: creator.type === 'Group' ? 'Group' : 'User',
        hasVerifiedBadge: creator.hasVerifiedBadge === true,
      },
      playing: num(g.playing),
      visits: num(g.visits),
      favorites: num(g.favoritedCount),
      upVotes: up,
      downVotes: down,
      likeRatio: up + down > 0 ? Math.round((up / (up + down)) * 10_000) / 10_000 : null,
      maxPlayers: num(g.maxPlayers),
      genre: str(g.genre_l1) || str(g.genre) || null,
      createdAt: str(g.created),
      updatedAt: str(g.updated),
      iconUrl: icons.get(id) ?? null,
      url: `https://www.roblox.com/games/${rootPlaceId}`,
      fetchedAt: now.toISOString(),
    });
  }
  return out;
}

export function getUniverses(ids: number[], deps: Deps): Promise<{ items: UniverseInfo[]; missing: number[] }> {
  return cachedBatch(ids, deps, {
    key: (id) => `${deps.prefix}roblox:universe:${id}`,
    freshMs: FRESH_MS,
    keepSeconds: 3_600,
    load: (toFetch, now) => fetchUniverses(toFetch, deps.fetchImpl, now),
  });
}

/**
 * A place ID (the number in a roblox.com/games/<id> URL) -> its universe ID, or null.
 * apis.roblox.com/universes/v1/places/:id/universe — 60/min. A place never moves to another
 * universe, so a hit is kept for 30 days; a miss only 5 minutes, since it might be published later.
 */
export async function getPlaceUniverse(placeId: number, deps: Deps): Promise<number | null> {
  return cachedOne(`${deps.prefix}roblox:place:${placeId}`, deps, {
    freshMs: Number.POSITIVE_INFINITY,
    keepSeconds: (v) => (v === null ? 300 : 30 * 86_400),
    load: async () => {
      const body = await getJson(deps.fetchImpl, `https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
      return num(obj(body).universeId) || null;
    },
  });
}
