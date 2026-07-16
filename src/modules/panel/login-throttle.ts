import type { Redis } from 'ioredis';
import { AppError, Errors } from '../../core/errors/app-error';

/**
 * Fixed-window attempt counters for the panel's password endpoints.
 *
 * Counts ATTEMPTS at check time, not failures afterwards. A check-then-record split reads a
 * counter that is always stale: N concurrent logins all see 0, all pass, and all hash — which
 * is exactly the burst the throttle exists to stop.
 *
 * `INCR` then `EXPIRE ... NX` in one MULTI (Redis 7.0+; compose pins 7.4). NX is what keeps
 * the window fixed rather than sliding: refreshing the TTL on every attempt would let an
 * attacker hold a victim locked out forever. Doing it as `SET key 0 EX w NX` + `INCR` instead
 * can leave the key with NO TTL at all if the two land either side of an eviction — an
 * unrecoverable lockout that the break-glass CLI does not fix, because it resets passwords,
 * not buckets.
 */
export interface Bucket {
  key: string;
  limit: number;
}

export class AttemptThrottle {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly windowSeconds: number,
  ) {}

  /** Charge one attempt against each bucket. Throws 429 if any is over budget. */
  async charge(buckets: Bucket[]): Promise<void> {
    for (const b of buckets) {
      const full = `${this.prefix}${b.key}`;
      let count: number;
      try {
        const res = await this.redis.multi().incr(full).expire(full, this.windowSeconds, 'NX').exec();
        count = Number(res?.[0]?.[1] ?? 0);
      } catch (err) {
        // Fails CLOSED. The rate limiter on the game hot path fails open because dropping
        // real traffic is worse than letting some through; here the protected asset is a
        // password, and an unthrottled login is exactly what an attacker wants.
        throw Errors.unavailable('Sign-in is temporarily unavailable.', 2, err);
      }
      if (count > b.limit) {
        throw new AppError('PANEL_LOGIN_THROTTLED', 'Too many attempts. Try again later.', {
          retryAfter: this.windowSeconds,
        });
      }
    }
  }

  /** Clear a bucket after a success. */
  async clear(key: string): Promise<void> {
    try {
      await this.redis.del(`${this.prefix}${key}`);
    } catch {
      /* best-effort: the window expires on its own */
    }
  }
}

/** Per-IP and per-username buckets for login. */
export function loginBuckets(ip: string, username: string, maxPerIp: number, maxPerUser: number): Bucket[] {
  return [
    { key: `pl:ip:${ip}`, limit: maxPerIp },
    { key: `pl:u:${username.toLowerCase()}`, limit: maxPerUser },
  ];
}
