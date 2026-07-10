import { createHash, timingSafeEqual } from 'node:crypto';
import type { ApiKeyStore, Principal } from './principal';

const sha256 = (s: string | Buffer): Buffer => createHash('sha256').update(s).digest();

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
    return { keyId: matched, allowedGameIds: '*', scopes: '*' };
  }
}
