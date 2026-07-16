import { describe, it, expect } from 'vitest';
import { generateApiKey, parseApiKey, secretMatches } from '../../src/core/auth/key-format';

describe('api key format', () => {
  // The whole point of the dot separator. An underscore-delimited key split on its last '_'
  // lands inside the base64url payload ~48% of the time, and one hand-written test picks the
  // passing case half the time. Volume is the only thing that catches this class of bug.
  it('round-trips 10k generated keys through parse', () => {
    for (let i = 0; i < 10_000; i++) {
      const k = generateApiKey();
      const parsed = parseApiKey(k.fullKey);
      expect(parsed, `failed on ${k.fullKey}`).not.toBeNull();
      expect(parsed!.keyId).toBe(k.keyId);
      expect(parsed!.secret).toBe(k.secret);
    }
  });

  it('produces the documented shape', () => {
    const k = generateApiKey();
    expect(k.keyId).toMatch(/^gk_[A-Za-z0-9_-]{12}$/);
    expect(k.keyId).toHaveLength(15);
    expect(k.secret).toHaveLength(43);
    expect(k.fullKey).toBe(`${k.keyId}.${k.secret}`);
    expect(k.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates distinct keys', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateApiKey().keyId));
    expect(ids.size).toBe(1000);
  });

  it('verifies the right secret and rejects a wrong one', () => {
    const k = generateApiKey();
    expect(secretMatches(k.secret, k.secretHash)).toBe(true);
    expect(secretMatches(generateApiKey().secret, k.secretHash)).toBe(false);
  });

  // Buffer.from(<invalid hex>, 'hex') truncates instead of throwing, so an unguarded
  // timingSafeEqual would throw on the length mismatch rather than return false.
  it('returns false — never throws — on a corrupt stored hash', () => {
    const k = generateApiKey();
    for (const bad of ['', 'zz', 'abc', 'not-hex-at-all', k.secretHash.slice(0, 62)]) {
      expect(() => secretMatches(k.secret, bad)).not.toThrow();
      expect(secretMatches(k.secret, bad)).toBe(false);
    }
  });

  it('rejects malformed presented keys', () => {
    const k = generateApiKey();
    for (const bad of [
      '',
      'nodot',
      k.keyId, // no secret
      k.secret, // no key id
      `${k.keyId}.`,
      `.${k.secret}`,
      `${k.keyId}.${k.secret}x`, // secret too long
      `${k.keyId}.${k.secret.slice(0, 42)}`, // secret too short
      `xx_${k.keyId.slice(3)}.${k.secret}`, // wrong prefix
      `${k.keyId}.${k.secret}.${k.secret}`, // extra dot
      `${k.keyId}.${'+'.repeat(43)}`, // base64, not base64url
    ]) {
      expect(parseApiKey(bad), `should reject ${JSON.stringify(bad)}`).toBeNull();
    }
  });
});
