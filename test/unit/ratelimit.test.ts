import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { rateLimitPlugin } from '../../src/core/plugins/ratelimit';
import { registerErrorHandler } from '../../src/core/plugins/error-handler';

/** Just enough of ioredis for the limiter: MULTI with incrby/expire/get/decrby. */
function fakeRedis() {
  const store = new Map<string, number>();
  let roundTrips = 0;
  const multi = () => {
    const ops: Array<() => [null, unknown]> = [];
    const chain = {
      incrby: (k: string, n: number) => (ops.push(() => [null, store.set(k, (store.get(k) ?? 0) + n).get(k)]), chain),
      decrby: (k: string, n: number) => (ops.push(() => [null, store.set(k, (store.get(k) ?? 0) - n).get(k)]), chain),
      expire: () => (ops.push(() => [null, 1]), chain),
      get: (k: string) => (ops.push(() => [null, store.has(k) ? String(store.get(k)) : null]), chain),
      exec: async () => {
        roundTrips++;
        return ops.map((op) => op());
      },
    };
    return chain;
  };
  return { redis: { multi }, store, trips: () => roundTrips };
}

const KEY_LIMIT = 3;
const GAME_LIMIT = 100;
let app: FastifyInstance;
let fake: ReturnType<typeof fakeRedis>;

beforeEach(async () => {
  fake = fakeRedis();
  app = Fastify();
  registerErrorHandler(app);
  app.decorate('config', { env: { REDIS_KEY_PREFIX: 't:', RATE_LIMIT_KEY_PER_MIN: KEY_LIMIT, RATE_LIMIT_GAME_PER_MIN: GAME_LIMIT } } as never);
  app.decorate('redis', fake.redis as never);
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req) => {
    req.principal = { keyId: String(req.headers['x-key']), allowedGameIds: '*', scopes: '*' };
  });
  await rateLimitPlugin(app);
  app.get('/games/:gameId/x', async () => ({ ok: true }));
  await app.ready();
});

const hit = (key: string) => app.inject({ method: 'GET', url: '/games/g1/x', headers: { 'x-key': key } });
const gameCount = () => [...fake.store].filter(([k]) => k.startsWith('t:rl:game:g1:')).reduce((n, [, v]) => n + v, 0);

describe('request rate limiter', () => {
  it('charges the key and the game in one Redis round trip', async () => {
    expect((await hit('a')).statusCode).toBe(200);
    expect(fake.trips()).toBe(1);
    expect(gameCount()).toBe(1);
  });

  it('429s a key over its limit', async () => {
    for (let i = 0; i < KEY_LIMIT; i++) expect((await hit('a')).statusCode).toBe(200);
    expect((await hit('a')).statusCode).toBe(429);
  });

  // The game bucket is shared by every key of the game: a key already refused for its own limit
  // must not keep spending it, exactly as when the two were checked one after the other.
  it('refunds the game bucket for a request its key already refused', async () => {
    for (let i = 0; i < KEY_LIMIT + 5; i++) await hit('a');
    await new Promise((r) => setImmediate(r)); // the refund is fire-and-forget
    expect(gameCount()).toBe(KEY_LIMIT);
    expect((await hit('b')).statusCode).toBe(200); // another key of the game is unaffected
  });
});
