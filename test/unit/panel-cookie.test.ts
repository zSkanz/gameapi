import { describe, it, expect } from 'vitest';
import { readSessionCookie, serializeSessionCookie, clearSessionCookie, SESSION_COOKIE } from '../../src/core/auth/cookie';

const VALID = 'a'.repeat(43);

describe('panel session cookie', () => {
  it('reads the value out of a realistic header', () => {
    expect(readSessionCookie(`${SESSION_COOKIE}=${VALID}`)).toBe(VALID);
    expect(readSessionCookie(`other=1; ${SESSION_COOKIE}=${VALID}; third=x`)).toBe(VALID);
    expect(readSessionCookie(`  ${SESSION_COOKIE}=${VALID}  `)).toBe(VALID);
  });

  // Taking the first (or last) of a duplicated name is how session fixation gets a foothold:
  // an attacker who can set a cookie on a sibling host races the real one.
  it('refuses a duplicated cookie name rather than picking one', () => {
    expect(readSessionCookie(`${SESSION_COOKIE}=${VALID}; ${SESSION_COOKIE}=${'b'.repeat(43)}`)).toBeNull();
  });

  it('rejects anything it did not mint', () => {
    for (const bad of [
      undefined,
      '',
      'other=1',
      `${SESSION_COOKIE}=`,
      `${SESSION_COOKIE}=short`,
      `${SESSION_COOKIE}=${'a'.repeat(42)}`,
      `${SESSION_COOKIE}=${'a'.repeat(44)}`,
      `${SESSION_COOKIE}=${'!'.repeat(43)}`,
      `${SESSION_COOKIE}=${'+'.repeat(43)}`, // base64, not base64url
    ]) {
      expect(readSessionCookie(bad), String(bad)).toBeNull();
    }
  });

  // __Host- is browser-enforced: it requires Secure + Path=/ + no Domain, which is what stops
  // a sibling subdomain from shadowing the cookie. Drop any attribute and the guarantee goes.
  it('serializes with the attributes __Host- requires', () => {
    const c = serializeSessionCookie(VALID);
    expect(c).toBe(`__Host-gapi_panel=${VALID}; Path=/; HttpOnly; Secure; SameSite=Strict`);
    expect(c).not.toMatch(/Domain=/i);
    expect(c).not.toMatch(/Max-Age|Expires/i); // Redis is the only expiry authority
  });

  it('clears with a matching attribute set', () => {
    expect(clearSessionCookie()).toContain('Max-Age=0');
    expect(clearSessionCookie()).toContain('Path=/');
  });
});
