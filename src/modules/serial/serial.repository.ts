import type { Pool, PoolClient } from 'pg';
import { Errors } from '../../core/errors/app-error';
import { MAX_SERIAL } from '../../core/constants';

export interface SerialState {
  gameId: string;
  serialKey: string;
  start: number;
  next: number; // next number to be issued
  max: number | null;
  stockKey: string | null;
  issued: number; // how many have been issued (next - start)
  remaining: number | null; // future issues still possible (null = unbounded)
  created?: boolean;
}

export interface IssueResult {
  gameId: string;
  serialKey: string;
  serial: number; // the number handed out
  remaining: number | null;
  replayed: boolean;
}

export interface SerialListItem {
  serialKey: string;
  start: number;
  next: number;
  max: number | null;
  stockKey: string | null;
  issued: number;
  remaining: number | null;
}

/** Future issues still possible, given a max cap and/or a linked stock's current value. */
function computeRemaining(max: number | null, next: number, stockCurrent: number | null): number | null {
  let r: number | null = null;
  if (max !== null) r = Math.max(0, max - next + 1);
  if (stockCurrent !== null) r = r === null ? stockCurrent : Math.min(r, stockCurrent);
  return r;
}

/** Effective linked-stock value for `remaining`. A set stock_key whose LEFT JOIN came back
 *  NULL means the linked stock row is missing -> treat as 0, so read()/list() agree with
 *  issue() (which 409s). An existing stock row always has a non-null current_stock. */
function effectiveStock(stockKey: string | null, stockCurrentRaw: unknown): number | null {
  if (stockCurrentRaw != null) return Number(stockCurrentRaw);
  return stockKey != null ? 0 : null;
}

type Exec = Pool | PoolClient;

/**
 * The only layer that touches Postgres for serials. Issuing is atomic and exactly-once:
 * the serial row is locked FOR UPDATE, the ledger UNIQUE(game_id,serial_key,event_id)
 * makes a retried issue replay the same number, and a linked stock is decremented in the
 * same transaction (so "issue a number" and "consume a unit" can never diverge).
 */
