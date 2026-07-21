import { describe, it, expect } from 'vitest';
import { QuerySemaphore } from '../../src/core/auth/query-semaphore';

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

  it('propagates the task result and releases the slot on throw', async () => {
    const sem = new QuerySemaphore(1, 10);
    await expect(sem.run(async () => 42)).resolves.toBe(42);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // Slot was freed by the finally even though the task threw.
    expect(sem.stats.active).toBe(0);
    await expect(sem.run(async () => 'after')).resolves.toBe('after');
  });
});
