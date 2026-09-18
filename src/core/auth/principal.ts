/**
 * A resolved caller: a per-game key from the panel (DbApiKeyStore), the .env bootstrap key
 * (EnvApiKeyStore), or a panel session (principalFor below).
 *
 * `scopes: '*'` belongs to an OWNER SESSION and nothing else. hasScope() short-circuits on it, so
 * a key holding '*' would pass requireScope('panel:owner') — test/unit/panel-scope.test.ts exists
 * to keep it that way. Keys always carry an explicit list.
 */
export interface Principal {
  keyId: string; // "gk_ab12cd…" for a panel-minted key, "env:primary" (or "env:<n>") for the bootstrap key, "panel:<userId>" for a session
  allowedGameIds: '*' | string[]; // one game for a panel-minted key; '*' for the bootstrap key and sessions
  scopes: '*' | string[]; // e.g. ['stock:read','stock:write']; '*' only for an owner session
}

export interface ApiKeyStore {
  resolve(rawKey: string): Promise<Principal | null>;
}

export type PanelRole = 'owner' | 'admin';

/**
 * A resolved panel operator — a human with a session cookie, never an api key. Lives here
 * (not in modules/panel) so core/ never imports a module.
 */
export interface PanelSession {
  userId: string;
  username: string;
  role: PanelRole;
  mustChangePassword: boolean;
}

/** Panel sessions carry scopes; an api key never gets panel:*. Owner is unrestricted. */
export function principalFor(session: PanelSession): Principal {
  return {
    keyId: `panel:${session.userId}`,
    allowedGameIds: '*',
    scopes:
      session.role === 'owner'
        ? '*'
        : [
            'panel:read',
            'panel:write',
            'stock:read',
            'stock:write',
            'serial:read',
            'serial:write',
            'funnel:read',
            'funnel:write',
            'games:read',
          ],
  };
}

/** Does this principal hold the given scope? */
export function hasScope(principal: Principal, scope: string): boolean {
  return principal.scopes === '*' || principal.scopes.includes(scope);
}

/** May this principal address the given gameId? */
export function mayAccessGame(principal: Principal, gameId: string): boolean {
  return principal.allowedGameIds === '*' || principal.allowedGameIds.includes(gameId);
}
