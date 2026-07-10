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

/** Does this principal hold the given scope? */
export function hasScope(principal: Principal, scope: string): boolean {
  return principal.scopes === '*' || principal.scopes.includes(scope);
}

/** May this principal address the given gameId? */
export function mayAccessGame(principal: Principal, gameId: string): boolean {
  return principal.allowedGameIds === '*' || principal.allowedGameIds.includes(gameId);
}
