import type { Pool, PoolClient } from 'pg';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../../config/env';
import { Errors } from '../../core/errors/app-error';
import { fingerprint } from '../../core/idempotency/idempotency';
import { stockOperations } from '../../core/metrics';

export interface DecreaseResult {
  gameId: string;
  stockKey: string;
  requested: number;
  decremented: number;
  stock: number;
  clamped: boolean;
}

export interface AdjustResult {
  gameId: string;
  stockKey: string;
  delta: number;
  applied: number;
  stock: number;
  max: number;
  clamped: boolean; // hit the 0 floor
  capped: boolean; // hit the max ceiling
}

export interface GetResult {
  gameId: string;
  stockKey: string;
  stock: number;
  max: number;
  created: boolean;
}

export interface SetMaxResult {
  gameId: string;
  stockKey: string;
  max: number;
  stock: number;
  stockClamped: boolean;
}

/**
 * The only layer that touches Postgres. Postgres is the single source of truth: every
 * mutation is an atomic, row-locked read-modify-write in one SQL statement, so many
 * concurrent Roblox servers hitting the same stock key can never oversell. Idempotency
 * is enforced by the ledger UNIQUE(game_id, stock_key, event_id): a retried mutation
 * replays the stored result instead of applying twice.
 */
export class StockRepository {
  private readonly pg: Pool;
  private readonly redis: Redis;
  private readonly autoProvision: boolean;
  private readonly prefix: string;
  private readonly cacheTtl: number;

  constructor(pg: Pool, redis: Redis, config: AppConfig) {
    this.pg = pg;
    this.redis = redis;
    this.autoProvision = config.env.AUTO_PROVISION_GAMES;
    this.prefix = config.env.REDIS_KEY_PREFIX;
    this.cacheTtl = config.env.READ_CACHE_TTL_SECONDS;
  }

