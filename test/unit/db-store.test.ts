import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { DbApiKeyStore } from '../../src/core/auth/db-store';
import { generateApiKey } from '../../src/core/auth/key-format';
import { AppError } from '../../src/core/errors/app-error';

/** A fake pool that records SELECTs and answers with one canned key row. */
function fakePool(row: Record<string, unknown> | null) {
  const selects: string[] = [];
  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith('UPDATE')) return { rows: [], rowCount: 0 };
      selects.push(sql);
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }),
  };
  return { pool: pool as unknown as Pool, selects, query: pool.query };
}

function keyRow(overrides: Record<string, unknown> = {}) {
  const k = generateApiKey();
  return {
    k,
    row: {
      key_id: k.keyId,
      game_id: 'sword-sim',
      secret_hash: k.secretHash,
      scopes: ['stock:read', 'stock:write'],
      ...overrides,
    },
  };
}

describe('DbApiKeyStore', () => {
  it('resolves a valid key to a principal scoped to exactly one game', async () => {
    const { k, row } = keyRow();
    const { pool } = fakePool(row);
    const p = await new DbApiKeyStore(pool).resolve(k.fullKey);
    expect(p).toEqual({ keyId: k.keyId, allowedGameIds: ['sword-sim'], scopes: ['stock:read', 'stock:write'] });
  });

  it('rejects a well-formed key whose secret is wrong', async () => {
    const { row } = keyRow();
    const { pool } = fakePool(row);
    const impostor = `${row.key_id}.${generateApiKey().secret}`;
    expect(await new DbApiKeyStore(pool).resolve(impostor)).toBeNull();
  });

  it('never queries for a key that is not the gk_ format', async () => {
    const { pool, selects } = fakePool(null);
    expect(await new DbApiKeyStore(pool).resolve('dev_key_from_env')).toBeNull();
    expect(selects).toHaveLength(0); // the env key must not cost a round trip
  });

  // A per-game key must never escalate into the control plane, even if the row says so.
  it('strips non-game scopes from the row', async () => {
    const { k, row } = keyRow({ scopes: ['stock:read', 'panel:owner', 'games:read', 'serial:write'] });
    const { pool } = fakePool(row);
    const p = await new DbApiKeyStore(pool).resolve(k.fullKey);
    expect(p?.scopes).toEqual(['stock:read', 'serial:write']);
  });

  it('caches a hit: N resolves cost one SELECT', async () => {
    const { k, row } = keyRow();
    const { pool, selects } = fakePool(row);
    const store = new DbApiKeyStore(pool);
    for (let i = 0; i < 50; i++) expect(await store.resolve(k.fullKey)).not.toBeNull();
    expect(selects).toHaveLength(1);
  });

  it('collapses concurrent resolves into a single in-flight query', async () => {
    const { k, row } = keyRow();
    const { pool, selects } = fakePool(row);
    const store = new DbApiKeyStore(pool);
    const all = await Promise.all(Array.from({ length: 25 }, () => store.resolve(k.fullKey)));
    expect(all.every((p) => p !== null)).toBe(true);
    expect(selects).toHaveLength(1);
  });

  // Caching misses would let an unauthenticated flood of random ids grow the map — and any
  // clear()-on-overflow rule would then be a remote cache-flush primitive.
  it('does not cache a miss', async () => {
    const { pool, selects } = fakePool(null);
    const store = new DbApiKeyStore(pool);
    const unknown = generateApiKey().fullKey;
    await store.resolve(unknown);
    await store.resolve(unknown);
    expect(selects).toHaveLength(2);
  });

  // 503, not 401: a lookup failure cannot distinguish "no such key" from "cannot check", and
  // 401 is non-retriable — it would strand a caller holding a valid key for the whole outage.
  it('surfaces a DB failure as a retriable 503, never as a rejection of the key', async () => {
    const { k } = keyRow();
    const cause = new Error('Connection terminated due to connection timeout');
    const pool = { query: vi.fn(async () => { throw cause; }) } as unknown as Pool;

    const err = await new DbApiKeyStore(pool).resolve(k.fullKey).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('SERVICE_UNAVAILABLE');
    expect((err as AppError).statusCode).toBe(503);
    expect((err as AppError).retryAfter).toBe(1);
    // The pg-pool timeout carries no `.code`, so the error handler cannot classify it — the
    // root cause has to ride along or it is lost from the logs entirely.
    expect((err as AppError).cause).toBe(cause);
  });

  it('does not cache a DB failure as a miss', async () => {
    const { k } = keyRow();
    let calls = 0;
    const pool = {
      query: vi.fn(async () => {
        calls++;
        throw new Error('connection terminated');
      }),
    } as unknown as Pool;
    const store = new DbApiKeyStore(pool);
    await expect(store.resolve(k.fullKey)).rejects.toThrow(AppError);
    await expect(store.resolve(k.fullKey)).rejects.toThrow(AppError);
    expect(calls).toBe(2); // a rejection must not poison the entry
  });

  it('throttles last_used_at instead of writing on every request', async () => {
    const { k, row } = keyRow();
    const { pool, query } = fakePool(row);
    const store = new DbApiKeyStore(pool);
    for (let i = 0; i < 20; i++) await store.resolve(k.fullKey);
    const updates = query.mock.calls.filter((c) => String(c[0]).startsWith('UPDATE'));
    expect(updates).toHaveLength(1);
  });

  it('excludes revoked keys in the query itself', async () => {
    const { k, row } = keyRow();
    const { pool, selects } = fakePool(row);
    await new DbApiKeyStore(pool).resolve(k.fullKey);
    expect(selects[0]).toContain('revoked_at IS NULL');
  });
});

