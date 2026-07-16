/**
 * The panel session cookie. Hand-parsed rather than pulling in @fastify/cookie: the value is
 * an opaque 256-bit Redis token, so there is nothing to sign and no SESSION_SECRET to keep
 * consistent across CLUSTER_WORKERS — which leaves one header to read and one to write.
 *
 * `__Host-` is a real control, not decoration: the browser refuses the cookie unless it is
 * Secure, Path=/ and host-only (no Domain). That is what stops a sibling subdomain from
 * shadowing it — a narrower Path would not, because Path is not an origin boundary.
 */
export const SESSION_COOKIE = '__Host-gapi_panel';

/** 32 random bytes, base64url. Anything else was not minted by us. */
const VALUE_REGEX = /^[A-Za-z0-9_-]{43}$/;

/**
 * Read the session cookie out of a Cookie header.
 *
 * Scans every pair and rejects a DUPLICATE name rather than picking one: a duplicate is not a
 * normal client, and quietly taking the first (or last) is how session-fixation gets a foothold.
 */
export function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  let found: string | null = null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    if (found !== null) return null; // duplicate name — ambiguous, refuse
    found = part.slice(eq + 1).trim();
  }
  if (found === null || !VALUE_REGEX.test(found)) return null;
  return found;
}

/**
 * No Max-Age/Expires: a browser-session cookie, so Redis stays the single expiry authority.
 * SameSite=Strict is the primary CSRF control; the Origin check in the panel plugin closes
 * the same-site-but-cross-origin gap Strict leaves open.
 */
export function serializeSessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
