import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerErrorHandler } from '../../src/core/plugins/error-handler';

/**
 * A datastore outage must reach the Roblox client as a retriable 503. Both drivers reject
 * connection failures with a plain Error carrying NO `.code`, so classification falls back to
 * the message — these are the real strings, captured from a live pool with Postgres down.
 * Without this the client sees a 500 and does not retry.
 */
async function statusFor(err: Error): Promise<{ status: number; code: string }> {
  const app = Fastify();
  registerErrorHandler(app);
  app.get('/boom', { config: { public: true } }, async () => {
    throw err;
  });
  const r = await app.inject({ method: 'GET', url: '/boom' });
  await app.close();
  return { status: r.statusCode, code: JSON.parse(r.body).error.code };
}

const withCode = (message: string, code: string): Error => Object.assign(new Error(message), { code });

describe('datastore outage classification', () => {
  it('maps codeless pg-pool connection failures to a retriable 503', async () => {
    for (const message of [
      'Connection terminated due to connection timeout: Connection terminated unexpectedly',
      'Connection terminated unexpectedly',
      'timeout exceeded when trying to connect',
      'Client has encountered a connection error and is not queryable',
    ]) {
      const r = await statusFor(new Error(message));
      expect(r, message).toEqual({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    }
  });

  it('maps codeless ioredis failures to a retriable 503', async () => {
    for (const message of ["Stream isn't writeable and enableOfflineQueue options is false", 'Connection is closed.']) {
      const r = await statusFor(new Error(message));
      expect(r, message).toEqual({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    }
  });

  it('still maps coded connection failures to 503', async () => {
    for (const [message, code] of [
      ['getaddrinfo ENOTFOUND postgres', 'ENOTFOUND'],
      ['connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED'],
      ['terminating connection due to administrator command', '57P01'],
    ] as const) {
      const r = await statusFor(withCode(message, code));
      expect(r, message).toEqual({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    }
  });

  it('maps postgres constraint outcomes to their real status, not 500', async () => {
    expect(await statusFor(withCode('duplicate key value violates unique constraint', '23505'))).toEqual({
      status: 409,
      code: 'CONFLICT',
    });
    expect(await statusFor(withCode('new row violates check constraint', '23514'))).toEqual({
      status: 400,
      code: 'VALIDATION_ERROR',
    });
    expect(await statusFor(withCode('canceling statement due to statement timeout', '57014'))).toEqual({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  // The point of matching narrowly: a real bug must stay a loud 500, not become "retry later".
  it('leaves an unrecognized error as a 500', async () => {
    expect(await statusFor(new Error('cannot read properties of undefined'))).toEqual({
      status: 500,
      code: 'INTERNAL_ERROR',
    });
    expect(await statusFor(new Error('Cannot use a pool after calling end on the pool'))).toEqual({
      status: 500,
      code: 'INTERNAL_ERROR',
    });
  });
});
