import type { Pool, PoolClient } from 'pg';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../../config/env';
import { Errors, type AppError } from '../../core/errors/app-error';
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

/** The panel's row shape. The game-facing list projects this down to stockKey/stock/max. */
export interface StockListItem {
  stockKey: string;
  stock: number;
  max: number;
  /** Live serials that draw from this key — they stop issuing the moment it is deleted. */
  linkedSerials: string[];
  deletedAt: string | null;
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

  /**
   * Why a filtered write matched no row: the key never existed (404), or it was deleted (409).
   * A deleted key must never answer 404 — the 404 tells the caller to /get with expectedStock,
   * which refuses in turn, and that is a retry loop.
   */
  private async deadKey(c: PoolClient, gameId: string, stockKey: string): Promise<AppError> {
    const r = await c.query(`SELECT deleted_at FROM stock WHERE game_id=$1 AND stock_key=$2`, [gameId, stockKey]);
    const row = r.rows[0];
    if (row?.deleted_at) return Errors.stockKeyDeleted(gameId, stockKey);
    return Errors.stockKeyNotFound(gameId, stockKey);
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
           WHERE game_id=$1 AND stock_key=$2 AND deleted_at IS NULL FOR UPDATE
         )
         UPDATE stock s SET current_stock = GREATEST(0, prev.old_value - $3), updated_at = now()
         FROM prev WHERE s.game_id=$1 AND s.stock_key=$2 AND s.deleted_at IS NULL
         RETURNING prev.old_value AS old_value, s.current_stock AS new_value`,
        [gameId, stockKey, amount],
      );
      if (upd.rowCount === 0) throw await this.deadKey(c, gameId, stockKey);

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
        // Deliberately NOT filtered on deleted_at: this is a replay of a mutation that already
        // happened, so it must report the numbers it reported the first time. Filtering here
        // would fabricate max:0 for a key that was deleted after the original call.
        const cur = await c.query(`SELECT max_stock FROM stock WHERE game_id=$1 AND stock_key=$2`, [gameId, stockKey]);
        const max = Number(cur.rows[0]?.max_stock ?? 0);
        stockOperations.labels('adjust', 'replayed').inc();
        return { gameId, stockKey, delta, applied: p.applied, stock: p.newValue, max, clamped: p.newValue === 0, capped: p.newValue === max };
      }

      const upd = await c.query(
        `WITH prev AS (
           SELECT current_stock AS old_value, max_stock AS max FROM stock
           WHERE game_id=$1 AND stock_key=$2 AND deleted_at IS NULL FOR UPDATE
         )
         UPDATE stock s SET current_stock = LEAST(GREATEST(0, prev.old_value + $3), prev.max), updated_at = now()
         FROM prev WHERE s.game_id=$1 AND s.stock_key=$2 AND s.deleted_at IS NULL
         RETURNING prev.old_value AS old_value, s.current_stock AS new_value, prev.max AS max`,
        [gameId, stockKey, delta],
      );
      if (upd.rowCount === 0) throw await this.deadKey(c, gameId, stockKey);

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
        `SELECT current_stock, max_stock, deleted_at FROM stock WHERE game_id=$1 AND stock_key=$2`,
        [gameId, stockKey],
      );
      const row = ex.rows[0];
      if (!row) throw Errors.stockKeyNotFound(gameId, stockKey);
      if (row.deleted_at) throw Errors.stockKeyDeleted(gameId, stockKey);
      const v = { stock: Number(row.current_stock), max: Number(row.max_stock) };
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

      // The INSERT conflicted, so a row exists — but it may be a soft-deleted one, since the
      // PK slot stays occupied. Select deleted_at rather than filtering: a filter here would
      // return zero rows and fall into the unguarded rows[0] below as a 500.
      const ex = await c.query(
        `SELECT current_stock, max_stock, deleted_at FROM stock WHERE game_id=$1 AND stock_key=$2`,
        [gameId, stockKey],
      );
      const row = ex.rows[0];
      if (!row) throw Errors.stockKeyNotFound(gameId, stockKey); // raced with a purge
      // Refuse to resurrect. Deleting is a control-plane act, and get-or-create is what every
      // Roblox server calls on boot — resurrecting here would let the next server that starts
      // silently undo an admin's deletion.
      if (row.deleted_at) throw Errors.stockKeyDeleted(gameId, stockKey);
      stockOperations.labels('get', 'ok').inc();
      return { gameId, stockKey, stock: Number(row.current_stock), max: Number(row.max_stock), created: false };
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
           WHERE game_id=$1 AND stock_key=$2 AND deleted_at IS NULL FOR UPDATE
         )
         UPDATE stock s SET max_stock = $3, current_stock = LEAST(prev.old_value, $3), updated_at = now()
         FROM prev WHERE s.game_id=$1 AND s.stock_key=$2 AND s.deleted_at IS NULL
         RETURNING prev.old_value AS old_value, s.current_stock AS new_value`,
        [gameId, stockKey, targetMax],
      );
      if (upd.rowCount === 0) throw await this.deadKey(c, gameId, stockKey);

      const oldStock = Number(upd.rows[0].old_value);
      const stock = Number(upd.rows[0].new_value);
      await this.fill(c, gameId, stockKey, eventId, stock - oldStock, stock);
      stockOperations.labels('set_max', 'ok').inc();
      return { gameId, stockKey, max: targetMax, stock, stockClamped: oldStock > targetMax };
    });
  }

  // ================================================================ panel (control plane)
  // These are reached only through /v1/panel/* behind a session cookie. They write a ledger
  // row like every other mutation, with api_key_id='panel:<userId>', so the audit trail is
  // the same one the game writes to — there is no second history to reconcile.

  /** Create a key outright. Unlike get-or-create this REFUSES an existing key, deleted or not. */
  async create(
    gameId: string,
    stockKey: string,
    stock: number,
    max: number,
    eventId: string,
    actorId: string,
  ): Promise<GetResult> {
    if (stock > max) throw Errors.validation('stock cannot exceed max.');
    const result = await this.tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO stock (game_id, stock_key, current_stock, max_stock, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (game_id, stock_key) DO NOTHING
         RETURNING current_stock`,
        [gameId, stockKey, stock, max, actorId],
      );
      if (ins.rowCount === 0) {
        // The PK slot is taken. A soft-deleted row still occupies it, and restore — not
        // create — is the only way back: that is what makes an incarnation counter unnecessary,
        // because two incarnations can never share a ledger.
        const ex = await c.query(`SELECT deleted_at FROM stock WHERE game_id=$1 AND stock_key=$2`, [gameId, stockKey]);
        if (ex.rows[0]?.deleted_at) {
          throw Errors.conflict('That stock key exists but is deleted. Restore it instead of re-creating it.', {
            gameId,
            stockKey,
          });
        }
        throw Errors.conflict('That stock key already exists.', { gameId, stockKey });
      }
      await this.ledger(c, gameId, stockKey, eventId, 'create', stock, stock, stock, actorId);
      return { gameId, stockKey, stock, max, created: true };
    });
    await this.cacheDrop(gameId, stockKey);
    return result;
  }

  /** Set the current stock to an exact value, clamped to the row's own max. */
  async setStock(
    gameId: string,
    stockKey: string,
    stock: number,
    eventId: string,
    actorId: string,
  ): Promise<{ gameId: string; stockKey: string; stock: number; max: number; capped: boolean }> {
    const result = await this.tx(async (c) => {
      const upd = await c.query(
        `WITH prev AS (
           SELECT current_stock AS old_value, max_stock AS max FROM stock
           WHERE game_id=$1 AND stock_key=$2 AND deleted_at IS NULL FOR UPDATE
         )
         UPDATE stock s SET current_stock = LEAST($3, prev.max), updated_at = now()
         FROM prev WHERE s.game_id=$1 AND s.stock_key=$2 AND s.deleted_at IS NULL
         RETURNING prev.old_value AS old_value, s.current_stock AS new_value, prev.max AS max`,
        [gameId, stockKey, stock],
      );
      if (upd.rowCount === 0) throw await this.deadKey(c, gameId, stockKey);
      const oldValue = Number(upd.rows[0].old_value);
      const newValue = Number(upd.rows[0].new_value);
      const max = Number(upd.rows[0].max);
      // Clamped in SQL rather than validated in the schema: max is per-row, so only the
      // locked row knows it. Sending stock > max would otherwise trip the table's own
      // CHECK (current_stock <= max_stock) and surface as a 500.
      await this.ledger(c, gameId, stockKey, eventId, 'set_stock', stock, newValue - oldValue, newValue, actorId);
      return { gameId, stockKey, stock: newValue, max, capped: stock > max };
    });
    await this.cacheDrop(gameId, stockKey);
    return result;
  }

  /** Soft delete: the key stops answering, keeps its values, and can be restored. */
  async softDelete(
    gameId: string,
    stockKey: string,
    eventId: string,
    actorId: string,
  ): Promise<{ gameId: string; stockKey: string; stock: number; linkedSerials: string[] }> {
    const result = await this.tx(async (c) => {
      const upd = await c.query(
        `UPDATE stock SET deleted_at = now(), deleted_by = $3, updated_at = now()
         WHERE game_id=$1 AND stock_key=$2 AND deleted_at IS NULL
         RETURNING current_stock`,
        [gameId, stockKey, actorId],
      );
      if (upd.rowCount === 0) throw await this.deadKey(c, gameId, stockKey);
      const stock = Number(upd.rows[0].current_stock);
      // Reported, not blocked: a linked serial keeps its row and its count, it just cannot
      // issue while its supply is gone. Restoring the stock makes it whole again.
      const ser = await c.query(
        `SELECT serial_key FROM serial
         WHERE game_id=$1 AND stock_key=$2 AND deleted_at IS NULL ORDER BY serial_key`,
        [gameId, stockKey],
      );
      await this.ledger(c, gameId, stockKey, eventId, 'delete', null, 0, stock, actorId);
      return { gameId, stockKey, stock, linkedSerials: ser.rows.map((r) => r.serial_key as string) };
    });
    await this.cacheDrop(gameId, stockKey);
    return result;
  }

  /** Undo a soft delete. The row never moved, so this restores its exact values. */
  async restore(
    gameId: string,
    stockKey: string,
    eventId: string,
    actorId: string,
  ): Promise<{ gameId: string; stockKey: string; stock: number; max: number }> {
    const result = await this.tx(async (c) => {
      const upd = await c.query(
        `UPDATE stock SET deleted_at = NULL, deleted_by = NULL, updated_at = now()
         WHERE game_id=$1 AND stock_key=$2 AND deleted_at IS NOT NULL
         RETURNING current_stock, max_stock`,
        [gameId, stockKey],
      );
      if (upd.rowCount === 0) {
        const ex = await c.query(`SELECT 1 FROM stock WHERE game_id=$1 AND stock_key=$2`, [gameId, stockKey]);
        if (ex.rowCount === 0) throw Errors.stockKeyNotFound(gameId, stockKey);
        throw Errors.conflict('That stock key is not deleted.', { gameId, stockKey });
      }
      const stock = Number(upd.rows[0].current_stock);
      await this.ledger(c, gameId, stockKey, eventId, 'restore', null, 0, stock, actorId);
      return { gameId, stockKey, stock, max: Number(upd.rows[0].max_stock) };
    });
    await this.cacheDrop(gameId, stockKey);
    return result;
  }

  /**
   * Destroy a key and its history, freeing the name. Owner-only, irreversible, and the ONLY
   * operation that frees the PK slot — which is why re-create can safely refuse a deleted key.
   *
   * Requires a prior soft delete. That is the safeguard the whole design leans on: by the time
   * anything is destroyed, the key has been refusing every game server for as long as it took
   * the operator to click twice.
   */
  async purge(
    gameId: string,
    stockKey: string,
    actorId: string,
  ): Promise<{ gameId: string; stockKey: string; ledgerRowsDeleted: number; severedSerials: string[] }> {
    const { severed } = await this.tx(async (c) => {
      const del = await c.query(
        `DELETE FROM stock WHERE game_id=$1 AND stock_key=$2 AND deleted_at IS NOT NULL RETURNING stock_key`,
        [gameId, stockKey],
      );
      if (del.rowCount === 0) {
        const ex = await c.query(`SELECT 1 FROM stock WHERE game_id=$1 AND stock_key=$2`, [gameId, stockKey]);
        if (ex.rowCount === 0) throw Errors.stockKeyNotFound(gameId, stockKey);
        throw Errors.conflict('Delete the stock key before purging it.', { gameId, stockKey });
      }
      // Sever the link, or the name is free and the next stock created under it silently
      // adopts these serials — which resume decrementing it, mid-count. There is no FK here
      // to do this for us.
      const sev = await c.query(
        `UPDATE serial SET stock_key = NULL, updated_at = now()
         WHERE game_id=$1 AND stock_key=$2 RETURNING serial_key`,
        [gameId, stockKey],
      );
      return { severed: sev.rows.map((r) => r.serial_key as string) };
    });

    // After the row is gone and committed, so a slow ledger delete cannot hold the stock row's
    // lock. Batched because statement_timeout is 5s and an unbounded DELETE on a popular key
    // raises 57014 — which would make the only remedy for a bad key unusable.
    let ledgerRowsDeleted = 0;
    for (;;) {
      const r = await this.pg.query(
        `DELETE FROM stock_ledger WHERE ctid IN (
           SELECT ctid FROM stock_ledger WHERE game_id=$1 AND stock_key=$2 LIMIT 5000
         )`,
        [gameId, stockKey],
      );
      ledgerRowsDeleted += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < 5000) break;
    }
    await this.cacheDrop(gameId, stockKey);
    stockOperations.labels('purge', 'ok').inc();
    void actorId; // the row is gone; there is no ledger left to attribute it in
    return { gameId, stockKey, ledgerRowsDeleted, severedSerials: severed };
  }

  /** A panel mutation's ledger row — same table, same audit trail as the game's writes. */
  private async ledger(
    c: PoolClient,
    gameId: string,
    stockKey: string,
    eventId: string,
    op: string,
    requested: number | null,
    applied: number,
    newValue: number,
    actorId: string,
  ): Promise<void> {
    await c.query(
      `INSERT INTO stock_ledger (event_id, game_id, stock_key, op, requested, applied, new_value, api_key_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (game_id, stock_key, event_id) DO NOTHING`,
      [eventId, gameId, stockKey, op, requested, applied, newValue, actorId],
    );
  }

  /** Drop the read cache after a control-plane change so the data plane sees it promptly. */
  private async cacheDrop(gameId: string, stockKey: string): Promise<void> {
    if (this.cacheTtl <= 0) return;
    try {
      await this.redis.del(this.cacheKey(gameId, stockKey));
    } catch {
      /* fail-open: the entry expires on its own within READ_CACHE_TTL_SECONDS */
    }
  }

  // ---------------------------------------------------------------- pure read
  async read(
    gameId: string,
    stockKey: string,
  ): Promise<{ gameId: string; stockKey: string; stock: number; max: number }> {
    const cached = await this.cacheGet(gameId, stockKey);
    if (cached) return { gameId, stockKey, stock: cached.stock, max: cached.max };
    // A pure read: a deleted key simply looks absent. No 409 here — GET makes no claim about
    // creating anything, so there is no retry loop to warn the caller out of.
    const r = await this.pg.query(
      `SELECT current_stock, max_stock FROM stock WHERE game_id=$1 AND stock_key=$2 AND deleted_at IS NULL`,
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
    // A deleted key lands in `missing`, which is the only answer this shape can give: the
    // response has no per-key error slot.
    const r = await this.pg.query(
      `SELECT stock_key, current_stock, max_stock FROM stock
       WHERE game_id=$1 AND stock_key = ANY($2) AND deleted_at IS NULL`,
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

  /**
   * List every stock key registered for a game (paginated). `total` is the full count.
   *
   * `includeDeleted` is the panel's view; the game-facing route never passes it. `linkedSerials`
   * comes along on every row so the panel can warn before a delete without a second endpoint —
   * a serial linked to a stock stops being able to issue the moment that stock goes.
   */
  async list(
    gameId: string,
    limit: number,
    offset: number,
    includeDeleted = false,
  ): Promise<{ items: StockListItem[]; total: number }> {
    const r = await this.pg.query(
      `SELECT s.stock_key, s.current_stock, s.max_stock, s.deleted_at,
              COALESCE(ser.keys, '{}') AS linked_serials,
              COUNT(*) OVER() AS total
       FROM stock s
       LEFT JOIN LATERAL (
         SELECT array_agg(x.serial_key ORDER BY x.serial_key) AS keys
         FROM serial x
         WHERE x.game_id = s.game_id AND x.stock_key = s.stock_key AND x.deleted_at IS NULL
       ) ser ON true
       WHERE s.game_id=$1 AND ($4::boolean OR s.deleted_at IS NULL)
       ORDER BY s.stock_key LIMIT $2 OFFSET $3`,
      [gameId, limit, offset, includeDeleted],
    );
    const total = r.rowCount && r.rowCount > 0 ? Number(r.rows[0].total) : 0;
    const items = r.rows.map((row): StockListItem => ({
      stockKey: row.stock_key,
      stock: Number(row.current_stock),
      max: Number(row.max_stock),
      linkedSerials: (row.linked_serials as string[]) ?? [],
      deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
    }));
    return { items, total };
  }
}
