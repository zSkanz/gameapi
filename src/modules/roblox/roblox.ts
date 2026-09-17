/**
 * Public Roblox data a game server cannot fetch itself: HttpService refuses every roblox.com
 * domain, so a game that wants its own like count, visits or live player count has to ask a
 * proxy. This is that proxy.
 *
 * Sources — Roblox's public web APIs. Open Cloud has no endpoint for votes, visits or playing,
 * so these unauthenticated ones are the only source. Limits measured 2026-09 (per egress IP,
 * shared by EVERY game on this server — which is why everything below is cached):
 *
 *   games.roblox.com/v1/games?universeIds=       name, creator, playing, visits, favorites  50/req  300/min
 *   games.roblox.com/v1/games/votes?universeIds= upVotes, downVotes                         50/req  200/min
 *   thumbnails.roblox.com/v1/games/icons         icon URL                                    50/req 1200/min
 *   apis.roblox.com/universes/v1/places/:id/universe   place -> universe                      1/req   60/min
 *
 * An unknown universe is NOT a 404 upstream: /v1/games answers a placeholder with id 0 and
 * "[TITLE UNAVAILABLE]". Anything whose id does not echo back is reported as missing.
 */

export const MAX_UNIVERSE_IDS = 50;

/** Live counts move, but nobody needs them to the second — and 60s turns N servers into 1 call. */
export const FRESH_MS = 60_000;
/** Kept past freshness so a Roblox outage or 429 degrades to slightly old data, not an error. */
const KEEP_SECONDS = 3_600;
/** A place never moves to another universe. */
const PLACE_KEEP_SECONDS = 30 * 86_400;
/** But a place that does not exist yet might be published later. */
const PLACE_MISSING_SECONDS = 300;

const TIMEOUT_MS = 5_000;

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

/** Minimal cache surface, so the logic is testable without a Redis. */
export interface Cache {
  mget(keys: string[]): Promise<(string | null)[]>;
  setMany(entries: [key: string, value: string][], ttlSeconds: number): Promise<void>;
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export class RobloxUpstreamError extends Error {
  constructor(readonly status: number) {
    super(status === 429 ? 'Roblox is rate limiting this server.' : `Roblox answered HTTP ${status || 'no response'}.`);
  }
}

async function getJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new RobloxUpstreamError(0); // timeout / DNS / connection reset
  }
  if (!res.ok) throw new RobloxUpstreamError(res.status);
  return res.json();
}

const dataOf = (body: unknown): Record<string, unknown>[] =>
  Array.isArray((body as { data?: unknown })?.data) ? ((body as { data: Record<string, unknown>[] }).data) : [];

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One round of upstream calls for up to 50 ids. Missing ids are simply absent from the map. */
export async function fetchUniverses(ids: number[], fetchImpl: FetchLike, now = new Date()): Promise<Map<number, UniverseInfo>> {
  const list = ids.join(',');
  const [games, votes, icons] = await Promise.all([
    getJson(fetchImpl, `https://games.roblox.com/v1/games?universeIds=${list}`),
    getJson(fetchImpl, `https://games.roblox.com/v1/games/votes?universeIds=${list}`),
    // The icon is decoration: its failure must not cost the caller the numbers they asked for.
    getJson(
      fetchImpl,
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${list}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`,
    ).catch(() => null),
  ]);

  const voteById = new Map(dataOf(votes).map((v) => [num(v.id), v]));
  const iconById = new Map(dataOf(icons).map((i) => [num(i.targetId), str(i.imageUrl) || null]));
  const wanted = new Set(ids);
  const out = new Map<number, UniverseInfo>();

  for (const g of dataOf(games)) {
    const id = num(g.id);
    if (id === 0 || !wanted.has(id)) continue; // the "[TITLE UNAVAILABLE]" placeholder
    const creator = (g.creator ?? {}) as Record<string, unknown>;
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
      iconUrl: iconById.get(id) ?? null,
      url: `https://www.roblox.com/games/${rootPlaceId}`,
      fetchedAt: now.toISOString(),
    });
  }
  return out;
}

type Cached = UniverseInfo | { missing: true; fetchedAt: string };

/**
 * Fresh cache hits are served as-is; everything else is fetched in one upstream round. If that
 * round fails, ids with an older cached copy are served from it (their fetchedAt says how old)
 * and only a request with no fallback at all fails.
 */
export async function getUniverses(
  ids: number[],
  deps: { cache: Cache; prefix: string; fetchImpl: FetchLike; now?: () => Date; onCacheError?: (err: unknown) => void },
): Promise<{ items: UniverseInfo[]; missing: number[] }> {
  const now = deps.now ?? (() => new Date());
  const key = (id: number): string => `${deps.prefix}roblox:universe:${id}`;

  let raw: (string | null)[] = ids.map(() => null);
  try {
    raw = await deps.cache.mget(ids.map(key));
  } catch (err) {
    deps.onCacheError?.(err); // fail open: a Redis blip means a live read, not an error
  }

  const known = new Map<number, Cached>();
  const toFetch: number[] = [];
  ids.forEach((id, i) => {
    const entry = raw[i] ? (JSON.parse(raw[i]!) as Cached) : null;
    if (entry) known.set(id, entry);
    if (!entry || now().getTime() - Date.parse(entry.fetchedAt) >= FRESH_MS) toFetch.push(id);
  });

  if (toFetch.length > 0) {
    try {
      const fetched = await fetchUniverses(toFetch, deps.fetchImpl, now());
      const at = now().toISOString();
      const entries: [string, string][] = toFetch.map((id) => {
        const value: Cached = fetched.get(id) ?? { missing: true, fetchedAt: at };
        known.set(id, value);
        return [key(id), JSON.stringify(value)];
      });
      await deps.cache.setMany(entries, KEEP_SECONDS).catch((err: unknown) => deps.onCacheError?.(err));
    } catch (err) {
      if (!(err instanceof RobloxUpstreamError) || toFetch.some((id) => !known.has(id))) throw err;
      // Every id has an older copy: serve those rather than fail the whole call.
    }
  }

  const items: UniverseInfo[] = [];
  const missing: number[] = [];
  for (const id of ids) {
    const entry = known.get(id);
    if (entry && !('missing' in entry)) items.push(entry);
    else missing.push(id);
  }
  return { items, missing };
}

/** A place ID (the number in a roblox.com/games/<id> URL) -> its universe ID, or null. */
export async function getPlaceUniverse(
  placeId: number,
  deps: { cache: Cache; prefix: string; fetchImpl: FetchLike; onCacheError?: (err: unknown) => void },
): Promise<number | null> {
  const key = `${deps.prefix}roblox:place:${placeId}`;
  const hit = await deps.cache.mget([key]).catch((err: unknown) => {
    deps.onCacheError?.(err);
    return [null];
  });
  if (hit[0] !== null && hit[0] !== undefined) return hit[0] === '' ? null : Number(hit[0]);

  const body = await getJson(deps.fetchImpl, `https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
  const universeId = num((body as { universeId?: unknown })?.universeId) || null;
  await deps.cache
    .setMany([[key, universeId === null ? '' : String(universeId)]], universeId === null ? PLACE_MISSING_SECONDS : PLACE_KEEP_SECONDS)
    .catch((err: unknown) => deps.onCacheError?.(err));
  return universeId;
}
