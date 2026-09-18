import { describe, it, expect } from 'vitest';
import { KEY_CONCURRENCY, QuerySemaphore, runKeyed } from '../../src/core/auth/query-semaphore';

/**
 * This gate is the real bound on the pre-auth pool-exhaustion vector. The point the first fix
 * missed: a concurrent burst must be capped BEFORE the queries run, not counted after they settle.
 * A global cap (not per-IP) so Roblox's NAT'd egress IPs don't collapse tenants into one bucket.
 */
describe('QuerySemaphore', () => {
  // A controllable async task: resolves only when we call its release().
  function gate() {
    let release!: () => void;
    const started = { yes: false };
    const p = new Promise<void>((r) => (release = r));
    return {
      fn: async () => {
        started.yes = true;
        await p;
        return 'ok';
      },
      release,
      started,
    };
  }

  it('runs up to `max` concurrently and no more', async () => {
    const sem = new QuerySemaphore(2, 10);
    const a = gate();
    const b = gate();
    const c = gate();
    const pa = sem.run(a.fn);
    const pb = sem.run(b.fn);
    const pc = sem.run(c.fn);
    await Promise.resolve(); // let the synchronous prefixes run
    await Promise.resolve();
    // a and b hold the two slots; c must be waiting, its fn not yet started.
    expect(sem.stats.active).toBe(2);
    expect(c.started.yes).toBe(false);
    expect(sem.stats.queued).toBe(1);
    a.release();
    await pa;
    await Promise.resolve();
    // freeing a slot admits c.
    expect(c.started.yes).toBe(true);
    b.release();
    c.release();
    await Promise.all([pb, pc]);
    expect(sem.stats).toEqual({ active: 0, queued: 0 });
  });

  it('rejects instead of queueing without bound once the wait queue is full', async () => {
    const sem = new QuerySemaphore(1, 1); // 1 running + at most 1 waiting
    const a = gate();
    const b = gate();
    const pa = sem.run(a.fn); // takes the slot
    const pb = sem.run(b.fn); // queued (1 waiter)
    await Promise.resolve();
    // The third has nowhere to wait — it must reject rather than grow memory.
    await expect(sem.run(async () => 'nope')).rejects.toThrow(/concurrency limit/);
    a.release();
    await pa;
    b.release();
    await pb;
  });

  it('a slow/blocked run never lets active exceed max', async () => {
    const sem = new QuerySemaphore(3, 100);
    const gates = Array.from({ length: 20 }, gate);
    const runs = gates.map((g) => sem.run(g.fn).catch(() => 'rejected'));
    await Promise.resolve();
    await Promise.resolve();
    expect(sem.stats.active).toBeLessThanOrEqual(3);
    gates.forEach((g) => g.release());
    await Promise.all(runs);
  });

  it('never admits beyond max even as slots are handed off under churn', async () => {
    const sem = new QuerySemaphore(3, 1000);
    let peak = 0;
    const seen: number[] = [];
    // Each task records the live `active` while it holds a slot. If the hand-off ever double-counted
    // (the decrement-then-re-increment race), some task would observe active > max here.
    const task = () =>
      sem.run(async () => {
        seen.push(sem.stats.active);
        peak = Math.max(peak, sem.stats.active);
        await Promise.resolve();
        await Promise.resolve();
        return 1;
      });
    await Promise.all(Array.from({ length: 50 }, task));
    expect(peak).toBeLessThanOrEqual(3);
    expect(Math.max(...seen)).toBeLessThanOrEqual(3);
    expect(sem.stats).toEqual({ active: 0, queued: 0 });
  });

  it('propagates the task result and releases the slot on throw', async () => {
    const sem = new QuerySemaphore(1, 10);
    await expect(sem.run(async () => 42)).resolves.toBe(42);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // Slot was freed by the finally even though the task threw.
    expect(sem.stats.active).toBe(0);
    await expect(sem.run(async () => 'after')).resolves.toBe('after');
  });
});

describe('runKeyed', () => {
  it('runs at most KEY_CONCURRENCY at once per key, and never blocks another key', async () => {
    const gates = new Map<string, QuerySemaphore>();
    let running = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const job = () =>
      runKeyed(gates, 'hot', async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>((r) => releases.push(r));
        running--;
      });
    const jobs = Array.from({ length: 6 }, job);
    await Promise.resolve();
    expect(peak).toBe(KEY_CONCURRENCY);
    expect(await runKeyed(gates, 'other', async () => 'free')).toBe('free');
    while (releases.length > 0 || running > 0) {
      releases.shift()?.();
      await new Promise((r) => setImmediate(r));
    }
    await Promise.all(jobs);
    expect(peak).toBe(KEY_CONCURRENCY);
  });

  it('drops a key\'s gate once it is idle, so the map does not grow with every key ever seen', async () => {
    const gates = new Map<string, QuerySemaphore>();
    await runKeyed(gates, 'a', async () => 1);
    await expect(runKeyed(gates, 'b', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(gates.size).toBe(0);
  });

  it('answers a full queue with a retryable 503', async () => {
    const gates = new Map<string, QuerySemaphore>();
    const never = new Promise<void>(() => {});
    for (let i = 0; i < 500; i++) void runKeyed(gates, 'hot', () => never).catch(() => {});
    await expect(runKeyed(gates, 'hot', async () => 1)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
