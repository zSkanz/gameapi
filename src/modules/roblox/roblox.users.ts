/**
 * Roblox users and groups. See roblox.ts for why everything is cached and served stale on failure.
 *
 * Several of these have an in-game equivalent (Players:GetNameFromUserIdAsync, GroupService,
 * Player:GetRankInGroup). What this adds is batching (100 users in one call), the counts the
 * engine does not expose (followers, friends, member counts), and reach from outside a game —
 * a Discord bot or a website holding an API key.
 */
import {
  cachedBatch,
  cachedOne,
  dataOf,
  getJson,
  getJsonOrNull,
  num,
  obj,
  optional,
  str,
  thumbnails,
  type Deps,
} from './roblox';

export const MAX_USER_IDS = 100;
export const USERNAME_REGEX = /^[A-Za-z0-9_]{3,20}$/;

const MINUTE = 60_000;
const HOUR = 3_600;
const DAY = 86_400;

export interface UserSummary {
  userId: number;
  username: string;
  displayName: string;
  hasVerifiedBadge: boolean;
  avatarUrl: string | null;
  profileUrl: string;
  fetchedAt: string;
}

export interface UserProfile extends UserSummary {
  description: string;
  createdAt: string;
  isBanned: boolean;
  /** null when Roblox would not say (that count's endpoint failed); the rest of the profile is still real. */
  friends: number | null;
  followers: number | null;
  following: number | null;
}

export interface UserGroupRole {
  groupId: number;
  name: string;
  memberCount: number;
  hasVerifiedBadge: boolean;
  role: { roleId: number; name: string; rank: number };
}

export interface GroupInfo {
  groupId: number;
  name: string;
  description: string;
  owner: { userId: number; username: string; displayName: string } | null;
  memberCount: number;
  shout: { body: string; posterUserId: number | null; posterUsername: string | null; updatedAt: string } | null;
  publicEntryAllowed: boolean;
  hasVerifiedBadge: boolean;
  iconUrl: string | null;
  url: string;
  /** Ranks ascending. null if the roles call failed while the group itself loaded. */
  roles: { roleId: number; name: string; rank: number; memberCount: number }[] | null;
  fetchedAt: string;
}

const headshots = (deps: Deps, ids: number[]) =>
  thumbnails(
    deps.fetchImpl,
    `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${ids.join(',')}&size=150x150&format=Png&isCircular=false`,
  );

/**
 * Up to 100 users by id.
 * POST users.roblox.com/v1/users — 1000/s. Headshots — 120/min, 100/req.
 * Names change rarely, so 10 minutes fresh; banned/deleted accounts simply do not come back.
 */
export function getUsers(ids: number[], deps: Deps): Promise<{ items: UserSummary[]; missing: number[] }> {
  return cachedBatch(ids, deps, {
    key: (id) => `${deps.prefix}roblox:user:${id}`,
    freshMs: 10 * MINUTE,
    keepSeconds: DAY,
    load: async (toFetch, now) => {
      const [body, avatars] = await Promise.all([
        getJson(deps.fetchImpl, 'https://users.roblox.com/v1/users', { userIds: toFetch, excludeBannedUsers: false }),
        headshots(deps, toFetch),
      ]);
      const out = new Map<number, UserSummary>();
      for (const u of dataOf(body)) {
        const userId = num(u.id);
        if (userId === 0) continue;
        out.set(userId, {
          userId,
          username: str(u.name),
          displayName: str(u.displayName),
          hasVerifiedBadge: u.hasVerifiedBadge === true,
          avatarUrl: avatars.get(userId) ?? null,
          profileUrl: `https://www.roblox.com/users/${userId}/profile`,
          fetchedAt: now.toISOString(),
        });
      }
      return out;
    },
  });
}

/**
 * Up to 100 users by username (case-insensitive). POST users.roblox.com/v1/usernames/users — 500/min.
 * The name -> id mapping is cached on its own for an hour (a rename frees the old name), then the
 * users themselves come from getUsers. `missing` lists the names as they were asked.
 */
export async function getUsersByUsername(
  names: string[],
  deps: Deps,
): Promise<{ items: (UserSummary & { requestedUsername: string })[]; missing: string[] }> {
  const lower = names.map((n) => n.toLowerCase());
  const resolved = await cachedBatch(lower, deps, {
    key: (n) => `${deps.prefix}roblox:uname:${n}`,
    freshMs: 60 * MINUTE,
    keepSeconds: DAY,
    load: async (toFetch) => {
      const body = await getJson(deps.fetchImpl, 'https://users.roblox.com/v1/usernames/users', {
        usernames: toFetch,
        excludeBannedUsers: false,
      });
      const out = new Map<string, { name: string; userId: number }>();
      for (const u of dataOf(body)) {
        const name = str(u.requestedUsername).toLowerCase();
        if (num(u.id) > 0 && name) out.set(name, { name, userId: num(u.id) });
      }
      return out;
    },
  });

  const idByName = new Map(resolved.items.map((r) => [r.name, r.userId]));
  const users = idByName.size > 0 ? await getUsers([...new Set(idByName.values())], deps) : { items: [], missing: [] };
  const userById = new Map(users.items.map((u) => [u.userId, u]));

  const items: (UserSummary & { requestedUsername: string })[] = [];
  const missing: string[] = [];
  names.forEach((requested, i) => {
    const id = idByName.get(lower[i]!);
    const user = id === undefined ? undefined : userById.get(id);
    if (user) items.push({ ...user, requestedUsername: requested });
    else missing.push(requested);
  });
  return { items, missing };
}

