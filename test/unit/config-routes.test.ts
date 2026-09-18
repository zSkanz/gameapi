import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerConfigRoutes } from '../../src/modules/config/config.routes';
import type { ConfigRepository } from '../../src/modules/config/config.repository';
import { requireScope } from '../../src/core/http/guards';
import { registerErrorHandler } from '../../src/core/plugins/error-handler';

/**
 * The route layer with the repository stubbed: scope separation between reading values and seeing
 * drafts/history, the hand-built response for the hot read, and the per-game write meter.
 */

const calls: string[] = [];
const repo = {
  values: async (_gameId: string, atLeast: number) => {
    calls.push(`values:${atLeast}`);
    return { version: 7, publishedAt: '2026-09-17T12:00:00.000Z', entriesJson: '{"bossHealth":500,"shop":{"sword":120},"note":"a \\"quoted\\" word"}' };
  },
  state: async () => ({ version: 7, draft: null, publishedBy: 'skanz', draftUpdatedBy: 'key:gk_other' }),
  revisions: async () => ({ items: [{ version: 1, publishedBy: 'skanz' }], total: 1 }),
  revision: async () => ({ version: 1, changes: {}, publishedBy: 'skanz' }),
  patchDraft: async () => ({ version: 7, draft: {}, publishedBy: 'skanz', draftUpdatedBy: 'skanz' }),
  publish: async () => ({ version: 8, state: {} }),
} as unknown as ConfigRepository;

let app: FastifyInstance;
const charged: [string, number][] = [];
const buckets: (string | undefined)[] = [];

beforeAll(async () => {
  app = Fastify();
  registerErrorHandler(app);
  app.decorate('rateLimit', async (id: string, limit: number) => void charged.push([id, limit]));
  // Stand-in for the auth hook: scopes come from a header.
  app.addHook('onRequest', async (req) => {
    const scopes = String(req.headers['x-scopes'] ?? '').split(',').filter(Boolean);
    req.principal = { keyId: 'gk_test', allowedGameIds: ['g1'], scopes };
  });
  app.addHook('preHandler', async (req) => void buckets.push(req.routeOptions.config?.rateLimitBucket));
  await app.register(
    async (scope) => {
      registerConfigRoutes(scope, repo, {
        path: (suffix) => suffix || '/',
        read: [requireScope('config:read')],
        inspect: [requireScope('config:write')],
        write: [requireScope('config:write')],
        config: (docs, extra) => ({ docs, ...extra }),
        actor: (req) => `key:${req.principal!.keyId}`,
        author: (a) => (a === null || a.startsWith('key:') ? a : 'panel'),
      });
    },
    { prefix: '/v1/games/:gameId/config' },
  );
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const get = (url: string, scopes: string) => app.inject({ method: 'GET', url, headers: { 'x-scopes': scopes } });

describe('config routes', () => {
  it('the hot read returns valid JSON with the pre-serialized entries spliced in', async () => {
    const res = await get('/v1/games/g1/config', 'config:read');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json() as { ok: boolean; data: Record<string, unknown>; meta: { requestId: string } };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({
      version: 7,
      changed: true,
      publishedAt: '2026-09-17T12:00:00.000Z',
      entries: { bossHealth: 500, shop: { sword: 120 }, note: 'a "quoted" word' },
    });
    expect(body.meta.requestId).toBeTruthy();
  });

  it('an unchanged version answers without entries, and passes the known version down', async () => {
    calls.length = 0;
    const res = await get('/v1/games/g1/config?knownVersion=7', 'config:read');
    expect(res.json().data).toEqual({ version: 7, changed: false });
    expect(calls).toEqual(['values:7']);
  });

  it('config:read reads values but not drafts, authors or history', async () => {
    for (const path of ['/state', '/revisions', '/revisions/1']) {
      expect((await get(`/v1/games/g1/config${path}`, 'config:read')).statusCode, path).toBe(403);
      expect((await get(`/v1/games/g1/config${path}`, 'config:write')).statusCode, path).toBe(200);
    }
    expect((await get('/v1/games/g1/config', '')).statusCode).toBe(403);
  });

  it('only the hot read is charged to the polling bucket', async () => {
    buckets.length = 0;
    await get('/v1/games/g1/config?knownVersion=7', 'config:read');
    await get('/v1/games/g1/config/state', 'config:write');
    expect(buckets).toEqual(['config-poll', undefined]);
  });

  it('every write is metered per game, on top of the scope check', async () => {
    charged.length = 0;
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/games/g1/config/draft',
      headers: { 'x-scopes': 'config:write' },
      payload: { entries: { bossHealth: { type: 'number', value: 1 } } },
    });
    expect(res.statusCode).toBe(200);
    expect(charged).toEqual([['cfgw:game:g1', 60]]);

    const denied = await app.inject({ method: 'POST', url: '/v1/games/g1/config/publish', headers: { 'x-scopes': 'config:read' }, payload: {} });
    expect(denied.statusCode).toBe(403);
  });

  // A draft body may be a megabyte. A key without config:write must be refused BEFORE it is parsed:
  // the malformed body below would be a 400 if parsing came first.
  it('refuses a write without config:write before parsing its body', async () => {
    charged.length = 0;
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/games/g1/config/draft',
      headers: { 'x-scopes': 'config:read', 'content-type': 'application/json' },
      payload: '{"entries": {' + 'x'.repeat(50_000),
    });
    expect(res.statusCode).toBe(403);
    expect(charged).toEqual([]); // nor charged to the game's write meter
  });

  // A panel username is half a panel credential; an API key sees that a person did it, not who.
  it('shows API keys a panel author as "panel", and a key author as itself', async () => {
    const state = (await get('/v1/games/g1/config/state', 'config:write')).json().data;
    expect(state.publishedBy).toBe('panel');
    expect(state.draftUpdatedBy).toBe('key:gk_other');
    expect((await get('/v1/games/g1/config/revisions', 'config:write')).json().data.items[0].publishedBy).toBe('panel');
    expect((await get('/v1/games/g1/config/revisions/1', 'config:write')).json().data.publishedBy).toBe('panel');
    const written = await app.inject({
      method: 'PATCH',
      url: '/v1/games/g1/config/draft',
      headers: { 'x-scopes': 'config:write' },
      payload: { entries: {} },
    });
    expect(written.json().data.draftUpdatedBy).toBe('panel');
  });
});
