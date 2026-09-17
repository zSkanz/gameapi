/**
 * An experience's badges and game passes, one page at a time. See roblox.ts for the caching.
 *
 * Pages are cached per (universe, page size, cursor) for 5 minutes: award counts tick up and a
 * price can change, but neither needs to be live to the second. Roblox's cursors are opaque
 * tokens, passed through untouched as `nextCursor` -> `cursor`.
 */
import { cachedOne, dataOf, getJsonOrNull, num, obj, str, thumbnails, type Deps } from './roblox';

export const MAX_PAGE_SIZE = 100;
/** The badges endpoint accepts exactly these page sizes; anything else is a 400 upstream. */
export const BADGE_PAGE_SIZES = [10, 25, 50, 100] as const;
/** Both Roblox cursor styles: base64 (badges) and `id_…` tokens (game passes). */
export const CURSOR_REGEX = /^[A-Za-z0-9+/=_-]{1,1024}$/;

const PAGE_FRESH_MS = 5 * 60_000;
const PAGE_KEEP_SECONDS = 3_600;

export interface BadgeInfo {
  badgeId: number;
  name: string;
  description: string;
  enabled: boolean;
  iconUrl: string | null;
  awardedCount: number;
  pastDayAwardedCount: number;
  /** Passed through exactly as Roblox reports it (its scale is undocumented). */
  winRatePercentage: number;
  createdAt: string;
  updatedAt: string;
}

export interface GamePassInfo {
  gamePassId: number;
  productId: number;
  name: string;
  description: string;
  /** Robux. null when the pass is not for sale. */
  price: number | null;
  isForSale: boolean;
  iconUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Page<T> {
  universeId: number;
  items: T[];
  /** Pass back as `cursor` for the next page. null on the last page. */
  nextCursor: string | null;
  fetchedAt: string;
}

const pageKey = (deps: Deps, kind: string, universeId: number, limit: number, cursor: string | undefined) =>
  `${deps.prefix}roblox:${kind}:${universeId}:${limit}:${cursor ?? ''}`;

/**
 * badges.roblox.com/v1/universes/:id/badges — 100/min, limit one of BADGE_PAGE_SIZES. Icons — 100/min.
 * null for a universe that does not exist (404). A bad cursor is Roblox's 400, surfaced as such.
 */
export function getBadges(universeId: number, limit: number, cursor: string | undefined, deps: Deps): Promise<Page<BadgeInfo> | null> {
  return cachedOne(pageKey(deps, 'badges', universeId, limit, cursor), deps, {
    freshMs: PAGE_FRESH_MS,
    keepSeconds: PAGE_KEEP_SECONDS,
    load: async (now) => {
      const qs = `limit=${limit}&sortOrder=Asc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const body = await getJsonOrNull(deps.fetchImpl, `https://badges.roblox.com/v1/universes/${universeId}/badges?${qs}`, [404]);
      if (body === null) return null;
      const rows = dataOf(body);
      const icons = rows.length
        ? await thumbnails(
            deps.fetchImpl,
            `https://thumbnails.roblox.com/v1/badges/icons?badgeIds=${rows.map((b) => num(b.id)).join(',')}&size=150x150&format=Png&isCircular=false`,
          )
        : new Map<number, string | null>();
      return {
        universeId,
        items: rows.map((b) => {
          const stats = obj(b.statistics);
          return {
            badgeId: num(b.id),
            name: str(b.displayName) || str(b.name),
            description: str(b.displayDescription) || str(b.description),
            enabled: b.enabled === true,
            iconUrl: icons.get(num(b.id)) ?? null,
            awardedCount: num(stats.awardedCount),
            pastDayAwardedCount: num(stats.pastDayAwardedCount),
            winRatePercentage: num(stats.winRatePercentage),
            createdAt: str(b.created),
            updatedAt: str(b.updated),
          };
        }),
        nextCursor: str(obj(body).nextPageCursor) || null,
        fetchedAt: now.toISOString(),
      };
    },
  });
}

/**
 * apis.roblox.com/game-passes/v1/universes/:id/game-passes — 50/s, pageSize up to 100.
 * (The older games.roblox.com/v1/games/:id/game-passes answers 404 now.) Icons — 100/min.
 */
export function getGamePasses(
  universeId: number,
  limit: number,
  cursor: string | undefined,
  deps: Deps,
): Promise<Page<GamePassInfo> | null> {
  return cachedOne(pageKey(deps, 'passes', universeId, limit, cursor), deps, {
    freshMs: PAGE_FRESH_MS,
    keepSeconds: PAGE_KEEP_SECONDS,
    load: async (now) => {
      const qs = `passView=Full&pageSize=${limit}${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ''}`;
      const body = await getJsonOrNull(
        deps.fetchImpl,
        `https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes?${qs}`,
        [404],
      );
      if (body === null) return null;
      const rows = Array.isArray(obj(body).gamePasses) ? (obj(body).gamePasses as unknown[]).map(obj) : [];
      const icons = rows.length
        ? await thumbnails(
            deps.fetchImpl,
            `https://thumbnails.roblox.com/v1/game-passes?gamePassIds=${rows.map((p) => num(p.id)).join(',')}&size=150x150&format=Png&isCircular=false`,
          )
        : new Map<number, string | null>();
      return {
        universeId,
        items: rows.map((p) => {
          const isForSale = p.isForSale === true;
          return {
            gamePassId: num(p.id),
            productId: num(p.productId),
            name: str(p.displayName) || str(p.name),
            description: str(p.displayDescription),
            price: isForSale && typeof p.price === 'number' ? p.price : null,
            isForSale,
            iconUrl: icons.get(num(p.id)) ?? null,
            createdAt: str(p.created),
            updatedAt: str(p.updated),
          };
        }),
        nextCursor: str(obj(body).nextPageToken) || null,
        fetchedAt: now.toISOString(),
      };
    },
  });
}
