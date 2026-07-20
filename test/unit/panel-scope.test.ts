import { describe, it, expect } from 'vitest';
import { EnvApiKeyStore } from '../../src/core/auth/env-store';
import { hasScope, mayAccessGame, principalFor } from '../../src/core/auth/principal';
import { GAME_SCOPES } from '../../src/core/auth/db-store';

/**
 * The separation the whole panel design rests on: an API key is data plane, a session is
 * control plane, and no credential is ever both.
 *
 * This is defence in depth, not the primary control — that one is structural (`req.panel` is
 * set only by the cookie branch, and the panel gate refuses without it). But the wildcard here
 * is what made the primary control necessary in the first place, so it gets a test that fails
 * loudly if anyone reintroduces it.
 */
describe('panel scopes are unreachable from the data plane', () => {
  const PANEL_SCOPES = ['panel:read', 'panel:write', 'panel:owner', 'keys:read', 'keys:write'];

  it('the .env bootstrap key holds no panel scope', async () => {
    const store = new EnvApiKeyStore(['a-bootstrap-key-of-sufficient-length']);
    const p = await store.resolve('a-bootstrap-key-of-sufficient-length');
    expect(p).not.toBeNull();
    // A wildcard would satisfy every one of these — hasScope() short-circuits on '*'.
    expect(p!.scopes).not.toBe('*');
    for (const s of PANEL_SCOPES) expect(hasScope(p!, s), s).toBe(false);
  });

  it('a per-game key can only ever hold game scopes', () => {
    for (const s of PANEL_SCOPES) expect(GAME_SCOPES).not.toContain(s);
    // games:read is excluded too: GET /v1/games is a cross-tenant list, and a key scoped to one
    // game must not enumerate the others.
    expect(GAME_SCOPES).not.toContain('games:read');
    expect([...GAME_SCOPES]).toEqual([
      'stock:read',
      'stock:write',
      'serial:read',
      'serial:write',
      'funnel:read',
      'funnel:write',
    ]);
  });

  it('an owner session is unrestricted; an admin session is not', () => {
    const owner = principalFor({ userId: 'pu_1', username: 'o', role: 'owner', mustChangePassword: false });
    expect(hasScope(owner, 'panel:owner')).toBe(true);

    const admin = principalFor({ userId: 'pu_2', username: 'a', role: 'admin', mustChangePassword: false });
    expect(hasScope(admin, 'panel:owner')).toBe(false); // purge, accounts, create-game
    expect(hasScope(admin, 'panel:write')).toBe(true);
    expect(hasScope(admin, 'panel:read')).toBe(true);
  });

  it('a panel principal is attributable to a human in the ledger', () => {
    const p = principalFor({ userId: 'pu_abc', username: 'juan', role: 'admin', mustChangePassword: false });
    // stock_ledger.api_key_id discriminates actors by prefix: env:* | gk_* | panel:<userId>
    expect(p.keyId).toBe('panel:pu_abc');
    expect(mayAccessGame(p, 'any-game')).toBe(true);
  });
});
