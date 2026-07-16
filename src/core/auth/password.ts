import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { Errors } from '../errors/app-error';

/**
 * Panel password hashing. scrypt from node:crypto — no argon2/bcrypt dependency, which would
 * be a native build: Dockerfile runs `npm ci` on node:22-bookworm-slim, which has no
 * python3/make/g++, so node-gyp would fall back and hard-fail.
 *
 * This is the OPPOSITE choice from api-key secrets (see key-format.ts, plain sha256), and the
 * two are not in tension: a KDF exists to make a low-entropy, dictionary-guessable human
 * password infeasible to brute-force, and it runs once per login. An api-key secret is 32
 * CSPRNG bytes on the Roblox hot path, where a KDF would cap a worker at ~34 req/s.
 */

interface Params {
  N: number;
  r: number;
  p: number;
}

/** OWASP-listed. Of the three listed sets this has the lowest memory cost (32 MiB). */
const CURRENT: Params = { N: 32768, r: 8, p: 3 };

/**
 * The weakest params still accepted. The dummy hash is built at THESE, not at CURRENT: if a
 * future N rise left older/cheaper hashes in the table, a dummy at the new cost would take
 * LONGER than a real verify and invert the very timing oracle it exists to close.
 */
const WEAKEST: Params = { N: 32768, r: 8, p: 3 };

/**
 * Node's default maxmem is exactly 128*N*r, and OpenSSL needs a little headroom above that —
 * so these params throw ERR_CRYPTO_INVALID_SCRYPT_PARAMS at the default. Verified: it is a
 * SYNCHRONOUS throw from the async function, which is why the call sits inside the Promise
 * executor below rather than beside it.
 */
const maxmemFor = (P: Params): number => 128 * P.N * P.r * 2;

const KEY_LEN = 32;
const SALT_LEN = 16;

/** At most this many scrypt calls run at once; the rest are shed with a 503. */
const MAX_IN_FLIGHT = 2;
let inFlight = 0;

/**
 * The only bound that survives a distributed attacker. Both throttle buckets are
 * attacker-partitioned — rotate the forwarded IP for a fresh IP bucket, rotate the username
 * for a fresh user bucket (and an unknown username then *guarantees* a full-cost dummy hash).
 * Without this, 32 MiB x unbounded concurrency is a memory and CPU exhaustion primitive.
 */
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) {
    throw Errors.unavailable('Too many sign-in attempts are being processed. Try again in a moment.', 2);
  }
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
  }
}

function scryptAsync(password: string, salt: Buffer, P: Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Inside the executor on purpose: invalid params throw synchronously, and outside this
    // scope that throw would escape as an exception instead of rejecting the promise.
    try {
      scrypt(password.normalize('NFKC'), salt, KEY_LEN, { ...P, maxmem: maxmemFor(P) }, (err, key) =>
        err ? reject(err) : resolve(key),
      );
    } catch (err) {
      reject(err);
    }
  });
}

/** `scrypt$N=..,r=..,p=..$salt$hash` — self-describing, so params can rise with no migration. */
function encode(P: Params, salt: Buffer, hash: Buffer): string {
  return `scrypt$N=${P.N},r=${P.r},p=${P.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function decode(stored: string): { P: Params; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return null;
  const m = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parts[1]!);
  if (!m) return null;
  const P = { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  if (!(P.N > 0 && P.r > 0 && P.p > 0)) return null;
  const salt = Buffer.from(parts[2]!, 'base64url');
  const hash = Buffer.from(parts[3]!, 'base64url');
  if (salt.length === 0 || hash.length !== KEY_LEN) return null;
  return { P, salt, hash };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await withSlot(() => scryptAsync(password, salt, CURRENT));
  return encode(CURRENT, salt, hash);
}

/** Constant-time verify. Returns false — never throws — on a malformed stored hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = decode(stored);
  if (!parsed) return false; // corrupt row: reject, do not 500
  let hash: Buffer;
  try {
    hash = await withSlot(() => scryptAsync(password, parsed.salt, parsed.P));
  } catch (err) {
    if (err instanceof Error && err.name === 'AppError') throw err; // shed -> 503, not "wrong password"
    return false; // params in the row are unusable on this build
  }
  return timingSafeEqual(hash, parsed.hash);
}

/** True once CURRENT outgrows what this hash was built with. Re-hash on next successful login. */
export function needsRehash(stored: string): boolean {
  const parsed = decode(stored);
  if (!parsed) return true;
  return parsed.P.N < CURRENT.N || parsed.P.r < CURRENT.r || parsed.P.p < CURRENT.p;
}

const DUMMY_SALT = randomBytes(SALT_LEN);
const DUMMY_PASSWORD = randomBytes(18).toString('base64url');

/**
 * Burn exactly ONE scrypt, at the weakest accepted params, so an unknown or disabled username
 * costs the same as a real one. Without it ~1 ms vs ~123 ms is a user-existence oracle
 * readable straight off the wire, and the login response is byte-identical for every cause.
 *
 * Deliberately not "hash a dummy then verify it": that path costs two scrypts on its first
 * call and one thereafter, so the very first unknown-username probe would stand out at double
 * the time — the oracle this closes, reopened by the mitigation itself. It also consumes a
 * concurrency slot, because a real verify does.
 */
export async function equalizeLoginTiming(): Promise<void> {
  await withSlot(() => scryptAsync(DUMMY_PASSWORD, DUMMY_SALT, WEAKEST));
}

/** 24 base64url chars (~143 bits). Shown to the operator once, then only its hash exists. */
export function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}
