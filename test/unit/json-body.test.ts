import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { httpHooksPlugin } from '../../src/core/plugins/http-hooks';

/**
 * Games already live run a Luau client that sends Content-Type: application/json on issueSerial's
 * bodyless POST. The server must accept that — and must not loosen anything else on the way.
 */
let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify({ bodyLimit: 1024 });
  await httpHooksPlugin(app);
  app.post('/echo', async (req) => ({ body: req.body ?? null }));
  app.post('/big', { bodyLimit: 4096 }, async (req) => ({ size: JSON.stringify(req.body).length }));
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const post = (url: string, payload: string) =>
  app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload });

describe('application/json bodies', () => {
  it('accepts an empty body as no body', async () => {
    const res = await post('/echo', '');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: null });
  });

  it('still parses a normal body', async () => {
    expect((await post('/echo', '{"a":1}')).json()).toEqual({ body: { a: 1 } });
  });

  it('still refuses malformed JSON', async () => {
    expect((await post('/echo', '{"a":')).statusCode).toBe(400);
  });

  it('still refuses __proto__ and constructor.prototype', async () => {
    expect((await post('/echo', '{"__proto__":{"x":1}}')).statusCode).toBe(400);
    expect((await post('/echo', '{"constructor":{"prototype":{"x":1}}}')).statusCode).toBe(400);
  });

  it('still honours the global and per-route body limits', async () => {
    const body = JSON.stringify({ s: 'x'.repeat(2000) });
    expect((await post('/echo', body)).statusCode).toBe(413);
    expect((await post('/big', body)).statusCode).toBe(200);
  });
});