/**
 * One full profile, or null for a user that does not exist.
 * users.roblox.com/v1/users/:id — only 30/min per IP, hence 10 minutes fresh and a day of fallback.
 * friends.roblox.com counts — 100/min each; any of them failing leaves that count null.
 */
export function getUserProfile(userId: number, deps: Deps): Promise<UserProfile | null> {
  const count = (what: string) =>
    optional(getJson(deps.fetchImpl, `https://friends.roblox.com/v1/users/${userId}/${what}/count`)).then((b) =>
      b === null ? null : num(obj(b).count),
    );
  return cachedOne(`${deps.prefix}roblox:profile:${userId}`, deps, {
    freshMs: 10 * MINUTE,
    keepSeconds: DAY,
    load: async (now) => {
      const u = await getJsonOrNull(deps.fetchImpl, `https://users.roblox.com/v1/users/${userId}`, [400, 404]);
      if (u === null) return null;
      const [friends, followers, following, avatars] = await Promise.all([
        count('friends'),
        count('followers'),
        count('followings'),
        headshots(deps, [userId]),
      ]);
      const p = obj(u);
      return {
        userId,
        username: str(p.name),
        displayName: str(p.displayName),
        hasVerifiedBadge: p.hasVerifiedBadge === true,
        avatarUrl: avatars.get(userId) ?? null,
        profileUrl: `https://www.roblox.com/users/${userId}/profile`,
        description: str(p.description),
        createdAt: str(p.created),
        isBanned: p.isBanned === true,
        friends,
        followers,
        following,
        fetchedAt: now.toISOString(),
      };
    },
  });
}

/**
 * Every group a user is in, with their role and rank there. null for a user that does not exist.
 * groups.roblox.com/v2/users/:id/groups/roles — 500/min. Ranks change when someone is promoted,
 * so 5 minutes fresh.
 */
export function getUserGroups(userId: number, deps: Deps): Promise<{ userId: number; items: UserGroupRole[]; fetchedAt: string } | null> {
  return cachedOne(`${deps.prefix}roblox:usergroups:${userId}`, deps, {
    freshMs: 5 * MINUTE,
    keepSeconds: HOUR,
    load: async (now) => {
      const body = await getJsonOrNull(deps.fetchImpl, `https://groups.roblox.com/v2/users/${userId}/groups/roles`, [400, 404]);
      if (body === null) return null;
      return {
        userId,
        items: dataOf(body).map((row) => {
          const g = obj(row.group);
          const r = obj(row.role);
          return {
            groupId: num(g.id),
            name: str(g.name),
            memberCount: num(g.memberCount),
            hasVerifiedBadge: g.hasVerifiedBadge === true,
            role: { roleId: num(r.id), name: str(r.name), rank: num(r.rank) },
          };
        }),
        fetchedAt: now.toISOString(),
      };
    },
  });
}

/**
 * One group with its roles, or null for a group that does not exist (Roblox answers 400 for that).
 * groups.roblox.com/v1/groups/:id — SEVEN per minute per IP, the tightest limit in this module.
 * That is why it is 10 minutes fresh and a day of fallback: under load, most answers must be cached.
 * Roles — 800/min. Icon — 100/min.
 */
export function getGroup(groupId: number, deps: Deps): Promise<GroupInfo | null> {
  return cachedOne(`${deps.prefix}roblox:group:${groupId}`, deps, {
    freshMs: 10 * MINUTE,
    keepSeconds: DAY,
    load: async (now) => {
      const g = await getJsonOrNull(deps.fetchImpl, `https://groups.roblox.com/v1/groups/${groupId}`, [400, 404]);
      if (g === null) return null;
      const [roles, icons] = await Promise.all([
        optional(getJson(deps.fetchImpl, `https://groups.roblox.com/v1/groups/${groupId}/roles`)),
        thumbnails(
          deps.fetchImpl,
          `https://thumbnails.roblox.com/v1/groups/icons?groupIds=${groupId}&size=150x150&format=Png&isCircular=false`,
        ),
      ]);
      const group = obj(g);
      const owner = group.owner ? obj(group.owner) : null;
      const shout = group.shout ? obj(group.shout) : null;
      const poster = shout ? obj(shout.poster) : {};
      const roleRows = Array.isArray(obj(roles).roles) ? (obj(roles).roles as unknown[]).map(obj) : null;
      return {
        groupId,
        name: str(group.name),
        description: str(group.description),
        owner: owner ? { userId: num(owner.userId), username: str(owner.username), displayName: str(owner.displayName) } : null,
        memberCount: num(group.memberCount),
        shout:
          shout && str(shout.body)
            ? {
                body: str(shout.body),
                posterUserId: num(poster.userId) || null,
                posterUsername: str(poster.username) || null,
                updatedAt: str(shout.updated),
              }
            : null,
        publicEntryAllowed: group.publicEntryAllowed === true,
        hasVerifiedBadge: group.hasVerifiedBadge === true,
        iconUrl: icons.get(groupId) ?? null,
        url: `https://www.roblox.com/communities/${groupId}`,
        roles: roleRows
          ? roleRows
              .map((r) => ({ roleId: num(r.id), name: str(r.name), rank: num(r.rank), memberCount: num(r.memberCount) }))
              .sort((a, b) => a.rank - b.rank)
          : null,
        fetchedAt: now.toISOString(),
      };
    },
  });
}
