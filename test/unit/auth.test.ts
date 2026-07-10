import { describe, it, expect } from 'vitest';
import { EnvApiKeyStore } from '../../src/core/auth/env-store';

describe('EnvApiKeyStore', () => {
  const store = new EnvApiKeyStore(['primary_key_abcdefghijklmnop', 'secondary_key_qrstuvwxyz012345']);

  it('resolves a valid key to a wildcard principal', async () => {
    const p = await store.resolve('primary_key_abcdefghijklmnop');
    expect(p).not.toBeNull();
    expect(p?.keyId).toBe('env:primary');
    expect(p?.allowedGameIds).toBe('*');
    expect(p?.scopes).toBe('*');
  });

  it('resolves a rotated (secondary) key', async () => {
    const p = await store.resolve('secondary_key_qrstuvwxyz012345');
    expect(p?.keyId).toBe('env:1');
  });

  it('rejects an unknown key', async () => {
    expect(await store.resolve('nope')).toBeNull();
  });
});