export class SerialRepository {
  constructor(
    private readonly pg: Pool,
    private readonly autoProvision: boolean,
  ) {}

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pg.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  private async readState(exec: Exec, gameId: string, serialKey: string): Promise<SerialState | null> {
    const r = await exec.query(
      `SELECT s.start_num, s.next_num, s.max_num, s.stock_key, st.current_stock AS stock_current
       FROM serial s
       LEFT JOIN stock st ON st.game_id = s.game_id AND st.stock_key = s.stock_key
       WHERE s.game_id=$1 AND s.serial_key=$2`,
      [gameId, serialKey],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    const start = Number(row.start_num);
    const next = Number(row.next_num);
    const max = row.max_num == null ? null : Number(row.max_num);
    const stockCurrent = effectiveStock(row.stock_key, row.stock_current);
    return {
      gameId,
      serialKey,
      start,
      next,
      max,
      stockKey: row.stock_key ?? null,
      issued: next - start,
      remaining: computeRemaining(max, next, stockCurrent),
    };
  }

  // ---------------------------------------------------------------- get-or-create
  async getOrCreate(
    gameId: string,
    serialKey: string,
    opts: { start: number; max: number | null; stockKey: string | null },
    keyId: string,
  ): Promise<SerialState> {
    const created = await this.tx(async (c) => {
      if (this.autoProvision) {
        await c.query(`INSERT INTO game (game_id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [gameId]);
      }
      const ins = await c.query(
        `INSERT INTO serial (game_id, serial_key, start_num, next_num, max_num, stock_key, created_by)
         VALUES ($1, $2, $3, $3, $4, $5, $6)
         ON CONFLICT (game_id, serial_key) DO NOTHING
         RETURNING serial_key`,
        [gameId, serialKey, opts.start, opts.max, opts.stockKey, keyId],
      );
      return (ins.rowCount ?? 0) > 0;
    });
    const state = await this.readState(this.pg, gameId, serialKey);
    return { ...state!, created };
  }

  // ---------------------------------------------------------------- issue
  async issue(gameId: string, serialKey: string, eventId: string, keyId: string): Promise<IssueResult> {
    return this.tx(async (c) => {
      // 1) idempotency claim (rolled back if the issue can't be fulfilled)
      const claim = await c.query(
        `INSERT INTO serial_ledger (event_id, game_id, serial_key, issued, api_key_id)
         VALUES ($1, $2, $3, 0, $4)
         ON CONFLICT (game_id, serial_key, event_id) DO NOTHING
         RETURNING id`,
        [eventId, gameId, serialKey, keyId],
      );
      if ((claim.rowCount ?? 0) === 0) {
        const prev = await c.query(
          `SELECT issued FROM serial_ledger WHERE game_id=$1 AND serial_key=$2 AND event_id=$3`,
          [gameId, serialKey, eventId],
        );
        const issued = Number(prev.rows[0].issued);
        const state = await this.readState(c, gameId, serialKey);
        return { gameId, serialKey, serial: issued, remaining: state ? state.remaining : null, replayed: true };
      }

      // 2) lock the serial and check the caps
      const s = await c.query(
        `SELECT next_num, max_num, stock_key FROM serial WHERE game_id=$1 AND serial_key=$2 FOR UPDATE`,
        [gameId, serialKey],
      );
      if (s.rowCount === 0) throw Errors.serialNotFound(gameId, serialKey);
      const next = Number(s.rows[0].next_num);
      const max = s.rows[0].max_num == null ? null : Number(s.rows[0].max_num);
      const stockKey = (s.rows[0].stock_key ?? null) as string | null;

      // Hard cap even for "infinite" serials so an issued number never exceeds 2^53-1,
      // where Number(bigint) would round and start handing out duplicates.
      const ceiling = max !== null ? max : MAX_SERIAL;
      if (next > ceiling) {
        throw Errors.serialExhausted(gameId, serialKey, max !== null ? 'max reached' : 'serial space exhausted');
      }

      // 3) if linked to a stock, decrement it atomically (0 or missing -> exhausted)
      let stockAfter: number | null = null;
      if (stockKey) {
        const u = await c.query(
          `UPDATE stock SET current_stock = current_stock - 1, updated_at = now()
           WHERE game_id=$1 AND stock_key=$2 AND current_stock > 0
           RETURNING current_stock`,
          [gameId, stockKey],
        );
        if (u.rowCount === 0) throw Errors.serialExhausted(gameId, serialKey, 'linked stock depleted');
        stockAfter = Number(u.rows[0].current_stock);
      }

      // 4) issue the number, advance the counter, fill the ledger
      const issued = next;
      await c.query(`UPDATE serial SET next_num = next_num + 1, updated_at = now() WHERE game_id=$1 AND serial_key=$2`, [gameId, serialKey]);
      await c.query(`UPDATE serial_ledger SET issued=$4 WHERE game_id=$1 AND serial_key=$2 AND event_id=$3`, [gameId, serialKey, eventId, issued]);

      return { gameId, serialKey, serial: issued, remaining: computeRemaining(max, issued + 1, stockAfter), replayed: false };
    });
  }

  // ---------------------------------------------------------------- read state
  async read(gameId: string, serialKey: string): Promise<SerialState> {
    const state = await this.readState(this.pg, gameId, serialKey);
    if (!state) throw Errors.serialNotFound(gameId, serialKey);
    return state;
  }

  // ---------------------------------------------------------------- list
  async list(
    gameId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: SerialListItem[]; total: number }> {
    const r = await this.pg.query(
      `SELECT s.serial_key, s.start_num, s.next_num, s.max_num, s.stock_key,
              st.current_stock AS stock_current, COUNT(*) OVER() AS total
       FROM serial s
       LEFT JOIN stock st ON st.game_id = s.game_id AND st.stock_key = s.stock_key
       WHERE s.game_id=$1 ORDER BY s.serial_key LIMIT $2 OFFSET $3`,
      [gameId, limit, offset],
    );
    const total = r.rowCount && r.rowCount > 0 ? Number(r.rows[0].total) : 0;
    const items = r.rows.map((row): SerialListItem => {
      const start = Number(row.start_num);
      const next = Number(row.next_num);
      const max = row.max_num == null ? null : Number(row.max_num);
      const stockCurrent = effectiveStock(row.stock_key, row.stock_current);
      return {
        serialKey: row.serial_key,
        start,
        next,
        max,
        stockKey: row.stock_key ?? null,
        issued: next - start,
        remaining: computeRemaining(max, next, stockCurrent),
      };
    });
    return { items, total };
  }
}
