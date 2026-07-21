/**
 * A bounded concurrency gate for the uncached api-key lookup.
 *
 * The problem it solves: the auth hook runs before the rate limiter and a key MISS is never
 * cached, so a flood of well-formed but nonexistent gk_ keys — each a distinct keyId — issues one
 * Postgres query apiece with nothing merging them. On a pool of PG_POOL_MAX they saturate the pool
 * that every game handler shares, and legitimate traffic times out.
 *
 * Why a GLOBAL semaphore and not a per-IP limiter: game traffic arrives from Roblox's HttpService
 * egress IPs, which are NAT'd across many unrelated games — req.ip is NOT per-tenant. Any per-IP
 * failure counter therefore lets one game's revoked-key retries (or 31 cheap requests) lock out
 * every co-located tenant behind that IP. A global cap on how many auth queries run at once has no
 * per-tenant dimension to get wrong: it simply guarantees auth can never hold more than `max` pool
 * connections, so game handlers always have the rest. Valid keys resolve from the in-process cache
 * and never enter this gate, so normal traffic is unaffected no matter how bursty.
 *
 * When both the running slots AND the wait queue are full, run() rejects rather than growing
 * unbounded — the caller (DbApiKeyStore.resolve) turns that into a retryable 503, the same as any
 * other lookup failure. That bounds memory under a sustained flood.
 */
export class QuerySemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    /** Max concurrent runs. Keep below the pool size so game handlers always have connections. */
    private readonly max: number,
    /** Max queued waiters before run() rejects instead of waiting. Bounds memory under a flood. */
    private readonly maxQueue: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.max) {
      // A slot is free — take it now.
      this.active++;
    } else if (this.waiters.length < this.maxQueue) {
      // Full: wait for a slot to be HANDED to us. When our resolver fires, the releasing run() has
      // already accounted the slot to us — we do NOT increment, or the count would double.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      throw new Error('auth lookup concurrency limit reached');
    }
    try {
      return await fn();
    } finally {
      // Hand off WITHOUT dropping the count when someone is waiting: decrement-then-let-the-waiter-
      // re-increment straddles a microtask, and a run() that checks `active` in that gap would see a
      // stale-low value and over-admit past `max`. Transferring the slot keeps `active` constant, so
      // the invariant holds with no window.
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }

  /** Test/introspection only. */
  get stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiters.length };
  }
}
