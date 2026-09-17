import { describe, it, expect } from 'vitest';
import type { Cache, Deps, FetchLike } from '../../src/modules/roblox/roblox';
import { getGroup, getUserGroups, getUserProfile, getUsersByUsername } from '../../src/modules/roblox/roblox.users';
import { getBadges, getGamePasses } from '../../src/modules/roblox/roblox.catalog';
import { PageQuery, UsernamesQuery, UsersQuery } from '../../src/modules/roblox/roblox.routes';

/** Answers by the first route whose substring the URL contains; a number is an HTTP error status. */
function fakeFetch(routes: [match: string, answer: unknown][]): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string, init: { body?: string }) => {
    calls.push(init.body ? `${url} ${init.body}` : url);
    const hit = routes.find(([m]) => url.includes(m));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    if (typeof hit[1] === 'number') return { ok: false, status: hit[1], json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit[1] };
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

function deps(fetchImpl: FetchLike, store = new Map<string, string>()): Deps & { store: Map<string, string> } {
  const cache: Cache = {
    mget: async (keys) => keys.map((k) => store.get(k) ?? null),
    setMany: async (entries) => {
      for (const [k, v] of entries) store.set(k, v);
    },
  };
  return { cache, prefix: 'p:', fetchImpl, store };
}

describe('users', () => {
  it('resolves usernames case-insensitively, keeps request order and spelling, lists unknown names', async () => {
    const f = fakeFetch([
      [
        '/v1/usernames/users',
        {
          data: [
            { requestedUsername: 'roblox', id: 1, name: 'Roblox' },
            { requestedUsername: 'Builderman', id: 156, name: 'builderman' },
          ],
        },
      ],
      [
        'users.roblox.com/v1/users',
        {
          data: [
            { id: 1, name: 'Roblox', displayName: 'Roblox', hasVerifiedBadge: true },
            { id: 156, name: 'builderman', displayName: 'builderman', hasVerifiedBadge: true },
          ],
        },
      ],
      ['avatar-headshot', { data: [{ targetId: 156, imageUrl: 'https://tr.rbxcdn.com/h.png' }] }],
    ]);
    const r = await getUsersByUsername(['Builderman', 'nobody_here', 'roblox'], deps(f));
    expect(r.items.map((u) => [u.requestedUsername, u.userId])).toEqual([
      ['Builderman', 156],
      ['roblox', 1],
    ]);
    expect(r.missing).toEqual(['nobody_here']);
    expect(r.items[0]!.avatarUrl).toBe('https://tr.rbxcdn.com/h.png');
    expect(r.items[1]!.avatarUrl).toBeNull();
  });

  it('a profile whose follower count fails still loads, with that count null', async () => {
    const f = fakeFetch([
      ['/v1/users/156/friends/count', { count: 3 }],
      ['/v1/users/156/followers/count', 500],
      ['/v1/users/156/followings/count', { count: 9 }],
      ['users.roblox.com/v1/users/156', { id: 156, name: 'builderman', displayName: 'b', created: '2006-03-08T17:17:52.9Z', isBanned: false }],
    ]);
    const p = await getUserProfile(156, deps(f));
    expect(p).toMatchObject({ userId: 156, friends: 3, followers: null, following: 9, createdAt: '2006-03-08T17:17:52.9Z' });
  });

  it('an unknown user is null, and that answer is cached — no second call to Roblox', async () => {
    const store = new Map<string, string>();
    const first = fakeFetch([['users.roblox.com/v1/users/9', 404]]);
    expect(await getUserProfile(9, deps(first, store))).toBeNull();
    const second = fakeFetch([]);
    expect(await getUserProfile(9, deps(second, store))).toBeNull();
    expect(second.calls).toEqual([]);
  });

  it("maps a user's groups and roles", async () => {
    const f = fakeFetch([
      [
        '/v2/users/156/groups/roles',
        { data: [{ group: { id: 7, name: 'Roblox', memberCount: 10, hasVerifiedBadge: true }, role: { id: 41, name: 'Owner', rank: 255 } }] },
      ],
    ]);
    const r = await getUserGroups(156, deps(f));
    expect(r!.items).toEqual([{ groupId: 7, name: 'Roblox', memberCount: 10, hasVerifiedBadge: true, role: { roleId: 41, name: 'Owner', rank: 255 } }]);
  });
});

describe('groups', () => {
  it('sorts roles by rank and keeps the group when only the roles call fails', async () => {
    const group = { id: 5, name: 'G', owner: { userId: 1, username: 'o', displayName: 'O' }, memberCount: 3, shout: null };
    const withRoles = fakeFetch([
      ['/v1/groups/5/roles', { roles: [{ id: 2, name: 'Admin', rank: 255, memberCount: 1 }, { id: 1, name: 'Member', rank: 1, memberCount: 2 }] }],
      ['/v1/groups/5', group],
    ]);
    expect((await getGroup(5, deps(withRoles)))!.roles!.map((r) => r.rank)).toEqual([1, 255]);

    const rolesDown = fakeFetch([
      ['/v1/groups/5/roles', 503],
      ['/v1/groups/5', group],
    ]);
    const g = await getGroup(5, deps(rolesDown));
    expect(g).toMatchObject({ groupId: 5, name: 'G', roles: null, owner: { userId: 1 } });
  });

  it('Roblox answers 400 for a group that does not exist: that is null, not an error', async () => {
    expect(await getGroup(999, deps(fakeFetch([['/v1/groups/999', 400]])))).toBeNull();
  });

  it('keeps a shout only when it has a body', async () => {
    const f = fakeFetch([
      ['/v1/groups/5/roles', { roles: [] }],
      ['/v1/groups/5', { id: 5, name: 'G', shout: { body: 'hi', poster: { userId: 2, username: 'p' }, updated: '2026-01-01T00:00:00Z' } }],
    ]);
    expect((await getGroup(5, deps(f)))!.shout).toEqual({ body: 'hi', posterUserId: 2, posterUsername: 'p', updatedAt: '2026-01-01T00:00:00Z' });
  });
});

describe('badges and game passes', () => {
  it('pages badges with their statistics and passes the cursor through', async () => {
    const f = fakeFetch([
      ['/badges/icons', { data: [{ targetId: 11, imageUrl: 'https://tr.rbxcdn.com/b.png' }] }],
      [
        '/v1/universes/1/badges',
        {
          nextPageCursor: 'abc==',
          data: [{ id: 11, name: 'n', displayName: 'Shown', enabled: true, statistics: { awardedCount: 5, pastDayAwardedCount: 1, winRatePercentage: 0.5 } }],
        },
      ],
    ]);
    const page = await getBadges(1, 10, 'xyz+/=', deps(f));
    expect(page).toMatchObject({ nextCursor: 'abc==', items: [{ badgeId: 11, name: 'Shown', awardedCount: 5, iconUrl: 'https://tr.rbxcdn.com/b.png' }] });
    expect(f.calls[0]).toContain('cursor=xyz%2B%2F%3D'); // encoded, never spliced raw into the query
  });

  it('a game pass that is not for sale has price null; the last page has nextCursor null', async () => {
    const f = fakeFetch([
      ['/v1/game-passes?', { data: [] }],
      [
        '/game-passes/v1/universes/1/game-passes',
        { nextPageToken: '', gamePasses: [{ id: 3, name: 'VIP', isForSale: false, price: null }, { id: 4, name: 'X', isForSale: true, price: 25 }] },
      ],
    ]);
    const page = await getGamePasses(1, 100, undefined, deps(f));
    expect(page!.items.map((p) => p.price)).toEqual([null, 25]);
    expect(page!.nextCursor).toBeNull();
  });

  it('an unknown universe is null', async () => {
    expect(await getGamePasses(9, 100, undefined, deps(fakeFetch([['/universes/9/game-passes', 404]])))).toBeNull();
  });

  it('a rejected cursor (400) is an error, never served from an older page', async () => {
    const store = new Map<string, string>();
    const good = fakeFetch([['/v1/universes/1/badges', { data: [], nextPageCursor: null }]]);
    await getBadges(1, 10, 'c1', { ...deps(good, store), now: () => new Date('2026-01-01T00:00:00Z') });
    const later = { ...deps(fakeFetch([['/v1/universes/1/badges', 400]]), store), now: () => new Date('2026-02-01T00:00:00Z') };
    await expect(getBadges(1, 10, 'c1', later)).rejects.toThrow(/HTTP 400/);
  });
});

describe('query parsing', () => {
  it('usernames: trims, dedupes, rejects bad characters', () => {
    expect(UsernamesQuery.parse({ names: ' builderman ,Roblox,builderman' }).names).toEqual(['builderman', 'Roblox']);
    expect(UsernamesQuery.safeParse({ names: 'bad name' }).success).toBe(false);
    expect(UsernamesQuery.safeParse({ names: 'ab' }).success).toBe(false);
  });

  it('user ids: at most 100', () => {
    expect(UsersQuery.safeParse({ ids: Array.from({ length: 100 }, (_, i) => i + 1).join(',') }).success).toBe(true);
    expect(UsersQuery.safeParse({ ids: Array.from({ length: 101 }, (_, i) => i + 1).join(',') }).success).toBe(false);
  });

  it('pages: default 100, cursor charset enforced', () => {
    expect(PageQuery.parse({})).toEqual({ limit: 100 });
    expect(PageQuery.safeParse({ cursor: 'a&b=c' }).success).toBe(false);
    expect(PageQuery.safeParse({ limit: '0' }).success).toBe(false);
  });
});
