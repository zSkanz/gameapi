import { describe, it, expect } from 'vitest';
import { FRESH_MS, RobloxUpstreamError, getPlaceUniverse, getUniverses, type Cache, type FetchLike } from '../../src/modules/roblox/roblox';
import { UniversesQuery } from '../../src/modules/roblox/roblox.routes';

/** Shapes copied from live responses (2026-09), trimmed to the fields that are read. */
const GAME = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  rootPlaceId: id * 10,
  name: `Game ${id}`,
  description: 'desc',
  creator: { id: 7, name: 'Studio', type: 'Group', hasVerifiedBadge: true },
  playing: 100,
  visits: 5000,
  maxPlayers: 30,
  created: '2020-01-01T00:00:00Z',
  updated: '2026-09-01T00:00:00Z',
  genre: 'RPG',
  genre_l1: 'Roleplay & Avatar Sim',
  favoritedCount: 42,
  ...extra,
});
/** What /v1/games answers for an id that does not exist. */
const PLACEHOLDER = { ...GAME(0), name: '[TITLE UNAVAILABLE]' };

function fakeFetch(routes: {
  games?: unknown[] | number;
  votes?: unknown[] | number;
  icons?: unknown[] | number;
  place?: unknown | number;
}): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const pick = url.includes('/games/votes')
      ? routes.votes
      : url.includes('/games/icons')
        ? routes.icons
        : url.includes('/places/')
          ? routes.place
          : routes.games;
    if (typeof pick === 'number') return { ok: false, status: pick, json: async () => ({}) };
    const body = url.includes('/places/') ? pick : { data: pick ?? [] };
    return { ok: true, status: 200, json: async () => body };
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

function memoryCache(): Cache & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    mget: async (keys) => keys.map((k) => store.get(k) ?? null),
    setMany: async (entries) => {
      for (const [k, v] of entries) store.set(k, v);
    },
  };
}