describe('DbApiKeyStore — renewing a hit before it expires', () => {
  it('re-checks a nearly expired hit in the background while it keeps answering', async () => {
    vi.useFakeTimers();
    try {
      const { k, row } = keyRow();
      const { pool, selects } = fakePool(row);
      const store = new DbApiKeyStore(pool);
      expect(await store.resolve(k.fullKey)).not.toBeNull();
      vi.advanceTimersByTime(21_000); // inside the refresh-ahead window, not expired
      for (let i = 0; i < 5; i++) expect(await store.resolve(k.fullKey)).not.toBeNull();
      await vi.runAllTimersAsync();
      expect(selects).toHaveLength(2); // one refresh for the five
      vi.advanceTimersByTime(15_000); // 36s after the first lookup, 15s after the renewal: still cached
      expect(await store.resolve(k.fullKey)).not.toBeNull();
      expect(selects).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the key as soon as the refresh finds it revoked', async () => {
    vi.useFakeTimers();
    try {
      const { k, row } = keyRow();
      let live = true;
      const pool = {
        query: vi.fn(async (sql: string) =>
          sql.startsWith('UPDATE') || !live ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 },
        ),
      } as unknown as Pool;
      const store = new DbApiKeyStore(pool);
      expect(await store.resolve(k.fullKey)).not.toBeNull();
      live = false; // revoked
      vi.advanceTimersByTime(21_000);
      expect(await store.resolve(k.fullKey)).not.toBeNull(); // still inside the TTL; refresh starts
      await vi.runAllTimersAsync();
      expect(await store.resolve(k.fullKey)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // The TTL stays a hard bound: failing refreshes never stretch a key's life past it.
  it('still expires on time when every refresh fails', async () => {
    vi.useFakeTimers();
    try {
      const { k, row } = keyRow();
      let up = true;
      const pool = {
        query: vi.fn(async (sql: string) => {
          if (sql.startsWith('UPDATE')) return { rows: [], rowCount: 0 };
          if (!up) throw new Error('connection refused');
          return { rows: [row], rowCount: 1 };
        }),
      } as unknown as Pool;
      const store = new DbApiKeyStore(pool);
      expect(await store.resolve(k.fullKey)).not.toBeNull();
      up = false;
      vi.advanceTimersByTime(21_000);
      expect(await store.resolve(k.fullKey)).not.toBeNull();
      await vi.runAllTimersAsync();
      vi.advanceTimersByTime(9_500); // 30.5s: expired
      await expect(store.resolve(k.fullKey)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    } finally {
      vi.useRealTimers();
    }
  });
});
