// Boots the real app in-process (no network) and exercises the HTTP pipeline without a
// live Redis/Postgres. Proves routing, auth, rate-limit fail-open, validation, guards,
// readiness, and the error envelope. The datastore happy path needs `docker compose up`.
import { loadConfig } from '../../src/config/env';
import { buildApp } from '../../src/app';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = await buildApp(cfg);
  const KEY = cfg.apiKeys[0];
  // With BOOTSTRAP_API_KEY_ENABLED=false there is no .env key at all — the end state of the
  // per-game key migration. The unauthenticated checks still mean something there, so skip
  // the keyed ones rather than asserting against `undefined`.
  const authed = cfg.env.BOOTSTRAP_API_KEY_ENABLED && KEY !== undefined;
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
  // A malformed key is rejected by shape alone — no store queries Postgres for it.
  results.push(await run('get with a malformed api key -> 401', { method: 'POST', url: `${base}/get`, headers: { ...json, 'x-api-key': 'not-a-real-key' }, payload: { expectedStock: 1000 } }, 401));
  // A well-formed gk_ key needs a lookup, and Postgres is down here. 503, never 401: we cannot
  // tell "no such key" from "cannot check", and 401 would strand a caller holding a valid key.
  results.push(await run('get with a well-formed gk_ key, postgres down -> 503', { method: 'POST', url: `${base}/get`, headers: { ...json, 'x-api-key': `gk_aaaaaaaaaaaa.${'b'.repeat(43)}` }, payload: { expectedStock: 1000 } }, 503));
  if (authed) {
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
  }
  // auth runs before routing, so an UNauthenticated unknown route is 401 (no route oracle);
  // an authenticated unknown route reaches the notFound handler -> 404.
  results.push(await run('unknown route without key -> 401', { method: 'GET', url: '/nope' }, 401));
  if (authed) {
    results.push(await run('unknown route with key -> 404', { method: 'GET', url: '/nope', headers: { 'x-api-key': KEY } }, 404));
  }

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

  const issueEp = catalog.data?.endpoints?.find(
    (e: { method: string; path: string; idempotency?: boolean }) =>
      e.method === 'POST' && e.path.endsWith('/serial/:serialKey/issue') && e.idempotency === true,
  );
  console.log(`[${issueEp ? 'PASS' : 'FAIL'}] docs.json lists POST serial /issue (idempotent)`);
  results.push(Boolean(issueEp));

  // ---- panel ----
  results.push(await run('panel /auth/me without a cookie -> 401', { method: 'GET', url: '/v1/panel/auth/me' }, 401));
  if (authed) {
    // THE load-bearing assertion of the whole panel design: the key that sits in every Roblox
    // script must not reach the control plane. requireScope alone cannot enforce this — only
    // the cookie path sets req.panel, and the panel gate refuses anything without it.
    results.push(
      await run(
        'panel /auth/me WITH a valid x-api-key -> still 401',
        { method: 'GET', url: '/v1/panel/auth/me', headers: { 'x-api-key': KEY } },
        401,
      ),
    );
  }
  // The public catalogue must not enumerate the admin API.
  const panelLeak = (catalog.data?.endpoints ?? []).filter((e: { path: string }) => e.path.startsWith('/v1/panel'));
  console.log(`[${panelLeak.length === 0 ? 'PASS' : 'FAIL'}] docs.json does not list any /v1/panel route (${panelLeak.length} found)`);
  results.push(panelLeak.length === 0);

  // serial issue requires an Idempotency-Key
  if (authed) {
    results.push(
      await run(
        'serial issue without idem key -> 400',
        { method: 'POST', url: '/v1/games/sword-sim/serial/ed/issue', headers: { 'x-api-key': KEY } },
        400,
      ),
    );
  }

  await app.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