describe('getUniverses', () => {
  it('merges games, votes and icons into one item per universe', async () => {
    const fetchImpl = fakeFetch({
      games: [GAME(1)],
      votes: [{ id: 1, upVotes: 90, downVotes: 10 }],
      icons: [{ targetId: 1, imageUrl: 'https://tr.rbxcdn.com/icon.png' }],
    });
    const { items, missing } = await getUniverses([1], { cache: memoryCache(), prefix: 'p:', fetchImpl });
    expect(missing).toEqual([]);
    expect(items[0]).toMatchObject({
      universeId: 1,
      rootPlaceId: 10,
      playing: 100,
      visits: 5000,
      favorites: 42,
      upVotes: 90,
      downVotes: 10,
      likeRatio: 0.9,
      genre: 'Roleplay & Avatar Sim',
      iconUrl: 'https://tr.rbxcdn.com/icon.png',
      url: 'https://www.roblox.com/games/10',
      creator: { id: 7, name: 'Studio', type: 'Group', hasVerifiedBadge: true },
    });
  });

  it('reports the "[TITLE UNAVAILABLE]" placeholder as missing, and keeps request order', async () => {
    const fetchImpl = fakeFetch({ games: [GAME(2), PLACEHOLDER, GAME(1)], votes: [] });
    const { items, missing } = await getUniverses([1, 999, 2], { cache: memoryCache(), prefix: 'p:', fetchImpl });
    expect(items.map((i) => i.universeId)).toEqual([1, 2]);
    expect(missing).toEqual([999]);
  });

  it('likeRatio is null with no votes, not NaN', async () => {
    const fetchImpl = fakeFetch({ games: [GAME(1)], votes: [{ id: 1, upVotes: 0, downVotes: 0 }] });
    const { items } = await getUniverses([1], { cache: memoryCache(), prefix: 'p:', fetchImpl });
    expect(items[0]!.likeRatio).toBeNull();
  });

  it('a failed icon lookup does not fail the call', async () => {
    const fetchImpl = fakeFetch({ games: [GAME(1)], votes: [], icons: 500 });
    const { items } = await getUniverses([1], { cache: memoryCache(), prefix: 'p:', fetchImpl });
    expect(items[0]!.iconUrl).toBeNull();
  });

  it('serves a fresh cache hit without calling Roblox, and caches misses too', async () => {
    const cache = memoryCache();
    const first = fakeFetch({ games: [GAME(1)], votes: [] });
    await getUniverses([1, 999], { cache, prefix: 'p:', fetchImpl: first });
    expect(first.calls.length).toBe(3);

    const second = fakeFetch({ games: 500 });
    const r = await getUniverses([1, 999], { cache, prefix: 'p:', fetchImpl: second });
    expect(second.calls).toEqual([]);
    expect(r.items.map((i) => i.universeId)).toEqual([1]);
    expect(r.missing).toEqual([999]);
  });

  it('when Roblox fails, serves the stale copy instead of an error', async () => {
    const cache = memoryCache();
    const t0 = new Date('2026-09-17T12:00:00Z');
    await getUniverses([1], { cache, prefix: 'p:', fetchImpl: fakeFetch({ games: [GAME(1)], votes: [] }), now: () => t0 });

    const later = new Date(t0.getTime() + FRESH_MS + 1);
    const down = fakeFetch({ games: 429, votes: 429 });
    const refreshErrors: unknown[] = [];
    const r = await getUniverses([1], { cache, prefix: 'p:', fetchImpl: down, now: () => later, onRefreshError: (e) => refreshErrors.push(e) });
    expect(r.items[0]!.fetchedAt).toBe(t0.toISOString()); // served at once, and says how old it is
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(down.calls.length).toBeGreaterThan(0); // the refresh did try, in the background
    expect(refreshErrors.length).toBe(1); // and its failure was reported, not thrown at the caller
  });

  it('fails when Roblox fails and there is nothing cached to fall back on', async () => {
    await expect(
      getUniverses([1], { cache: memoryCache(), prefix: 'p:', fetchImpl: fakeFetch({ games: 503, votes: [] }) }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('a garbage body from Roblox is an upstream failure, not a crash', async () => {
    const htmlPage: FetchLike = async () => ({ ok: true, status: 200, json: async () => JSON.parse('<html>') });
    await expect(getUniverses([1], { cache: memoryCache(), prefix: 'p:', fetchImpl: htmlPage })).rejects.toBeInstanceOf(
      RobloxUpstreamError,
    );
  });

  it('a Redis outage means a live read, not an error', async () => {
    const broken: Cache = {
      mget: async () => {
        throw new Error('redis down');
      },
      setMany: async () => {
        throw new Error('redis down');
      },
    };
    const errors: unknown[] = [];
    const r = await getUniverses([1], {
      cache: broken,
      prefix: 'p:',
      fetchImpl: fakeFetch({ games: [GAME(1)], votes: [] }),
      onCacheError: (e) => errors.push(e),
    });
    expect(r.items.length).toBe(1);
    expect(errors.length).toBe(2);
  });
});

describe('getPlaceUniverse', () => {
  it('resolves and caches, and returns null for an unknown place', async () => {
    const cache = memoryCache();
    const f = fakeFetch({ place: { universeId: 383310974 } });
    expect(await getPlaceUniverse(920587237, { cache, prefix: 'p:', fetchImpl: f })).toBe(383310974);
    expect(await getPlaceUniverse(920587237, { cache, prefix: 'p:', fetchImpl: fakeFetch({ place: 500 }) })).toBe(383310974);
    expect(await getPlaceUniverse(1, { cache, prefix: 'p:', fetchImpl: fakeFetch({ place: { universeId: null } }) })).toBeNull();
    expect(await getPlaceUniverse(1, { cache, prefix: 'p:', fetchImpl: fakeFetch({ place: 500 }) })).toBeNull();
  });
});

describe('?ids= parsing', () => {
  const parse = (ids?: string) => UniversesQuery.safeParse(ids === undefined ? {} : { ids });

  it('dedupes and trims, keeping order', () => {
    expect(parse(' 3, 1,3 ,2,').data?.ids).toEqual([3, 1, 2]);
  });

  it('rejects junk, zero, missing and more than 50', () => {
    expect(parse('abc').success).toBe(false);
    expect(parse('0').success).toBe(false);
    expect(parse('1.5').success).toBe(false);
    expect(parse('').success).toBe(false);
    expect(parse().success).toBe(false);
    expect(parse(Array.from({ length: 51 }, (_, i) => i + 1).join(',')).success).toBe(false);
    expect(parse(Array.from({ length: 50 }, (_, i) => i + 1).join(',')).success).toBe(true);
  });
});
