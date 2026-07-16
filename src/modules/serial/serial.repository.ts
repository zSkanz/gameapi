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
  /** Always null on the game-facing list, which never asks for deleted rows. */
  deletedAt: string | null;
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
      // st.deleted_at goes in the ON clause, NOT the WHERE: in the WHERE it silently turns
      // this LEFT JOIN into an INNER JOIN and every unlinked ("infinite") serial disappears.
      // In the ON clause a deleted linked stock just yields NULL, which effectiveStock() maps
      // to 0 — so read() agrees with issue(), which refuses.
      `SELECT s.start_num, s.next_num, s.max_num, s.stock_key, st.current_stock AS stock_current
       FROM serial s
       LEFT JOIN stock st
         ON st.game_id = s.game_id AND st.stock_key = s.stock_key AND st.deleted_at IS NULL
       WHERE s.game_id=$1 AND s.serial_key=$2 AND s.deleted_at IS NULL`,
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
    return this.tx(async (c) => {
      if (this.autoProvision) {
        await c.query(`INSERT INTO game (game_id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [gameId]);
      }
      // Same rule as stock: get-or-create creates. A soft-deleted row keeps the primary-key
      // slot, so DO NOTHING would report "exists" for an issuer the caller cannot see. The
      // guarded DO UPDATE re-creates over a tombstone — counter back to start_num, a genuinely
      // new incarnation — while a LIVE row blocks the update and is returned untouched.
      const ins = await c.query(
        `INSERT INTO serial (game_id, serial_key, start_num, next_num, max_num, stock_key, created_by)
         VALUES ($1, $2, $3, $3, $4, $5, $6)
         ON CONFLICT (game_id, serial_key) DO UPDATE
           SET start_num  = EXCLUDED.start_num,
               next_num   = EXCLUDED.start_num,
               max_num    = EXCLUDED.max_num,
               stock_key  = EXCLUDED.stock_key,
               created_by = EXCLUDED.created_by,
               created_at = now(),
               updated_at = now(),
               deleted_at = NULL,
               deleted_by = NULL
           WHERE serial.deleted_at IS NOT NULL
         RETURNING serial_key`,
        [gameId, serialKey, opts.start, opts.max, opts.stockKey, keyId],
      );
      const created = (ins.rowCount ?? 0) > 0;

      // Read inside the transaction, on the same connection. Reading it afterwards on the pool
      // took a second connection and raced anything that ran after the COMMIT — a concurrent
      // delete could make this null, and the `{...state!}` spread then answered 200 with every
      // field undefined instead of failing.
      const state = await this.readState(c, gameId, serialKey);
      if (!state) throw Errors.serialNotFound(gameId, serialKey);
      return { ...state, created };
    });
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
        `SELECT next_num, max_num, stock_key FROM serial
         WHERE game_id=$1 AND serial_key=$2 AND deleted_at IS NULL FOR UPDATE`,
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
        // This is a SECOND write path into `stock`, outside StockRepository — so it needs the
        // deleted_at filter too. Without it a soft-deleted stock keeps being drained by every
        // issue, which is exactly the state the deletion was meant to stop.
        const u = await c.query(
          `UPDATE stock SET current_stock = current_stock - 1, updated_at = now()
           WHERE game_id=$1 AND stock_key=$2 AND current_stock > 0 AND deleted_at IS NULL
           RETURNING current_stock`,
          [gameId, stockKey],
        );
        if (u.rowCount === 0) {
          // Three different states reach here and they are not the same answer: hardcoding
          // "depleted" tells an operator to top up a stock that is deleted or gone.
          const probe = await c.query(
            `SELECT current_stock, deleted_at FROM stock WHERE game_id=$1 AND stock_key=$2`,
            [gameId, stockKey],
          );
          const row = probe.rows[0];
          const reason = !row
            ? 'linked stock missing'
            : row.deleted_at
              ? 'linked stock deleted'
              : 'linked stock depleted';
          throw Errors.serialExhausted(gameId, serialKey, reason);
        }
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

  // ================================================================ panel (control plane)
  // Reached only through /v1/panel/* behind a session cookie. Same ledger, same audit trail
  // as the game's own writes, attributed with api_key_id='panel:<userId>'.

  /** Edit an issuer. `next` is never editable: moving it backwards re-issues a taken number. */
  async update(
    gameId: string,
    serialKey: string,
    patch: { max?: number | null; stockKey?: string | null },
    actorId: string,
  ): Promise<SerialState> {
    return this.tx(async (c) => {
      const cur = await c.query(
        `SELECT start_num, next_num FROM serial
         WHERE game_id=$1 AND serial_key=$2 AND deleted_at IS NULL FOR UPDATE`,
        [gameId, serialKey],
      );
      if (cur.rowCount === 0) throw Errors.serialNotFound(gameId, serialKey);
      const next = Number(cur.rows[0].next_num);

      if (patch.max !== undefined && patch.max !== null && patch.max < next - 1) {
        // Lowering max below what is already issued would make `remaining` negative and strand
        // the issuer in a state its own invariants say is impossible.
        throw Errors.conflict(`max cannot be below the ${next - 1} serials already issued.`, {
          gameId,
          serialKey,
          issued: next - 1,
        });
      }
      if (patch.stockKey !== undefined && patch.stockKey !== null) {
        const st = await c.query(
          `SELECT 1 FROM stock WHERE game_id=$1 AND stock_key=$2 AND deleted_at IS NULL`,
          [gameId, patch.stockKey],
        );
        if (st.rowCount === 0) {
          throw Errors.conflict('Cannot link to a stock key that does not exist or is deleted.', {
            gameId,
            stockKey: patch.stockKey,
          });
        }
      }

      await c.query(
        `UPDATE serial SET
           max_num  = CASE WHEN $3::boolean THEN $4::bigint ELSE max_num  END,
           stock_key = CASE WHEN $5::boolean THEN $6::text  ELSE stock_key END,
           updated_at = now()
         WHERE game_id=$1 AND serial_key=$2 AND deleted_at IS NULL`,
        [gameId, serialKey, patch.max !== undefined, patch.max ?? null, patch.stockKey !== undefined, patch.stockKey ?? null],
      );
      void actorId; // an edit changes no counter, so there is no ledger movement to record
      const state = await this.readState(c, gameId, serialKey);
      if (!state) throw Errors.serialNotFound(gameId, serialKey);
      return state;
    });
  }

  async softDelete(gameId: string, serialKey: string, actorId: string): Promise<SerialState> {
    return this.tx(async (c) => {
      const upd = await c.query(
        `UPDATE serial SET deleted_at = now(), deleted_by = $3, updated_at = now()
         WHERE game_id=$1 AND serial_key=$2 AND deleted_at IS NULL
         RETURNING start_num, next_num, max_num, stock_key`,
        [gameId, serialKey, actorId],
      );
      if (upd.rowCount === 0) throw Errors.serialNotFound(gameId, serialKey);
      const row = upd.rows[0];
      const start = Number(row.start_num);
      const next = Number(row.next_num);
      const max = row.max_num == null ? null : Number(row.max_num);
      return {
        gameId,
        serialKey,
        start,
        next,
        max,
        stockKey: row.stock_key ?? null,
        issued: next - start,
        remaining: 0, // deleted: nothing more can be issued
      };
    });
  }

  async restore(gameId: string, serialKey: string, actorId: string): Promise<SerialState> {
    return this.tx(async (c) => {
      const upd = await c.query(
        `UPDATE serial SET deleted_at = NULL, deleted_by = NULL, updated_at = now()
         WHERE game_id=$1 AND serial_key=$2 AND deleted_at IS NOT NULL
         RETURNING serial_key`,
        [gameId, serialKey],
      );
      if (upd.rowCount === 0) {
        const ex = await c.query(`SELECT 1 FROM serial WHERE game_id=$1 AND serial_key=$2`, [gameId, serialKey]);
        if (ex.rowCount === 0) throw Errors.serialNotFound(gameId, serialKey);
        throw Errors.conflict('That serial is not deleted.', { gameId, serialKey });
      }
      void actorId;
      const state = await this.readState(c, gameId, serialKey);
      if (!state) throw Errors.serialNotFound(gameId, serialKey);
      return state;
    });
  }

  /** Destroy an issuer and its history. Owner-only, irreversible, requires a prior delete. */
  async purge(gameId: string, serialKey: string): Promise<{ gameId: string; serialKey: string; ledgerRowsDeleted: number }> {
    const maxLedgerId = await this.tx(async (c) => {
      // High-water mark inside the tx — see StockRepository.purge. serial_ledger is what makes
      // issue() exactly-once, so an unbounded drain would let a re-created issuer hand out the
      // same number twice.
      const hw = await c.query(
        `SELECT COALESCE(max(id), 0) AS max_id FROM serial_ledger WHERE game_id=$1 AND serial_key=$2`,
        [gameId, serialKey],
      );
      const del = await c.query(
        `DELETE FROM serial WHERE game_id=$1 AND serial_key=$2 AND deleted_at IS NOT NULL RETURNING serial_key`,
        [gameId, serialKey],
      );
      if (del.rowCount === 0) {
        const ex = await c.query(`SELECT 1 FROM serial WHERE game_id=$1 AND serial_key=$2`, [gameId, serialKey]);
        if (ex.rowCount === 0) throw Errors.serialNotFound(gameId, serialKey);
        throw Errors.conflict('Delete the serial before purging it.', { gameId, serialKey });
      }
      return String(hw.rows[0].max_id);
    });
    // Batched for the same reason as the stock purge: statement_timeout is 5s, and an
    // unbounded delete on a heavily-issued serial raises 57014.
    let ledgerRowsDeleted = 0;
    for (;;) {
      const r = await this.pg.query(
        `DELETE FROM serial_ledger WHERE ctid IN (
           SELECT ctid FROM serial_ledger WHERE game_id=$1 AND serial_key=$2 AND id <= $3 LIMIT 5000
         )`,
        [gameId, serialKey, maxLedgerId],
      );
      ledgerRowsDeleted += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < 5000) break;
    }
    return { gameId, serialKey, ledgerRowsDeleted };
  }

  // ---------------------------------------------------------------- list
  async list(
    gameId: string,
    limit: number,
    offset: number,
    includeDeleted = false,
  ): Promise<{ items: SerialListItem[]; total: number }> {
    const r = await this.pg.query(
      // Same ON-clause rule as readState: `st.deleted_at IS NULL` in the WHERE would degrade
      // this LEFT JOIN to an INNER JOIN and drop every unlinked serial from the list.
      `SELECT s.serial_key, s.start_num, s.next_num, s.max_num, s.stock_key, s.deleted_at,
              st.current_stock AS stock_current, COUNT(*) OVER() AS total
       FROM serial s
       LEFT JOIN stock st
         ON st.game_id = s.game_id AND st.stock_key = s.stock_key AND st.deleted_at IS NULL
       WHERE s.game_id=$1 AND ($4::boolean OR s.deleted_at IS NULL)
       ORDER BY s.serial_key LIMIT $2 OFFSET $3`,
      [gameId, limit, offset, includeDeleted],
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
        deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
      };
    });
    return { items, total };
  }
}
