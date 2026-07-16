import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { PanelRole } from '../../core/auth/principal';
import { Errors } from '../../core/errors/app-error';
import { hashPassword } from '../../core/auth/password';

export interface PanelUserRow {
  userId: string;
  username: string;
  role: PanelRole;
  mustChangePassword: boolean;
  disabledAt: string | null;
  passwordChangedAt: string;
  createdAt: string;
  createdBy: string | null;
}

/** Includes the hash — for the login path only. Never leaves this module. */
interface AuthRow extends PanelUserRow {
  passwordHash: string;
}

const newUserId = (): string => `pu_${randomBytes(8).toString('hex')}`;

const map = (row: Record<string, unknown>): PanelUserRow => ({
  userId: row.user_id as string,
  username: row.username as string,
  role: row.role as PanelRole,
  mustChangePassword: row.must_change_password as boolean,
  disabledAt: row.disabled_at ? (row.disabled_at as Date).toISOString() : null,
  passwordChangedAt: (row.password_changed_at as Date).toISOString(),
  createdAt: (row.created_at as Date).toISOString(),
  createdBy: (row.created_by as string | null) ?? null,
});

const COLS = `user_id, username, role, must_change_password, disabled_at, password_changed_at, created_at, created_by`;

/** Panel accounts. Direct pg, like every other repository here. */
export class PanelRepository {
  constructor(private readonly pg: Pool) {}

  /** Login lookup. Case-insensitive to match the lower(username) unique index. */
  async findForAuth(username: string): Promise<AuthRow | null> {
    const r = await this.pg.query(`SELECT ${COLS}, password_hash FROM panel_user WHERE lower(username) = lower($1)`, [
      username,
    ]);
    const row = r.rows[0];
    if (!row) return null;
    return { ...map(row), passwordHash: row.password_hash as string };
  }

  async findById(userId: string): Promise<PanelUserRow | null> {
    const r = await this.pg.query(`SELECT ${COLS} FROM panel_user WHERE user_id = $1`, [userId]);
    return r.rows[0] ? map(r.rows[0]) : null;
  }

  async list(): Promise<PanelUserRow[]> {
    const r = await this.pg.query(`SELECT ${COLS} FROM panel_user ORDER BY created_at`);
    return r.rows.map(map);
  }

  async countOwners(): Promise<number> {
    const r = await this.pg.query(`SELECT COUNT(*)::int AS n FROM panel_user WHERE role='owner' AND disabled_at IS NULL`);
    return (r.rows[0]?.n as number) ?? 0;
  }

  /** Create an account with a caller-supplied password. Returns the row; never the hash. */
  async create(
    username: string,
    password: string,
    role: PanelRole,
    createdBy: string | null,
  ): Promise<PanelUserRow> {
    const hash = await hashPassword(password);
    try {
      const r = await this.pg.query(
        `INSERT INTO panel_user (user_id, username, role, password_hash, must_change_password, created_by)
         VALUES ($1, $2, $3, $4, true, $5)
         RETURNING ${COLS}`,
        [newUserId(), username, role, hash, createdBy],
      );
      return map(r.rows[0]);
    } catch (err) {
      // 23505 is the lower(username) unique index. Mapped here rather than left to the error
      // handler so the message names the field a human can actually fix.
      if ((err as { code?: string }).code === '23505') {
        throw Errors.conflict('That username is already taken.', { username });
      }
      throw err;
    }
  }

  /**
   * Set a password. Returns the fresh row so the caller mints its session from what the
   * database now holds — reusing the row read before the UPDATE would carry the old
   * must_change_password=true forward and trap every account in a change-password loop.
   */
  async setPassword(userId: string, password: string): Promise<PanelUserRow> {
    const hash = await hashPassword(password);
    const r = await this.pg.query(
      `UPDATE panel_user
       SET password_hash = $2, must_change_password = false, password_changed_at = now()
       WHERE user_id = $1
       RETURNING ${COLS}`,
      [userId, hash],
    );
    if (r.rowCount === 0) throw Errors.notFound('Account not found.');
    return map(r.rows[0]);
  }

  /** Owner-initiated reset: the target must change it again at next login. */
  async resetPassword(userId: string, password: string): Promise<PanelUserRow> {
    const hash = await hashPassword(password);
    const r = await this.pg.query(
      `UPDATE panel_user
       SET password_hash = $2, must_change_password = true, password_changed_at = now()
       WHERE user_id = $1
       RETURNING ${COLS}`,
      [userId, hash],
    );
    if (r.rowCount === 0) throw Errors.notFound('Account not found.');
    return map(r.rows[0]);
  }

  /**
   * Change role and/or enabled state, refusing to leave the panel with no owner.
   *
   * The guard locks the surviving owner rows FOR UPDATE inside the transaction. A COUNT(*)
   * outside one loses the obvious race: two concurrent demotions each see two owners, each
   * decides it is safe, and the panel ends up unreachable with no way back in.
   */
  async update(userId: string, patch: { role?: PanelRole; disabled?: boolean }): Promise<PanelUserRow> {
    const client: PoolClient = await this.pg.connect();
    try {
      await client.query('BEGIN');

      const cur = await client.query(`SELECT role, disabled_at FROM panel_user WHERE user_id=$1 FOR UPDATE`, [userId]);
      if (cur.rowCount === 0) throw Errors.notFound('Account not found.');
      const wasOwner = cur.rows[0].role === 'owner' && cur.rows[0].disabled_at === null;

      const losesOwnership = wasOwner && (patch.role === 'admin' || patch.disabled === true);
      if (losesOwnership) {
        const others = await client.query(
          `SELECT user_id FROM panel_user
           WHERE role='owner' AND disabled_at IS NULL AND user_id <> $1 FOR UPDATE`,
          [userId],
        );
        if (others.rowCount === 0) {
          throw Errors.conflict('This is the last owner. Promote another account to owner first.', { userId });
        }
      }

      const r = await client.query(
        `UPDATE panel_user SET
           role        = COALESCE($2, role),
           disabled_at = CASE WHEN $3::boolean IS NULL THEN disabled_at
                              WHEN $3::boolean THEN COALESCE(disabled_at, now())
                              ELSE NULL END
         WHERE user_id = $1
         RETURNING ${COLS}`,
        [userId, patch.role ?? null, patch.disabled ?? null],
      );
      await client.query('COMMIT');
      return map(r.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
