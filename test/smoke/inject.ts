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

  // auto docs (public)
  results.push(await run('docs html page -> 200', { method: 'GET', url: '/docs' }, 200));
  results.push(await run('docs.json -> 200', { method: 'GET', url: '/docs.json' }, 200));
  const dj = await app.inject({ method: 'GET', url: '/docs.json' });
  const catalog = JSON.parse(dj.body);
  const decrease = catalog.data?.endpoints?.find(
    (e: { method: string; path: string }) => e.method === 'POST' && e.path.endsWith('/stock/:stockKey/decrease'),
  );
  const okDocs = Boolean(
    decrease &&
      decrease.idempotency === true &&
      decrease.auth === true &&
      decrease.body &&
      decrease.requestExample &&
      typeof decrease.roblox === 'string',
  );
  console.log(`[${okDocs ? 'PASS' : 'FAIL'}] docs.json auto-lists POST decrease (auth+idempotency+schema+example+roblox)`);
  results.push(okDocs);

  const batch = catalog.data?.endpoints?.find(
    (e: { method: string; path: string }) => e.method === 'POST' && e.path.endsWith('/stock/batch'),
  );
  console.log(`[${batch ? 'PASS' : 'FAIL'}] docs.json lists POST /batch (batch read)`);
  results.push(Boolean(batch));

  const listEp = catalog.data?.endpoints?.find(
    (e: { method: string; path: string }) => e.method === 'GET' && /\/stock$/.test(e.path),
  );
  console.log(`[${listEp ? 'PASS' : 'FAIL'}] docs.json lists GET /stock (list all registered)`);
  results.push(Boolean(listEp));

  const gamesEp = catalog.data?.endpoints?.find(
    (e: { method: string; path: string }) => e.method === 'GET' && e.path === '/v1/games',
  );
  console.log(`[${gamesEp ? 'PASS' : 'FAIL'}] docs.json lists GET /v1/games (list all games)`);
  results.push(Boolean(gamesEp));

  await app.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
