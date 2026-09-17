import { describe, it, expect } from 'vitest';
import { AppError } from '../../src/core/errors/app-error';
import {
  FRESH_MS,
  RobloxUpstreamError,
  cachedBatch,
  newRobloxState,
  type Budget,
  type Cache,
  type CachePolicy,
  type Deps,
} from '../../src/modules/roblox/roblox';

/**
 * The protections added after the audit of the Roblox proxy. Each one guards a shared resource an
 * API key could otherwise exhaust for every tenant: Redis memory (noeviction, shared with stock and
 * sessions) and Roblox's per-IP budget.
 */

function memoryCache(): Cache & { ttls: Map<string, number>; store: Map<string, string> } {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    mget: async (keys) => keys.map((k) => store.get(k) ?? null),
    setMany: async (entries) => {
      for (const [k, v, ttl] of entries) {
        store.set(k, v);
        ttls.set(k, ttl);
      }
    },
  };
}

const unused = async () => {
  throw new Error('fetch is not used by these tests');
};

function policy(
  load: (ids: number[]) => Promise<Map<number, { id: number; icon: string | null }>>,
  extra: Partial<CachePolicy<number, { id: number; icon: string | null }>> = {},
): CachePolicy<number, { id: number; icon: string | null }> {
  return {
    name: 'thing',
    budget: 'light',
    key: (id) => `t:${id}`,
    freshMs: FRESH_MS,
    keepSeconds: 3_600,
    load: (ids) => load(ids),
    ...extra,
  };
}

const found = (ids: number[]) => new Map(ids.filter((id) => id < 1000).map((id) => [id, { id, icon: 'x' }]));

describe('cache-miss metering', () => {
  it('charges light lookups per uncached id and heavy lookups once; cached reads are free', async () => {
    const charges: [Budget, number][] = [];
    const cache = memoryCache();
    const deps: Deps = { cache, prefix: '', fetchImpl: unused, beforeLoad: async (b, c) => void charges.push([b, c]) };

    await cachedBatch([1, 2, 3], deps, policy(async (ids) => found(ids)));
    await cachedBatch([1, 2, 3], deps, policy(async (ids) => found(ids))); // all fresh now
    await cachedBatch([4], deps, policy(async (ids) => found(ids), { budget: 'heavy', key: (id) => `h:${id}` }));

    expect(charges).toEqual([
      ['light', 3],
      ['heavy', 1],
    ]);
  });

  it('a refused charge with nothing cached fails the call, and never reaches Roblox', async () => {
    let loads = 0;
    const deps: Deps = {
      cache: memoryCache(),
      prefix: '',
      fetchImpl: unused,
      beforeLoad: async () => {
        throw new AppError('RATE_LIMITED', 'slow down');
      },
    };
    await expect(cachedBatch([1], deps, policy(async (ids) => (loads++, found(ids))))).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(loads).toBe(0);
  });

  it('a refused charge with a stale copy still serves the copy', async () => {
    const cache = memoryCache();
    const t0 = new Date('2026-09-17T12:00:00Z');
    await cachedBatch([1], { cache, prefix: '', fetchImpl: unused, now: () => t0 }, policy(async (ids) => found(ids)));

    const limited: Deps = {
      cache,
      prefix: '',
      fetchImpl: unused,
      now: () => new Date(t0.getTime() + FRESH_MS + 1),
      beforeLoad: async () => {
        throw new AppError('RATE_LIMITED', 'slow down');
      },
    };
    const r = await cachedBatch([1], limited, policy(async (ids) => found(ids)));
    expect(r.items).toEqual([{ id: 1, icon: 'x' }]);
  });
});

describe('Redis memory', () => {
  it('keeps "does not exist" answers at most five minutes, whatever the policy keeps', async () => {
    const cache = memoryCache();
    await cachedBatch([1, 5000], { cache, prefix: '', fetchImpl: unused }, policy(async (ids) => found(ids), { keepSeconds: 86_400 }));
    expect(cache.ttls.get('t:1')).toBe(86_400);
    expect(cache.ttls.get('t:5000')).toBe(300);
  });

  it('a degraded answer (a decoration failed) goes stale after a minute, not the full window', async () => {
    const cache = memoryCache();
    const t0 = new Date('2026-09-17T12:00:00Z');
    const p = policy(async (ids) => new Map(ids.map((id) => [id, { id, icon: null }])), {
      freshMs: 10 * FRESH_MS,
      degraded: (v) => v.icon === null,
    });
    await cachedBatch([1], { cache, prefix: '', fetchImpl: unused, now: () => t0 }, p);

    let reloads = 0;
    const counting = policy(async (ids) => (reloads++, found(ids)), { freshMs: 10 * FRESH_MS, degraded: (v) => v.icon === null });
    await cachedBatch([1], { cache, prefix: '', fetchImpl: unused, now: () => new Date(t0.getTime() + 30_000) }, counting);
    expect(reloads).toBe(0); // still fresh at 30s
    await cachedBatch([1], { cache, prefix: '', fetchImpl: unused, now: () => new Date(t0.getTime() + 61_000) }, counting);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reloads).toBe(1); // stale at 61s, so it refreshed — a full answer would have held 10 minutes
  });
});

describe('Roblox budget', () => {
  it('identical concurrent loads collapse into one upstream round', async () => {
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deps: Deps = { cache: memoryCache(), prefix: '', fetchImpl: unused, state: newRobloxState() };
    const p = policy(async (ids) => {
      loads++;
      await gate;
      return found(ids);
    });

    const calls = Array.from({ length: 20 }, () => cachedBatch([7], deps, p));
    release();
    const results = await Promise.all(calls);
    expect(loads).toBe(1);
    expect(results.every((r) => r.items[0]?.id === 7)).toBe(true);
    expect(deps.state!.inflight.size).toBe(0); // cleaned up
  });

  it('after a 429, that kind of lookup stops asking Roblox for a while', async () => {
    let loads = 0;
    const deps: Deps = { cache: memoryCache(), prefix: '', fetchImpl: unused, state: newRobloxState() };
    const throttled = policy(async () => {
      loads++;
      throw new RobloxUpstreamError(429);
    });
    await expect(cachedBatch([1], deps, throttled)).rejects.toBeInstanceOf(RobloxUpstreamError);
    await expect(cachedBatch([2], deps, throttled)).rejects.toMatchObject({ status: 429 });
    expect(loads).toBe(1); // the second never reached Roblox

    // A different kind of lookup is not paused.
    const other = policy(async (ids) => found(ids), { name: 'other', key: (id) => `o:${id}` });
    expect((await cachedBatch([3], deps, other)).items.length).toBe(1);
  });
});