  // Short read cache: serves the *displayed* stock from Redis for a few seconds so heavy
  // polling doesn't hit Postgres. Fail-open (Redis down -> Postgres). Bounded-stale by TTL;
  // the exact mutation path never reads the cache, so it can't cause oversell.
  private cacheKey(gameId: string, stockKey: string): string {
    return `${this.prefix}rc:${gameId}:${stockKey}`;
  }
  private async cacheGet(gameId: string, stockKey: string): Promise<{ stock: number; max: number } | null> {
    if (this.cacheTtl <= 0) return null;
    try {
      const raw = await this.redis.get(this.cacheKey(gameId, stockKey));
      return raw ? (JSON.parse(raw) as { stock: number; max: number }) : null;
    } catch {
      return null;
    }
  }
  private async cacheSet(gameId: string, stockKey: string, v: { stock: number; max: number }): Promise<void> {
    if (this.cacheTtl <= 0) return;
    try {
      await this.redis.set(this.cacheKey(gameId, stockKey), JSON.stringify(v), 'EX', this.cacheTtl);
    } catch {
      /* fail-open */
    }
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Claim the idempotency slot. Returns true if this is the first time (apply), false if
   *  it is a replay (a row already exists — caller returns the stored result). */
  private async claim(
    c: PoolClient,
    gameId: string,
    stockKey: string,
    eventId: string,
    op: string,
    requested: number,
    fp: string,
    keyId: string,
  ): Promise<boolean> {
    const res = await c.query(
      `INSERT INTO stock_ledger (event_id, game_id, stock_key, op, requested, applied, new_value, fingerprint, api_key_id)
       VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $7)
       ON CONFLICT (game_id, stock_key, event_id) DO NOTHING
       RETURNING id`,
      [eventId, gameId, stockKey, op, requested, fp, keyId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Read the stored result of a prior mutation; reject if the same key was reused with a
   *  different payload (fingerprint mismatch -> 422). */
  private async replay(
    c: PoolClient,
    gameId: string,
    stockKey: string,
    eventId: string,
    fp: string,
  ): Promise<{ applied: number; newValue: number }> {
    const r = await c.query(
      `SELECT applied, new_value, fingerprint FROM stock_ledger
       WHERE game_id=$1 AND stock_key=$2 AND event_id=$3`,
      [gameId, stockKey, eventId],
    );
    const row = r.rows[0];
    if (row.fingerprint && fp && row.fingerprint !== fp) throw Errors.idempotencyKeyReused();
    return { applied: Number(row.applied), newValue: Number(row.new_value) };
  }

  private async fill(
    c: PoolClient,
    gameId: string,
    stockKey: string,
    eventId: string,
    applied: number,
    newValue: number,
  ): Promise<void> {
    await c.query(
      `UPDATE stock_ledger SET applied=$4, new_value=$5 WHERE game_id=$1 AND stock_key=$2 AND event_id=$3`,
      [gameId, stockKey, eventId, applied, newValue],
    );
  }

  // ---------------------------------------------------------------- decrease
  async decrease(
    gameId: string,
    stockKey: string,
    amount: number,
    eventId: string,
    keyId: string,
  ): Promise<DecreaseResult> {
    const fp = fingerprint(gameId, stockKey, 'decrease', { amount });
    return this.tx(async (c) => {
      if (!(await this.claim(c, gameId, stockKey, eventId, 'decrease', amount, fp, keyId))) {
        const p = await this.replay(c, gameId, stockKey, eventId, fp);
        const decremented = -p.applied;
        stockOperations.labels('decrease', 'replayed').inc();
        return { gameId, stockKey, requested: amount, decremented, stock: p.newValue, clamped: decremented < amount };
      }

      const upd = await c.query(
        `WITH prev AS (
           SELECT current_stock AS old_value FROM stock
           WHERE game_id=$1 AND stock_key=$2 FOR UPDATE
         )
         UPDATE stock s SET current_stock = GREATEST(0, prev.old_value - $3), updated_at = now()
         FROM prev WHERE s.game_id=$1 AND s.stock_key=$2
         RETURNING prev.old_value AS old_value, s.current_stock AS new_value`,
        [gameId, stockKey, amount],
      );
      if (upd.rowCount === 0) throw Errors.stockKeyNotFound(gameId, stockKey);

      const oldValue = Number(upd.rows[0].old_value);
      const newValue = Number(upd.rows[0].new_value);
      const decremented = oldValue - newValue;
      await this.fill(c, gameId, stockKey, eventId, -decremented, newValue);
      stockOperations.labels('decrease', decremented < amount ? 'clamped' : 'ok').inc();
      return { gameId, stockKey, requested: amount, decremented, stock: newValue, clamped: decremented < amount };
    });
  }

  // ---------------------------------------------------------------- adjust
  async adjust(
    gameId: string,
    stockKey: string,
    delta: number,
    eventId: string,
    keyId: string,
  ): Promise<AdjustResult> {
    const fp = fingerprint(gameId, stockKey, 'adjust', { delta });
    return this.tx(async (c) => {
      if (!(await this.claim(c, gameId, stockKey, eventId, 'adjust', delta, fp, keyId))) {
        const p = await this.replay(c, gameId, stockKey, eventId, fp);
        const cur = await c.query(`SELECT max_stock FROM stock WHERE game_id=$1 AND stock_key=$2`, [gameId, stockKey]);
        const max = Number(cur.rows[0]?.max_stock ?? 0);
        stockOperations.labels('adjust', 'replayed').inc();
        return { gameId, stockKey, delta, applied: p.applied, stock: p.newValue, max, clamped: p.newValue === 0, capped: p.newValue === max };
      }

      const upd = await c.query(
        `WITH prev AS (
           SELECT current_stock AS old_value, max_stock AS max FROM stock
           WHERE game_id=$1 AND stock_key=$2 FOR UPDATE
         )
         UPDATE stock s SET current_stock = LEAST(GREATEST(0, prev.old_value + $3), prev.max), updated_at = now()
         FROM prev WHERE s.game_id=$1 AND s.stock_key=$2
         RETURNING prev.old_value AS old_value, s.current_stock AS new_value, prev.max AS max`,
        [gameId, stockKey, delta],
      );
      if (upd.rowCount === 0) throw Errors.stockKeyNotFound(gameId, stockKey);

      const oldValue = Number(upd.rows[0].old_value);
      const newValue = Number(upd.rows[0].new_value);
      const max = Number(upd.rows[0].max);
      const applied = newValue - oldValue;
      await this.fill(c, gameId, stockKey, eventId, applied, newValue);
      stockOperations.labels('adjust', newValue === 0 || newValue === max ? 'capped' : 'ok').inc();
      return {
        gameId,
        stockKey,
        delta,
        applied,
        stock: newValue,
        max,
        clamped: newValue === 0 && oldValue + delta < 0,
        capped: newValue === max && oldValue + delta > max,
      };
    });
  }

  // ---------------------------------------------------------------- get (get-or-create)
  async get(
    gameId: string,
    stockKey: string,
    expectedStock: number | undefined,
    keyId: string,
  ): Promise<GetResult> {
    const cached = await this.cacheGet(gameId, stockKey);
    if (cached) {
      stockOperations.labels('get', 'ok').inc();
      return { gameId, stockKey, stock: cached.stock, max: cached.max, created: false };
    }

    if (expectedStock === undefined) {
      const ex = await this.pg.query(
        `SELECT current_stock, max_stock FROM stock WHERE game_id=$1 AND stock_key=$2`,
        [gameId, stockKey],
      );
      if (ex.rowCount === 0) throw Errors.stockKeyNotFound(gameId, stockKey);
      const v = { stock: Number(ex.rows[0].current_stock), max: Number(ex.rows[0].max_stock) };
      await this.cacheSet(gameId, stockKey, v);
      stockOperations.labels('get', 'ok').inc();
      return { gameId, stockKey, stock: v.stock, max: v.max, created: false };
    }

    const result = await this.tx(async (c) => {
      if (this.autoProvision) {
        await c.query(`INSERT INTO game (game_id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [gameId]);
      }
      const ins = await c.query(
        `INSERT INTO stock (game_id, stock_key, current_stock, max_stock, created_by)
         VALUES ($1, $2, $3, $3, $4)
         ON CONFLICT (game_id, stock_key) DO NOTHING
         RETURNING current_stock, max_stock`,
        [gameId, stockKey, expectedStock, keyId],
      );

      if (ins.rowCount && ins.rowCount > 0) {
        await c.query(
          `INSERT INTO stock_ledger (event_id, game_id, stock_key, op, requested, applied, new_value, api_key_id)
           VALUES ($1, $2, $3, 'create', $4, $4, $4, $5) ON CONFLICT DO NOTHING`,
          [`create:${gameId}:${stockKey}`, gameId, stockKey, expectedStock, keyId],
        );
        stockOperations.labels('get', 'created').inc();
        return { gameId, stockKey, stock: expectedStock, max: expectedStock, created: true };
      }

      const ex = await c.query(
        `SELECT current_stock, max_stock FROM stock WHERE game_id=$1 AND stock_key=$2`,
        [gameId, stockKey],
      );
      stockOperations.labels('get', 'ok').inc();
      return { gameId, stockKey, stock: Number(ex.rows[0].current_stock), max: Number(ex.rows[0].max_stock), created: false };
    });
    await this.cacheSet(gameId, stockKey, { stock: result.stock, max: result.max });
    return result;
  }

  // ---------------------------------------------------------------- set-max
  async setMax(
    gameId: string,
    stockKey: string,
    targetMax: number,
    eventId: string,
    keyId: string,
  ): Promise<SetMaxResult> {
    const fp = fingerprint(gameId, stockKey, 'set-max', { targetStockMax: targetMax });
    return this.tx(async (c) => {
      if (!(await this.claim(c, gameId, stockKey, eventId, 'set_max', targetMax, fp, keyId))) {
        const p = await this.replay(c, gameId, stockKey, eventId, fp);
        return { gameId, stockKey, max: targetMax, stock: p.newValue, stockClamped: p.applied < 0 };
      }

      const upd = await c.query(
        `WITH prev AS (
           SELECT current_stock AS old_value FROM stock
           WHERE game_id=$1 AND stock_key=$2 FOR UPDATE
         )
         UPDATE stock s SET max_stock = $3, current_stock = LEAST(prev.old_value, $3), updated_at = now()
         FROM prev WHERE s.game_id=$1 AND s.stock_key=$2
         RETURNING prev.old_value AS old_value, s.current_stock AS new_value`,
        [gameId, stockKey, targetMax],
      );
      if (upd.rowCount === 0) throw Errors.stockKeyNotFound(gameId, stockKey);

      const oldStock = Number(upd.rows[0].old_value);
      const stock = Number(upd.rows[0].new_value);
      await this.fill(c, gameId, stockKey, eventId, stock - oldStock, stock);
      stockOperations.labels('set_max', 'ok').inc();
      return { gameId, stockKey, max: targetMax, stock, stockClamped: oldStock > targetMax };
    });
  }

  // ---------------------------------------------------------------- pure read
  async read(
    gameId: string,
    stockKey: string,
  ): Promise<{ gameId: string; stockKey: string; stock: number; max: number }> {
    const cached = await this.cacheGet(gameId, stockKey);
    if (cached) return { gameId, stockKey, stock: cached.stock, max: cached.max };
    const r = await this.pg.query(
      `SELECT current_stock, max_stock FROM stock WHERE game_id=$1 AND stock_key=$2`,
      [gameId, stockKey],
    );
    if (r.rowCount === 0) throw Errors.stockKeyNotFound(gameId, stockKey);
    const v = { stock: Number(r.rows[0].current_stock), max: Number(r.rows[0].max_stock) };
    await this.cacheSet(gameId, stockKey, v);
    return { gameId, stockKey, stock: v.stock, max: v.max };
  }

  // Batch read: many keys in one query. `items` = found keys; `missing` = keys that don't
  // exist. No cache here — a single query for N keys is already cheap.
  async batchRead(
    gameId: string,
    stockKeys: string[],
  ): Promise<{ items: { stockKey: string; stock: number; max: number }[]; missing: string[] }> {
    const r = await this.pg.query(
      `SELECT stock_key, current_stock, max_stock FROM stock WHERE game_id=$1 AND stock_key = ANY($2)`,
      [gameId, stockKeys],
    );
    const found = new Map<string, { stock: number; max: number }>(
      r.rows.map((row) => [row.stock_key, { stock: Number(row.current_stock), max: Number(row.max_stock) }]),
    );
    const items = stockKeys
      .filter((k) => found.has(k))
      .map((k) => ({ stockKey: k, stock: found.get(k)!.stock, max: found.get(k)!.max }));
    const missing = stockKeys.filter((k) => !found.has(k));
    return { items, missing };
  }

  // List every stock key registered for a game (paginated). `total` is the full count.
  async list(
    gameId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: { stockKey: string; stock: number; max: number }[]; total: number }> {
    const r = await this.pg.query(
      `SELECT stock_key, current_stock, max_stock, COUNT(*) OVER() AS total
       FROM stock WHERE game_id=$1 ORDER BY stock_key LIMIT $2 OFFSET $3`,
      [gameId, limit, offset],
    );
    const total = r.rowCount && r.rowCount > 0 ? Number(r.rows[0].total) : 0;
    const items = r.rows.map((row) => ({
      stockKey: row.stock_key,
      stock: Number(row.current_stock),
      max: Number(row.max_stock),
    }));
    return { items, total };
  }
}
