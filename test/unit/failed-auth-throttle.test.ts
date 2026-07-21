import { describe, it, expect } from 'vitest';
import { FailedAuthThrottle } from '../../src/core/auth/failed-auth-throttle';

/**
 * This is the bound on the pre-auth pool-exhaustion vector: without it, a flood of well-formed but
 * nonexistent gk_ keys hits Postgres once per request (a miss is never cached) before the rate
 * limiter runs. The throttle refuses an IP that has spent its failure budget BEFORE the DB query.
 */
describe('FailedAuthThrottle', () => {
  // A controllable clock so the window logic is tested without real time.
  const at = (t: { v: number }) => () => t.v;

  it('allows up to the limit, then blocks', () => {
    const clock = { v: 1000 };
    const th = new FailedAuthThrottle(3, 60_000, 50_000, at(clock));
    expect(th.blocked('1.2.3.4')).toBe(false);
    for (let i = 0; i < 3; i++) th.fail('1.2.3.4'); // count reaches the limit, not over
    expect(th.blocked('1.2.3.4')).toBe(false);
    th.fail('1.2.3.4'); // now over
    expect(th.blocked('1.2.3.4')).toBe(true);
    expect(th.retryAfter('1.2.3.4')).toBeGreaterThan(0);
  });

  it('is per-IP: one attacker cannot block another client', () => {
    const clock = { v: 0 };
    const th = new FailedAuthThrottle(2, 60_000, 50_000, at(clock));
    for (let i = 0; i < 5; i++) th.fail('9.9.9.9');
    expect(th.blocked('9.9.9.9')).toBe(true);
    expect(th.blocked('1.1.1.1')).toBe(false); // a real game server on another IP is unaffected
  });

  it('rolls over when the window elapses', () => {
    const clock = { v: 0 };
    const th = new FailedAuthThrottle(1, 60_000, 50_000, at(clock));
    th.fail('5.5.5.5');
    th.fail('5.5.5.5');
    expect(th.blocked('5.5.5.5')).toBe(true);
    clock.v = 60_000; // window has elapsed exactly
    expect(th.blocked('5.5.5.5')).toBe(false);
    expect(th.retryAfter('5.5.5.5')).toBe(0);
  });

  it('a valid key clears the IP so a rotated-key blip does not accrue', () => {
    const clock = { v: 0 };
    const th = new FailedAuthThrottle(2, 60_000, 50_000, at(clock));
    th.fail('7.7.7.7');
    th.fail('7.7.7.7');
    th.fail('7.7.7.7');
    expect(th.blocked('7.7.7.7')).toBe(true);
    th.succeed('7.7.7.7'); // the next request presented a valid key
    expect(th.blocked('7.7.7.7')).toBe(false);
  });

  it('bounds memory: the map cannot grow past maxTracked', () => {
    const clock = { v: 0 };
    const th = new FailedAuthThrottle(1, 60_000, 3, at(clock)) as unknown as {
      fail: (ip: string) => void;
      hits: Map<string, unknown>;
    };
    for (let i = 0; i < 100; i++) th.fail(`10.0.0.${i}`);
    expect(th.hits.size).toBeLessThanOrEqual(3);
  });
});
