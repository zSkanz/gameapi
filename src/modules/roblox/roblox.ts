/**
 * Public Roblox data a game server cannot fetch itself: HttpService refuses every roblox.com
 * domain, so a game that wants its own like count, a player's groups or its badge stats has to
 * ask a proxy. This is that proxy — the shared plumbing, plus experiences (universes/places).
 * Users and groups live in roblox.users.ts, badges and game passes in roblox.catalog.ts.
 *
 * Sources are Roblox's public web APIs; Open Cloud has no endpoint for votes, visits, playing,
 * badge stats or group info. Their rate limits are per egress IP and shared by EVERY game on
 * this server — some are brutally low (group details: 7/min, user profile: 30/min) — which is
 * why every read goes through `cachedBatch`. Limits measured 2026-09 and noted beside each call.
 */
import { AppError } from '../../core/errors/app-error';

export const MAX_UNIVERSE_IDS = 50;

/** Live counts move, but nobody needs them to the second — and 60s turns N servers into 1 call. */
export const FRESH_MS = 60_000;

const TIMEOUT_MS = 5_000;
/** A "does not exist" answer is kept briefly: cheap for an attacker to generate, and ids get created. */
const NULL_KEEP_SECONDS = 300;
/** A result missing a decoration (icon, a count) is served, but retried soon instead of for the full window. */
const DEGRADED_FRESH_MS = 60_000;
/** After Roblox answers 429 for a kind of lookup, stop asking for a while: every retry extends the throttle. */
const COOLDOWN_MS = 30_000;

/** Minimal cache surface, so the logic is testable without a Redis. */
export interface Cache {
  mget(keys: string[]): Promise<(string | null)[]>;
  setMany(entries: [key: string, value: string, ttlSeconds: number][]): Promise<void>;
}

