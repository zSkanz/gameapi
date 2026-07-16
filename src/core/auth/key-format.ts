import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Per-game API key format: `gk_<12>.<43>` — a public key id, a dot, and the secret.
 *
 * The separator is a DOT because both halves are base64url, whose alphabet includes '_' and
 * '-' but never '.'. Splitting an underscore-delimited key on its last '_' lands inside the
 * random payload roughly half the time, producing a key that can never authenticate and
 * whose plaintext is unrecoverable by design.
 *
 * The secret is hashed with a plain sha256, NOT a KDF. That is deliberate and is the
 * opposite of the choice made for panel passwords (see core/auth/password.ts): a KDF exists
 * to slow down dictionary attacks on low-entropy human input, and this secret is 32 CSPRNG
 * bytes — there is no dictionary, no rainbow table, and no cross-key amortization, so a salt
 * buys nothing. Decisively, resolve() runs on every request from every Roblox server.
 */

const KEY_ID_BYTES = 9; // -> 12 base64url chars
const SECRET_BYTES = 32; // -> 43 base64url chars, 256 bits
const SHA256_BYTES = 32;

const KEY_ID_REGEX = /^gk_[A-Za-z0-9_-]{12}$/;
const SECRET_REGEX = /^[A-Za-z0-9_-]{43}$/;

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface GeneratedKey {
  keyId: string; // 'gk_<12>' — public handle, stored as api_keys.key_id
  secret: string; // 43 base64url chars — NEVER stored
  fullKey: string; // '<keyId>.<secret>' — shown to the operator exactly once
  secretHash: string; // hex sha256(secret) — stored as api_keys.secret_hash
}

export function generateApiKey(): GeneratedKey {
  const keyId = `gk_${randomBytes(KEY_ID_BYTES).toString('base64url')}`;
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return { keyId, secret, fullKey: `${keyId}.${secret}`, secretHash: sha256Hex(secret) };
}

/** Split a presented key. Returns null on anything malformed — never throws. */
export function parseApiKey(raw: string): { keyId: string; secret: string } | null {
  const dot = raw.indexOf('.');
  if (dot < 0) return null;
  const keyId = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  if (!KEY_ID_REGEX.test(keyId) || !SECRET_REGEX.test(secret)) return null;
  return { keyId, secret };
}

/** Constant-time compare of a presented secret against the stored hex digest. */
export function secretMatches(secret: string, storedHash: string): boolean {
  const expected = Buffer.from(storedHash, 'hex');
  // Buffer.from(<invalid hex>, 'hex') truncates silently instead of throwing, so a corrupt
  // stored hash yields a short buffer and timingSafeEqual would throw on the length mismatch
  // rather than return false. Both halves are fixed-length, so this leaks nothing.
  if (expected.length !== SHA256_BYTES) return false;
  return timingSafeEqual(Buffer.from(sha256Hex(secret), 'hex'), expected);
}
