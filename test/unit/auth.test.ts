import { describe, it, expect } from 'vitest';
import { EnvApiKeyStore } from '../../src/core/auth/env-store';
import { hasScope } from '../../src/core/auth/principal';

describe('EnvApiKeyStore', () => {
  const store = new EnvApiKeyStore(['primary_key_abcdefghijklmnop', 'secondary_key_qrstuvwxyz012345']);

  it('resolves a valid key to an all-games principal', async () => {
    const p = await store.resolve('primary_key_abcdefghijklmnop');
    expect(p).not.toBeNull();
    expect(p?.keyId).toBe('env:primary');
    expect(p?.allowedGameIds).toBe('*');
  });

  // The bootstrap key is cross-game, never cross-capability: hasScope() short-circuits on
  // '*', so a wildcard here would let the key in every Roblox script pass panel:owner.
  it('grants the game scopes only — never a wildcard, never panel:*', async () => {
    const p = await store.resolve('primary_key_abcdefghijklmnop');
    expect(p?.scopes).not.toBe('*');
    expect(p?.scopes).toEqual([
      'stock:read',
      'stock:write',
      'serial:read',
      'serial:write',
      'funnel:read',
      'funnel:write',
      'config:read',
      'games:read',
    ]);
    // Reading a live config yes; changing what every server of every game reads, no.
    expect(hasScope(p!, 'config:write')).toBe(false);
    expect(hasScope(p!, 'panel:owner')).toBe(false);
    expect(hasScope(p!, 'panel:read')).toBe(false);
    expect(hasScope(p!, 'stock:write')).toBe(true);
  });

  it('resolves a rotated (secondary) key', async () => {
    const p = await store.resolve('secondary_key_qrstuvwxyz012345');
    expect(p?.keyId).toBe('env:1');
  });

  it('rejects an unknown key', async () => {
    expect(await store.resolve('nope')).toBeNull();
  });
});
