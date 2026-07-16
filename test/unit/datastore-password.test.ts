import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createPool } from '../../src/core/plugins/postgres';
import { createRedis } from '../../src/core/plugins/redis';

// createPool/createRedis only read these fields; cast a minimal shape to AppConfig.
const pgCfg = (url: string, secret?: string) =>
  ({ env: { DATABASE_URL: url, PG_POOL_MAX: 5 }, pgPassword: secret } as never);
const redisCfg = (url: string, secret?: string) =>
  ({ env: { REDIS_URL: url }, redisPassword: secret } as never);

describe('datastore password precedence (docker secret vs URL)', () => {
  it('pg: the docker-secret password overrides one embedded in DATABASE_URL', async () => {
    const pool = createPool(pgCfg('postgres://gameapi:fromurl@postgres:5432/gameapi', 'FROM_SECRET'));
    expect(pool.options.password).toBe('FROM_SECRET'); // secret wins — this is BUG 2's fix
    expect(pool.options.host).toBe('postgres');
    expect(pool.options.port).toBe(5432);
    expect(pool.options.user).toBe('gameapi');
    expect(pool.options.database).toBe('gameapi');
    await pool.end();
  });

  it('pg: falls back to the URL password when no secret is set (local dev)', async () => {
    const pool = createPool(pgCfg('postgres://gameapi:devpass@localhost:5432/gameapi'));
    expect(pool.options.password).toBe('devpass');
    await pool.end();
  });

  it('redis: the docker-secret password overrides one embedded in REDIS_URL', () => {
    const redis = createRedis(redisCfg('redis://:fromurl@redis:6379/0', 'FROM_SECRET'));
    redis.on('error', () => {}); // swallow the background connect error
    expect(redis.options.password).toBe('FROM_SECRET');
    expect(redis.options.host).toBe('redis');
    expect(redis.options.port).toBe(6379);
    redis.disconnect();
  });

  /**
   * The precedence bug above was fixed once in createPool and then reintroduced verbatim in
   * panel-owner.ts, which built its own Pool from DATABASE_URL. It only surfaced in production,
   * on the one command you run when you are locked out of the panel.
   *
   * The unit test above cannot catch that: it tests the helper, and the bug is not using the
   * helper. So this asserts the rule directly — createPool is the only place a Pool is built.
   */
  it('createPool is the ONLY place that constructs a pg Pool', () => {
    const src = join(__dirname, '..', '..', 'src');
    // Comments discuss `new Pool(...)` precisely because it is the thing not to do.
    const code = (rel: string): string =>
      readFileSync(join(src, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

    const offenders = [
      'panel-owner.ts',
      'migrate.ts',
      join('modules', 'panel', 'panel.repository.ts'),
      join('modules', 'stock', 'stock.repository.ts'),
      join('modules', 'serial', 'serial.repository.ts'),
    ].filter((rel) => /new Pool\s*\(/.test(code(rel)));

    expect(offenders, 'must call createPool(config) — a Pool built from DATABASE_URL discards PGPASSWORD_FILE').toEqual(
      [],
    );
    // The helper itself still constructs one, so a passing check above means something.
    expect(code(join('core', 'plugins', 'postgres.ts'))).toMatch(/new Pool\s*\(/);
  });
});
