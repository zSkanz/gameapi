import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { Errors } from '../errors/app-error';
import type { PanelRole, PanelSession } from './principal';

/** What actually lives in Redis. The raw cookie value is never stored — only its digest. */
interface StoredSession {
  userId: string;
  username: string;
  role: PanelRole;
  mustChangePassword: boolean;
  /** The user's revocation generation at login. A mismatch invalidates instantly. */
  gen: number;
  /** Absolute expiry (epoch ms). Never extended, however active the session is. */
  absExp: number;
}

const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Panel sessions, in Redis only — no table, no JWT.
 *
 * Two design points carry their weight:
 *
 * 1. The key is `sha256(rawId)`, not rawId. A Redis dump, a MONITOR, or an errant log then
 *    yields digests rather than usable cookies.
 *
 * 2. Revocation is a per-user generation counter (`INCR` = revoke every session, O(1)), not a
 *    SET of that user's session digests. The SET version has to carry a TTL, and once it
 *    expires a "log everyone out" silently misses live sessions; it also leaks digests
 *    forever and loses a role-demotion race (a login in flight writes its session AFTER the
 *    demotion has already walked the set). The counter closes all three: a login racing a
 *    demotion stores gen=5, the demotion INCRs to 6, and every later resolve sees 6 != 5.
 */
export class PanelSessions {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly idleSeconds: number,
    private readonly absoluteSeconds: number,
  ) {}

  private key(rawId: string): string {
    return `${this.prefix}psess:${sha256hex(rawId)}`;
  }
  private genKey(userId: string): string {
    return `${this.prefix}psess:gen:${userId}`;
  }

  /**
   * Redis being unreachable must not read as "not signed in": a 401 would bounce a valid
   * operator to the login screen where they cannot succeed either. 503 says retry.
   * Translated here because the error handler classifies on `.code`, and an ioredis rejection
   * with enableOfflineQueue:false carries none.
   */
  private fail(err: unknown): never {
    throw Errors.unavailable('The session store is temporarily unavailable.', 1, err);
  }

  /** Mint a session. Returns the raw cookie value — the only time it exists. */
  async create(user: Omit<PanelSession, never>): Promise<string> {
    const rawId = randomBytes(32).toString('base64url');
    const absExp = Date.now() + this.absoluteSeconds * 1000;
    try {
      const gen = Number((await this.redis.get(this.genKey(user.userId))) ?? 0);
      const stored: StoredSession = {
        userId: user.userId,
        username: user.username,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
        gen,
        absExp,
      };
      await this.redis.set(this.key(rawId), JSON.stringify(stored), 'EX', this.idleSeconds);
      return rawId;
    } catch (err) {
      this.fail(err);
    }
  }

  async resolve(rawId: string): Promise<PanelSession | null> {
    let raw: string | null;
    try {
      raw = await this.redis.get(this.key(rawId));
    } catch (err) {
      this.fail(err);
    }
    if (!raw) return null;

    let s: StoredSession;
    try {
      s = JSON.parse(raw) as StoredSession;
    } catch {
      return null; // unparseable value: treat as no session
    }

    const now = Date.now();
    if (!s.absExp || now >= s.absExp) {
      await this.redis.del(this.key(rawId)).catch(() => {});
      return null;
    }

    try {
      const gen = Number((await this.redis.get(this.genKey(s.userId))) ?? 0);
      if (gen !== s.gen) return null; // password change, role change, or explicit revoke

      // Slide the idle window, but never past the absolute deadline. The remainder is > 0ms
      // because now < absExp above, so Math.ceil is >= 1 — an EXPIRE 0 here would delete the
      // key while this call still answered "valid".
      const ttl = Math.min(this.idleSeconds, Math.ceil((s.absExp - now) / 1000));
      await this.redis.expire(this.key(rawId), ttl);
    } catch (err) {
      this.fail(err);
    }

    return {
      userId: s.userId,
      username: s.username,
      role: s.role,
      mustChangePassword: s.mustChangePassword,
    };
  }

  async destroy(rawId: string): Promise<void> {
    try {
      await this.redis.del(this.key(rawId));
    } catch {
      /* logout is best-effort: the session still expires on its own */
    }
  }

  /** Revoke every session for a user, now. O(1), and it cannot miss one. */
  async revokeAll(userId: string): Promise<void> {
    try {
      await this.redis.incr(this.genKey(userId));
    } catch (err) {
      this.fail(err);
    }
  }
}
