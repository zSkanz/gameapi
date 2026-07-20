import { createHash, timingSafeEqual } from 'node:crypto';
import type { ApiKeyStore, Principal } from './principal';

const sha256 = (s: string | Buffer): Buffer => createHash('sha256').update(s).digest();

/**
 * The bootstrap key is cross-GAME, never cross-CAPABILITY. These five are exactly the scopes
 * the game-facing routes require, so enumerating them changes nothing for existing callers.
 *
 * It must never be '*': hasScope() short-circuits on '*', so a wildcard here would satisfy
 * requireScope('panel:owner') for the key that sits in every Roblox script — handing the
 * panel's destructive surface to any leaked game key.
 */
const BOOTSTRAP_SCOPES = [
  'stock:read',
  'stock:write',
  'serial:read',
  'serial:write',
  'funnel:read',
  'funnel:write',
  'games:read',
];

/**
 * API key store backed by the .env-provided key set. Comparison is constant-time:
 * both sides are reduced to a fixed 32-byte digest (equal length, no early-return),
 * and every candidate is scanned so loop time never reveals which key matched.
 *
 * Swapping this for a DbApiKeyStore (per-game scopes) is a one-line change in the
 * auth plugin — the ApiKeyStore contract does not change.
 */
export class EnvApiKeyStore implements ApiKeyStore {
  private readonly records: { keyId: string; digest: Buffer }[];

  constructor(apiKeys: string[]) {
    this.records = apiKeys.map((raw, i) => ({
      keyId: i === 0 ? 'env:primary' : `env:${i}`,
      digest: sha256(raw),
    }));
  }

  async resolve(rawKey: string): Promise<Principal | null> {
    const presented = sha256(rawKey);
    let matched: string | null = null;
    for (const r of this.records) {
      // digests are always 32 bytes, so timingSafeEqual never throws on length
      if (timingSafeEqual(r.digest, presented)) {
        matched = r.keyId; // no early break — scan all candidates
      }
    }
    if (!matched) return null;
    return { keyId: matched, allowedGameIds: '*', scopes: BOOTSTRAP_SCOPES };
  }
}
