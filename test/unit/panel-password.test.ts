import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, needsRehash, generatePassword, equalizeLoginTiming } from '../../src/core/auth/password';

describe('panel password hashing', () => {
  it('round-trips', async () => {
    const pw = 'correct horse battery staple';
    const h = await hashPassword(pw);
    expect(await verifyPassword(pw, h)).toBe(true);
    expect(await verifyPassword('wrong horse battery staple', h)).toBe(false);
  });

  it('salts: the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  // Guards the verified footgun: N=32768,r=8,p=3 needs more than Node's DEFAULT maxmem, and it
  // throws SYNCHRONOUSLY out of the async function. Without the explicit maxmem every login 500s.
  it('hashes at the intended params without tripping maxmem', async () => {
    const h = await hashPassword('x'.repeat(12));
    expect(h).toMatch(/^scrypt\$N=32768,r=8,p=3\$/);
  });

  it('is self-describing so params can rise without a migration', async () => {
    const h = await hashPassword('a-password-here');
    expect(h.split('$')).toHaveLength(4);
    expect(needsRehash(h)).toBe(false);
    expect(needsRehash('scrypt$N=16384,r=8,p=1$c2FsdA$aGFzaA')).toBe(true); // weaker => rehash
  });

  // A corrupt row must reject the login, not 500 the endpoint.
  it('returns false — never throws — on a malformed stored hash', async () => {
    for (const bad of [
      '',
      'garbage',
      'bcrypt$x$y$z',
      'scrypt$N=0,r=8,p=3$c2FsdA$aGFzaA',
      'scrypt$N=32768,r=8,p=3$$',
      'scrypt$nonsense$c2FsdA$aGFzaA',
      'scrypt$N=32768,r=8,p=3$c2FsdA$dG9vLXNob3J0', // hash wrong length
    ]) {
      await expect(verifyPassword('any', bad), bad).resolves.toBe(false);
    }
  });

  it('generates a high-entropy password', () => {
    const p = generatePassword();
    expect(p).toHaveLength(24);
    expect(p).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(new Set(Array.from({ length: 200 }, generatePassword)).size).toBe(200);
  });

  // ~1ms vs ~123ms is a user-existence oracle. The dummy must cost the same as a real verify
  // on EVERY call, including the first — a lazily-built dummy costs double on its first use.
  it('equalizes unknown-user timing with a real verify, including the first call', async () => {
    const h = await hashPassword('a-real-password');
    const time = async (fn: () => Promise<unknown>): Promise<number> => {
      const t = process.hrtime.bigint();
      await fn();
      return Number(process.hrtime.bigint() - t) / 1e6;
    };
    const firstDummy = await time(() => equalizeLoginTiming());
    const real = await time(() => verifyPassword('wrong', h));
    const laterDummy = await time(() => equalizeLoginTiming());

    // Generous bound: this asserts "same order of work", not a stopwatch. A 2x lazy-build
    // regression blows straight through it; CI jitter does not.
    expect(firstDummy).toBeGreaterThan(real * 0.5);
    expect(firstDummy).toBeLessThan(real * 1.8);
    expect(laterDummy).toBeLessThan(real * 1.8);
  });
});
