/**
 * A resolved caller. Today the single .env key resolves to a wildcard principal;
 * the same shape supports per-game scoped keys later with zero route/handler changes.
 */
export interface Principal {
  keyId: string; // "env:primary" today; "gk_ab12cd" from a DB store later
  allowedGameIds: '*' | string[]; // '*' for the single global key today
  scopes: '*' | string[]; // e.g. ['stock:read','stock:write']; '*' today
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
