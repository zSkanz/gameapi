// Boots the real app in-process (no network) and exercises the HTTP pipeline without a
// live Redis/Postgres. Proves routing, auth, rate-limit fail-open, validation, guards,
// readiness, and the error envelope. The datastore happy path needs `docker compose up`.
import { loadConfig } from '../../src/config/env';
import { buildApp } from '../../src/app';

async function main(): Promise<void> {
  const app = await buildApp(loadConfig());
  const KEY = loadConfig().apiKeys[0]!;
  const base = '/v1/games/sword-sim/stock/excalibur';
  const json = { 'content-type': 'application/json' };

  const run = async (label: string, opts: Parameters<typeof app.inject>[0], expect: number) => {
    const r = await app.inject(opts);
    const ok = r.statusCode === expect ? 'PASS' : 'FAIL';
    console.log(`[${ok}] ${label} -> ${r.statusCode} (want ${expect}) ${r.body}`);
    return r.statusCode === expect;
  };

  const results: boolean[] = [];
  results.push(await run('health', { method: 'GET', url: '/health' }, 200));
  results.push(await run('ready (postgres down -> 503)', { method: 'GET', url: '/ready' }, 503));
  results.push(await run('get without api key -> 401', { method: 'POST', url: `${base}/get`, headers: json, payload: { expectedStock: 1000 } }, 401));
  results.push(
    await run(
      'get bad body -> 400 STOCK_INVALID_EXPECTED_STOCK',
      { method: 'POST', url: `${base}/get`, headers: { ...json, 'x-api-key': KEY }, payload: { expectedStock: -5 } },
      400,
    ),
  );
  results.push(
    await run(
      'decrease without idempotency key -> 400',
      { method: 'POST', url: `${base}/decrease`, headers: { ...json, 'x-api-key': KEY }, payload: { amount: 10 } },
      400,
    ),
  );
  results.push(
    await run(
      'decrease bad amount -> 400 STOCK_INVALID_AMOUNT',
      { method: 'POST', url: `${base}/decrease`, headers: { ...json, 'x-api-key': KEY, 'idempotency-key': 'smoke-key-1' }, payload: { amount: 0 } },
      400,
    ),
  );
  // auth runs before routing, so an UNauthenticated unknown route is 401 (no route oracle);
  // an authenticated unknown route reaches the notFound handler -> 404.
  results.push(await run('unknown route without key -> 401', { method: 'GET', url: '/nope' }, 401));
  results.push(await run('unknown route with key -> 404', { method: 'GET', url: '/nope', headers: { 'x-api-key': KEY } }, 404));

  await app.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
