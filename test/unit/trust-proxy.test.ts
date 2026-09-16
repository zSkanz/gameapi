import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, trustProxyFrom } from '../../src/config/env';
import { buildApp } from '../../src/app';

/**
 * req.ip is what the panel's per-IP login throttle buckets on, so it has to be the real client
 * in both directions:
 *
 *  - through Caddy (peer = loopback) it must come from X-Forwarded-For, or every login shares
 *    Caddy's address and one attacker exhausts the bucket for everyone;
 *  - from anyone reaching :3000 directly it must be the socket address, or a forged
 *    X-Forwarded-For hands them a fresh bucket per request (GHSA-3m5p-2c4r-xxw2 — the old
 *    numeric hop-count trusted the header whoever sent it).
 *
 * Pinned to production's `TRUST_PROXY=1`, so a developer's own .env cannot change the result.
 */
let app: FastifyInstance;
beforeAll(async () => {
  process.env.TRUST_PROXY = '1';
  const config = loadConfig();
  expect(config.env.TRUST_PROXY).toBe('loopback,uniquelocal');
  app = await buildApp(config);
  app.get('/__test/ip', { config: { public: true } }, async (req) => ({ ip: req.ip }));
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

async function ipFor(remoteAddress: string, xff?: string): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: '/__test/ip',
    remoteAddress,
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { ip: string }).ip;
}

describe('req.ip behind Caddy', () => {
  it('uses X-Forwarded-For when the peer is the local proxy', async () => {
    // Caddy's `header_up X-Forwarded-For {remote_host}` replaces the header with the real client.
    expect(await ipFor('127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    expect(await ipFor('::1', '203.0.113.7')).toBe('203.0.113.7');
  });

  it('takes the entry the proxy added, not a forged one before it', async () => {
    // If Caddy ever appended instead of replacing, the client-controlled value is on the LEFT.
    expect(await ipFor('127.0.0.1', '6.6.6.6, 203.0.113.7')).toBe('203.0.113.7');
  });

  it('trusts a proxy on the docker bridge network too', async () => {
    expect(await ipFor('172.18.0.5', '203.0.113.7')).toBe('203.0.113.7');
  });

  it('falls back to the socket address with no header', async () => {
    expect(await ipFor('127.0.0.1')).toBe('127.0.0.1');
  });
});

describe('req.ip for a client that bypasses Caddy', () => {
  it('ignores a forged X-Forwarded-For from a public address', async () => {
    expect(await ipFor('198.51.100.9', '6.6.6.6')).toBe('198.51.100.9');
    expect(await ipFor('198.51.100.9', '127.0.0.1')).toBe('198.51.100.9');
    expect(await ipFor('2001:db8::9', '6.6.6.6')).toBe('2001:db8::9');
  });
});

describe('TRUST_PROXY parsing', () => {
  it('maps the deployed hop-count / boolean spellings to local proxy addresses', () => {
    // Never a number (fastify now ignores it) and never `true` (trusts the forgeable entry).
    for (const v of ['1', '2', 'true', 'yes']) expect(trustProxyFrom(v)).toBe('loopback,uniquelocal');
  });

  it('turns trust off for 0 / false / empty', () => {
    for (const v of ['0', 'false', 'no', '']) expect(trustProxyFrom(v)).toBe(false);
  });

  it('passes an explicit address list through', () => {
    expect(trustProxyFrom(' loopback ')).toBe('loopback');
    expect(trustProxyFrom('10.0.0.2,::1')).toBe('10.0.0.2,::1');
  });
});