export type FetchLike = (
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Which meter a cache miss is charged to. `light` misses are cheap for Roblox and small in Redis
 * (a user, a universe) and cost one unit per id; `heavy` ones are scarce upstream (group details,
 * profiles) or large in Redis (a page of 100 badges) and cost one unit per lookup.
 */
export type Budget = 'light' | 'heavy';

export interface Deps {
  cache: Cache;
  prefix: string;
  fetchImpl: FetchLike;
  now?: () => Date;
  onCacheError?: (err: unknown) => void;
  /** Called before any upstream load, with what it will cost. Throw (RATE_LIMITED) to refuse it. */
  beforeLoad?: (budget: Budget, cost: number) => Promise<void>;
  /** A background refresh failed; the caller already got the stale copy. */
  onRefreshError?: (err: unknown) => void;
  /**
   * Per-process coordination, shared by every request of one app: identical concurrent loads
   * collapse into one, and a 429 pauses that kind of lookup. Absent in tests that do not want it.
   */
  state?: { inflight: Map<string, Promise<Map<string, unknown>>>; cooldownUntil: Map<string, number> };
}

export const newRobloxState = (): NonNullable<Deps['state']> => ({ inflight: new Map(), cooldownUntil: new Map() });

export class RobloxUpstreamError extends Error {
  constructor(readonly status: number) {
    super(status === 429 ? 'Roblox is rate limiting this server.' : `Roblox answered HTTP ${status || 'no response'}.`);
  }
}

// ---- upstream HTTP ----

export async function getJson(fetchImpl: FetchLike, url: string, postBody?: unknown): Promise<unknown> {
  try {
    const res = await fetchImpl(url, {
      method: postBody === undefined ? 'GET' : 'POST',
      headers: postBody === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: postBody === undefined ? undefined : JSON.stringify(postBody),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new RobloxUpstreamError(res.status);
    // Inside the try: an HTML error page served with 200, a truncated body or a timeout while
    // reading it is Roblox failing, and must take the stale-fallback path — not become a 500.
    return await res.json();
  } catch (err) {
    if (err instanceof RobloxUpstreamError) throw err;
    throw new RobloxUpstreamError(0); // timeout / DNS / reset / unparseable body
  }
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
  /** Names the kind of lookup: the unit a Roblox 429 pauses. */
  name: string;
  budget: Budget;
  key: (id: K) => string;
  /** How long a copy is served without asking Roblox. */
  freshMs: number;
  /** How long it is kept as the fallback for when Roblox fails (null answers: at most 5 minutes). */
  keepSeconds: number;
  /** True when a decoration failed to load: the value is served but refreshed after a minute. */
  degraded?: (value: T) => boolean;
  /** One upstream round for the ids that are not fresh. Ids absent from the map do not exist. */
  load: (ids: K[], now: Date) => Promise<Map<K, T>>;
}

const isRateLimited = (err: unknown): boolean => err instanceof AppError && err.code === 'RATE_LIMITED';

/**
 * Serve from cache wherever possible:
 *  - fresh copies are served without calling Roblox;
 *  - if every requested id has a copy but some are stale, the copies are served IMMEDIATELY and
 *    refreshed in the background — a slow or throttled Roblox never slows a cached answer;
 *  - only ids with no copy at all make the caller wait for Roblox, and if that fails the call
 *    fails (a lookup with nothing to fall back on has no honest answer to give).
 * A Redis outage means a live read, never an error.
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
    const refresh = loadAndStore(toFetch, deps, policy, now);
    if (toFetch.every((id) => known.has(id))) {
      refresh.catch((err: unknown) => {
        if (!isRateLimited(err)) deps.onRefreshError?.(err);
      });
    } else {
      for (const [id, entry] of await refresh) known.set(id, entry);
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

/** One upstream round, deduplicated across concurrent identical requests, written to the cache. */
async function loadAndStore<K extends string | number, T>(
  toFetch: K[],
  deps: Deps,
  policy: CachePolicy<K, T>,
  now: () => Date,
): Promise<Map<K, Entry<T>>> {
  const flightKey = toFetch.map(policy.key).join('|');
  const existing = deps.state?.inflight.get(flightKey) as Promise<Map<K, Entry<T>>> | undefined;
  if (existing) return existing;

  const flight = (async () => {
    if (Date.now() < (deps.state?.cooldownUntil.get(policy.name) ?? 0)) throw new RobloxUpstreamError(429);
    await deps.beforeLoad?.(policy.budget, policy.budget === 'light' ? toFetch.length : 1);

    const at = now();
    let loaded: Map<K, T>;
    try {
      loaded = await policy.load(toFetch, at);
    } catch (err) {
      if (err instanceof RobloxUpstreamError && err.status === 429) {
        deps.state?.cooldownUntil.set(policy.name, Date.now() + COOLDOWN_MS);
      }
      throw err;
    }

    const entries = new Map<K, Entry<T>>();
    const writes: [string, string, number][] = [];
    for (const id of toFetch) {
      const v = loaded.get(id) ?? null;
      // A degraded value is dated back so it goes stale after DEGRADED_FRESH_MS, not the full window.
      const stamp = v !== null && policy.degraded?.(v) ? at.getTime() - policy.freshMs + DEGRADED_FRESH_MS : at.getTime();
      const entry: Entry<T> = { v, at: stamp };
      entries.set(id, entry);
      writes.push([policy.key(id), JSON.stringify(entry), v === null ? Math.min(policy.keepSeconds, NULL_KEEP_SECONDS) : policy.keepSeconds]);
    }
    await deps.cache.setMany(writes).catch((err: unknown) => deps.onCacheError?.(err));
    return entries;
  })();

  if (deps.state) {
    deps.state.inflight.set(flightKey, flight as Promise<Map<string, unknown>>);
    // Cleared whichever way it ends; the catch only stops this bookkeeping chain from being an
    // unhandled rejection — the caller still receives the original rejection from `flight`.
    flight.finally(() => deps.state!.inflight.delete(flightKey)).catch(() => {});
  }
  return flight;
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
    name: 'universe',
    budget: 'light',
    key: (id) => `${deps.prefix}roblox:universe:${id}`,
    freshMs: FRESH_MS,
    keepSeconds: 3_600,
    degraded: (u) => u.iconUrl === null,
    load: (toFetch, now) => fetchUniverses(toFetch, deps.fetchImpl, now),
  });
}

/**
 * A place ID (the number in a roblox.com/games/<id> URL) -> its universe ID, or null.
 * apis.roblox.com/universes/v1/places/:id/universe — 60/min. Answers {universeId:null} for an
 * unknown place; a 400/404 is treated the same. A place never moves universe, so a hit is kept a
 * week; a miss only the null window, since the place might be published later.
 */
export async function getPlaceUniverse(placeId: number, deps: Deps): Promise<number | null> {
  return cachedOne(`${deps.prefix}roblox:place:${placeId}`, deps, {
    name: 'place',
    budget: 'light',
    freshMs: Number.POSITIVE_INFINITY,
    keepSeconds: 7 * 86_400,
    load: async () => {
      const body = await getJsonOrNull(deps.fetchImpl, `https://apis.roblox.com/universes/v1/places/${placeId}/universe`, [400, 404]);
      return num(obj(body).universeId) || null;
    },
  });
}
