import type { Pool } from 'pg';
import type { ApiKeyStore, Principal } from './principal';
import { Errors } from '../errors/app-error';
import { parseApiKey, secretMatches } from './key-format';
import { QuerySemaphore } from './query-semaphore';

/**
 * A per-game key may only ever hold game scopes. Enforced here as well as at mint time, so a
 * hand-edited row (or a future bug in the panel) still cannot escalate a game key into the
 * control plane. `games:read` is excluded on purpose: GET /v1/games is a cross-tenant list.
 */
export const GAME_SCOPES = [
  'stock:read',
  'stock:write',
  'serial:read',
  'serial:write',
  'funnel:read',
  'funnel:write',
] as const;
const GAME_SCOPE_SET: ReadonlySet<string> = new Set(GAME_SCOPES);

/** How long a resolved key stays cached. This is also the revoke propagation bound. */
const CACHE_TTL_MS = 30_000;
/** Per key, per worker. last_used_at is a display value, never a billing one. */
const TOUCH_INTERVAL_MS = 300_000;
/** `at` while the query is still running, so concurrent callers join instead of re-querying. */
const IN_FLIGHT = Number.MAX_SAFE_INTEGER;

interface KeyRow {
  keyId: string;
  gameId: string;
  secretHash: string;
  scopes: string[];
}

interface CacheEntry {
  /** Date.now() when the query SETTLED — not when it started. */
  at: number;
  p: Promise<KeyRow | null>;
}

/**
 * API key store backed by the api_keys table: the `gk_<id>.<secret>` keys minted in the panel.
 *
 * Sits on the hot path (every request from every Roblox server), so resolution is a primary-key
 * lookup plus a sha256 — no KDF, see key-format.ts. Hits are cached in-process for 30 s, which
 * is therefore the revoke bound: a revoked key keeps working for up to 30 s on a worker that
 * already resolved it. There is no cross-worker invalidation, and that is a deliberate
 * simplification rather than an oversight — a Redis pub/sub channel here does not survive
 * `enableOfflineQueue: false`.
 *
 * Only positive results are cached. Caching misses would bound memory with an eviction cliff,
 * and any `clear()`-on-overflow rule hands an unauthenticated caller a remote cache-flush: the
 * auth hook runs BEFORE the rate limiter, so a flood of random key ids is free to send. Caching
 * hits only self-bounds at the number of real keys, because set() overwrites in place.
 *
 * That "free to send" flood is bounded on the other axis by `gate` (QuerySemaphore): every UNCACHED
 * lookup runs through it, so however many distinct bogus keys arrive at once, only `maxConcurrent`
 * of them hold a pool connection — the rest queue briefly or get a retryable 503. Cached valid keys
 * never enter the gate. A GLOBAL cap, deliberately, not per-IP: Roblox NATs many games behind one
 * egress IP, so a per-IP counter would let one game's misses lock out its neighbours.
 */
export class DbApiKeyStore implements ApiKeyStore {
  private readonly pg: Pool;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly touchedAt = new Map<string, number>();
  /** Caps concurrent UNCACHED lookups so an unauthenticated key flood can't drain the pool. */
  private readonly gate: QuerySemaphore;

  constructor(pg: Pool, maxConcurrent = 4, maxQueue = 64) {
    this.pg = pg;
    this.gate = new QuerySemaphore(maxConcurrent, maxQueue);
  }

  async resolve(rawKey: string): Promise<Principal | null> {
    const parsed = parseApiKey(rawKey);
    if (!parsed) return null; // not our format — the env store's key, or junk. Costs no query.

    let row: KeyRow | null;
    try {
      row = await this.load(parsed.keyId);
    } catch (err) {
      // A lookup failure is not a rejection: we cannot tell "no such key" from "cannot check".
      // 401 would lie to a caller holding a VALID key and, being non-retriable, strand it for
      // the whole outage — 503 is honest and the Roblox client retries it.
      //
      // Translated HERE rather than in the error handler because that handler matches on
      // `.code`, and pg-pool's connection-timeout rejection carries none — it would surface
      // as a 500. Verified against a real pool with Postgres down.
      throw Errors.unavailable(undefined, 1, err);
    }
    if (!row) return null;
    if (!secretMatches(parsed.secret, row.secretHash)) return null;

    this.touch(parsed.keyId);
    return { keyId: row.keyId, allowedGameIds: [row.gameId], scopes: row.scopes };
  }

  private load(keyId: string): Promise<KeyRow | null> {
    const hit = this.cache.get(keyId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.p;

    // The placeholder is overwritten synchronously below; it exists only so the settle
    // handlers can close over `entry` to stamp `at` and to evict by identity.
    const entry: CacheEntry = { at: IN_FLIGHT, p: Promise.resolve(null) };
    // The query runs through the gate: valid keys are served from the cache above and never reach
    // here, so only misses (a flood) and the rare genuine first-lookup contend for the slots. When
    // the gate is saturated it rejects, which the resolve() catch turns into a retryable 503 — the
    // pool is protected without ever blocking a cached, valid caller.
    entry.p = this.gate.run(() => this.query(keyId)).then(
      (row) => {
        entry.at = Date.now(); // stamp on settle: a 5s statement_timeout would eat the whole TTL
        if (!row) this.evict(keyId, entry); // positives only
        return row;
      },
      (err) => {
        this.evict(keyId, entry); // a DB failure must never be cached as a miss
        throw err;
      },
    );
    this.cache.set(keyId, entry);
    return entry.p;
  }

  /** Identity-guarded: a slow rejection must not evict the newer entry that replaced it. */
  private evict(keyId: string, entry: CacheEntry): void {
    if (this.cache.get(keyId) === entry) this.cache.delete(keyId);
  }

  private async query(keyId: string): Promise<KeyRow | null> {
    // The join to game is what makes a deleted game inert: its keys stop authenticating without
    // being revoked, so restoring the game brings every integration back. Revoking on delete
    // would be one-way and leave restore silently broken. Both sides are primary-key lookups,
    // and this whole query is behind the 30s cache — the hot path does not feel it.
    const r = await this.pg.query(
      `SELECT k.key_id, k.game_id, k.secret_hash, k.scopes
       FROM api_keys k
       JOIN game g ON g.game_id = k.game_id AND g.deleted_at IS NULL
       WHERE k.key_id = $1 AND k.revoked_at IS NULL`,
      [keyId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      keyId: row.key_id,
      gameId: row.game_id,
      secretHash: row.secret_hash,
      scopes: (row.scopes as string[]).filter((s) => GAME_SCOPE_SET.has(s)),
    };
  }

  /** Fire-and-forget, throttled. Writing on every request would put a UPDATE on the hot path. */
  private touch(keyId: string): void {
    const now = Date.now();
    if (now - (this.touchedAt.get(keyId) ?? 0) < TOUCH_INTERVAL_MS) return;
    this.touchedAt.set(keyId, now);
    this.pg.query('UPDATE api_keys SET last_used_at = now() WHERE key_id = $1', [keyId]).catch(() => {
      /* display-only; never fail a request because the timestamp did not land */
    });
  }
}
