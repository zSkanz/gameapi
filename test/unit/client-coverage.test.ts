import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/config/env';
import { buildApp } from '../../src/app';

const CLIENT = readFileSync(
  resolve(__dirname, '..', '..', 'clients', 'roblox', 'GameApiClient.lua'),
  'utf8',
);

/**
 * The Luau client and the server are two halves of one contract that nothing else checks. A path
 * typo in the client is invisible here and a 404 in production; an endpoint with no client method
 * is a feature nobody can reach from a game.
 *
 * This boots the real app and asks it, rather than comparing two lists by hand.
 */
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp(loadConfig());
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

/** Every path the client builds, with its Lua format specifiers turned into concrete values. */
function clientPaths(): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  // ("/games/%s/stock/%s/get"):format(...)  ->  the literal, plus the _request verb near it.
  for (const m of CLIENT.matchAll(/local path = \("([^"]+)"\)[\s\S]{0,400}?self:_request\("(GET|POST)"/g)) {
    out.push({ method: m[2]!, path: m[1]! });
  }
  // The funnel flush builds its path a few lines above the call; catch it explicitly.
  for (const m of CLIENT.matchAll(/local path = \("([^"]+)"\):format\(self\.gameId\)\s*\n[\s\S]{0,600}?_request\("(POST)"/g)) {
    out.push({ method: m[2]!, path: m[1]! });
  }
  return out.map(({ method, path }) => ({
    method,
    // %s -> a value that satisfies the route's param regexes; %d -> a number.
    path: path.replace(/%s/g, 'x').replace(/%d/g, '1'),
  }));
}

describe('the Luau client and the server agree', () => {
  it('extracts the paths it builds', () => {
    // A guard on the guard: if the regex stops matching, every assertion below passes vacuously.
    expect(clientPaths().length).toBeGreaterThanOrEqual(11);
  });

  it('every path the client calls resolves to a real route', async () => {
    const missing: string[] = [];
    for (const { method, path } of clientPaths()) {
      const url = `/v1${path}`;
      const res = await app.inject({ method: method as 'GET', url });
      // No api key, so a registered route answers 401. A 404 means the path does not exist —
      // which is exactly the typo this test is for.
      if (res.statusCode === 404) missing.push(`${method} ${url}`);
    }
    expect(missing, 'client builds a path the server does not serve').toEqual([]);
  });

  /**
   * The reverse direction, and the one that found the real gap: the server had 14 game-facing
   * endpoints and the client could reach 6. The whole serial module, the batch read and both
   * list endpoints had no client method at all.
   */
  it('every game-facing endpoint has a client method', () => {
    const required: [string, RegExp][] = [
      ['stock get-or-create', /stock\/%s\/get/],
      ['stock decrease', /stock\/%s\/decrease/],
      ['stock adjust', /stock\/%s\/adjust/],
      ['stock set-max', /stock\/%s\/set-max/],
      ['stock read', /"\/games\/%s\/stock\/%s"/],
      ['stock batch read', /stock\/batch/],
      ['stock list', /stock\?limit/],
      ['serial get-or-create', /serial\/%s\/get/],
      ['serial issue', /serial\/%s\/issue/],
      ['serial read', /"\/games\/%s\/serial\/%s"/],
      ['serial list', /serial\?limit/],
      ['funnel log', /funnel\/log/],
      ['funnel list', /"\/games\/%s\/funnel"/],
      ['roblox universes', /roblox\/universes\?ids=/],
      ['roblox place universe', /roblox\/places\/%d\/universe/],
      ['roblox badges', /roblox\/universes\/%d\/badges/],
      ['roblox game passes', /roblox\/universes\/%d\/game-passes/],
      ['roblox users', /roblox\/users\?ids=/],
      ['roblox users by username', /roblox\/users\/by-username\?names=/],
      ['roblox user profile', /"\/games\/%s\/roblox\/users\/%d"/],
      ['roblox user groups', /roblox\/users\/%d\/groups/],
      ['roblox group', /roblox\/groups\/%d/],
    ];
    const uncovered = required.filter(([, re]) => !re.test(CLIENT)).map(([name]) => name);
    expect(uncovered, 'server endpoint with no way to call it from a game').toEqual([]);
  });

  /**
   * Idempotency is the difference between a retry replaying a purchase and charging twice. The
   * server REQUIRES the header on exactly these, and the client must generate the GUID once per
   * logical action — outside the retry loop — for it to mean anything.
   */
  it('sends an idempotency key on exactly the mutations that require one', () => {
    const body = (fn: string): string => {
      const at = CLIENT.indexOf(`function GameApi.${fn}(self: GameApi`);
      expect(at, `no method ${fn}`).toBeGreaterThan(-1);
      return CLIENT.slice(at, CLIENT.indexOf('\nend', at));
    };
    for (const fn of ['decrease', 'adjust', 'setMax', 'issueSerial']) {
      expect(body(fn), `${fn} must generate an idempotency key`).toContain('GenerateGUID(false)');
      expect(body(fn), `${fn} must pass it to _request`).toContain('idemKey');
    }
    // These are naturally idempotent server-side; a header here would be one the handler ignores.
    for (const fn of ['getOrCreate', 'getOrCreateSerial', 'read', 'batchRead', 'listStock']) {
      expect(body(fn), `${fn} should NOT send an idempotency key`).not.toContain('GenerateGUID');
    }
  });

  it('generates the key ONCE, outside the retry loop', () => {
    // _request closes over idemKey and reuses it across attempts. If a wrapper generated it
    // inside the loop instead, every retry would be a new logical action and exactly-once dies.
    const req = CLIENT.slice(CLIENT.indexOf('function GameApi._request(self: GameApi'));
    expect(req.slice(0, req.indexOf('\nend'))).not.toContain('GenerateGUID');
  });
});
