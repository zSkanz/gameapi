/**
 * In-process, per-IP cap on FAILED api-key resolutions.
 *
 * The auth hook runs before the Redis rate limiter, and DbApiKeyStore deliberately never caches a
 * miss (a cached miss would be a remote cache-flush primitive), so every request carrying a
 * well-formed but nonexistent `gk_` key costs one Postgres round-trip on a pool of PG_POOL_MAX
 * with no admission control in front of it. A single host can saturate the pool that all tenants
 * share, timing legitimate Roblox traffic into 503s. This bounds that: once an IP exceeds its
 * failure budget for the window, further attempts are refused BEFORE the query runs.
 *
 * In-process on purpose. The pool it protects is per-process, so a local counter guards exactly
 * the resource at risk with zero Redis round-trip on the hot path — and it keeps working during a
 * Redis outage, unlike the panel login throttle. Per-instance counting is fine: each instance is
 * defending its own pool share, and behind the proxy `req.ip` is the real client (TRUST_PROXY).
 *
 * Fixed window, not a token bucket: the counter only has to bound DB queries per window, and a
 * window that resets wholesale is cheaper and has no starvation edge. A valid key clears the IP's
 * record, so a server that rotates a key and briefly 401s does not accrue toward the limit.
 */
export class FailedAuthThrottle {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    /** Hard cap on tracked IPs, so a distributed flood cannot grow the map without bound. */
    private readonly maxTracked = 50_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until this IP's window rolls over, or 0 if it is not currently blocked. */
  retryAfter(ip: string): number {
    const e = this.hits.get(ip);
    if (!e) return 0;
    const elapsed = this.now() - e.windowStart;
    if (elapsed >= this.windowMs || e.count <= this.limit) return 0;
    return Math.max(1, Math.ceil((this.windowMs - elapsed) / 1000));
  }

  /** True once this IP has spent its failure budget for the current window. */
  blocked(ip: string): boolean {
    return this.retryAfter(ip) > 0;
  }

  /** Record one failed resolution for this IP. */
  fail(ip: string): void {
    const t = this.now();
    const e = this.hits.get(ip);
    if (!e || t - e.windowStart >= this.windowMs) {
      // Overflow guard: clearing on the rare overflow briefly resets everyone's window, which is
      // acceptable when the alternative is unbounded growth and the window is measured in seconds.
      if (this.hits.size >= this.maxTracked) this.hits.clear();
      this.hits.set(ip, { count: 1, windowStart: t });
      return;
    }
    e.count++;
  }

  /** A valid key from this IP clears its failure record. */
  succeed(ip: string): void {
    if (this.hits.size > 0) this.hits.delete(ip);
  }
}
