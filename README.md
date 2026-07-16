# GameApi

A generic, high-concurrency HTTP resource API for Roblox games. Many game servers call it
concurrently; every mutation is atomic and exactly-once. First module: **Limited Stock**.

- **Runtime:** TypeScript + Fastify (Node 22)
- **Datastore:** PostgreSQL — the single source of truth. Every mutation is atomic via one
  SQL statement (row-locked read-modify-write), fully typed in TS, no Lua. Redis is used
  only as the rate limiter.
- **Deploy:** Docker Compose on a dedicated VPS

> Note: `ARCHITECTURE.md` describes the original Redis-Lua-primary design; the shipped
> scaffold pivoted to **Postgres as the single source of truth** (typed SQL, zero Lua).
> This README is the accurate reference for the code.

## Quick setup (one command)

Fresh clone? Run the bootstrap script — it checks Node, installs dependencies, creates
`.env` from the template, and builds the project:

- **Windows:** double-click `setup.cmd` (or run `.\setup.cmd`)
- **Linux / macOS:** `./setup.sh`

Then set `API_KEYS` in the generated `.env` and start the stack — either Docker (below) or
`npm run dev`. (Production doesn't need this — the Docker image builds everything itself.)

## Quickstart (Docker)

```bash
cp .env.example .env          # then set API_KEYS to a real value
docker compose up --build     # postgres + redis + api (:3000)
```

Migrations run automatically at API boot (advisory-locked). The API listens on
`http://localhost:3000` (dev publishes the port via `docker-compose.override.yml`).

**Production** (multiple API replicas behind Caddy, no public API port):

```bash
API_REPLICAS=6 docker compose -f docker-compose.yml --profile prod up -d --build
```

The `-f docker-compose.yml` skips the dev override, so the API runs `API_REPLICAS`
replicas with no host port — Caddy discovers them via Docker DNS and load-balances. Use
`ops/deploy.sh <tag>` for a health-gated rolling deploy.

**Scaling knobs:** `API_REPLICAS` (containers behind Caddy) and/or `CLUSTER_WORKERS` (fork
N Node workers per container) to use all cores; `READ_CACHE_TTL_SECONDS` (short Redis read
cache so heavy polling skips Postgres); `POST /batch` (read many keys in one call). At high
replica counts add **PgBouncer** (transaction mode) between the API and Postgres and point
`DATABASE_URL` at it, so the replicas share a small pool of PG connections.

## Quickstart (local dev)

```bash
npm install
# point .env REDIS_URL / DATABASE_URL at local instances, then:
npm run migrate:dev           # apply SQL migrations
npm run dev                   # API with reload
```

## Authentication

Every request (except `/health`, `/ready`, `/degraded`, `/metrics`) requires an API key:

```
X-Api-Key: gk_ab12cd34ef56.<secret>
```

**Keys are per-game.** You mint them in the panel (Game → Keys); the full key is shown **once**
and only its sha256 is stored, so a lost key is replaced rather than recovered. A key is scoped
to exactly one game and to a subset of `stock:read`, `stock:write`, `serial:read`,
`serial:write` — it can never reach the panel or another game's data.

Revoking takes effect within **30 seconds** (each worker caches a resolved key in-process for
that long). There is no cross-worker invalidation, by design.

### The bootstrap key

`API_KEYS` in `.env` is a single **wildcard** key that reaches every game. It exists so games
already in production keep working while they migrate one at a time, and so you can still
authenticate during a Postgres outage. It holds the five game scopes only — never `panel:*`.

Once every game uses its own key, set `BOOTSTRAP_API_KEY_ENABLED=false`; `API_KEYS` is then not
required at all. The flag fails closed: any value other than `true`/`1`/`yes` disables it, and
the boot log says so.

### Idempotency

Mutations (`decrease`, `adjust`, `set-max`, `issue`) additionally require an idempotency key
that the game generates **once per logical action** and reuses on every retry:

```
Idempotency-Key: <^[A-Za-z0-9_-]{8,128}$>
```

## Admin panel

A web panel at **`/panel`** — sign in, browse every game, and do anything the API can do:
create/edit/delete/restore stock and serial keys, mint and revoke per-game API keys, and manage
accounts.

```bash
npm run panel:owner        # creates the owner account, prints the password ONCE
```

There is no public registration. The owner creates every account; each person changes their own
password on first sign-in. Locked out? `npm run panel:owner reset --username <name>` — the only
way back in, since there is no email flow.

Sign-in uses an `httpOnly` session cookie backed by Redis, not an API key: an API key can never
reach a panel route, and a panel session can never reach a game route. `PANEL_ORIGIN` is
required in production.

**Deleting hides a key; it does not hold it down.** A deleted stock/serial key is soft-deleted:
it reads as absent (404) and keeps its values and its ledger, and `restore` puts it back exactly
as it was. But `get-or-create` means what it says — a game calling `/get` with an `expectedStock`
**re-creates** it. So deleting is not how you retire an item: any server that boots will bring it
back. Only an owner can `purge`, which destroys the key and its history for good.

### Discord log

Each game has a **Discord log** tab: paste a webhook URL and every action a *person* takes in the
panel is posted to that channel. Actions your games take through the API are not — that is the
ledger's job, and it would flood the channel. Delivery is fire-and-forget, so the tab shows
whether it is actually landing.

### Roblox

The **Roblox** tab sends a message to your experience's live servers via Open Cloud
[MessagingService](https://create.roblox.com/docs/cloud/guides/usage-messaging). Paste the
universe ID and an Open Cloud API key scoped `universe-messaging-service:publish`, and the tab
gives you the Luau script to subscribe with.

Roblox's limits are the real constraints: a topic is ≤ 80 characters, a message ≤ 1 KiB, and a
topic can only receive `40 + 80 × (servers)` messages a minute. It is for announcements and
nudges, not a data feed. Publishing tries Open Cloud v2 (documented, still beta) and falls back
to v1 only if v2 answers as though it does not exist.

## Endpoints

**Live, auto-generated reference:** open **`GET /docs`** in a browser (machine-readable at
`GET /docs.json`). It builds itself from the registered routes — any new module/route shows
up automatically, with request-body schemas derived from the zod schemas.

Base: `/v1/games/{gameId}/stock/{stockKey}`

| Method & path | Purpose |
|---|---|
| `POST .../get` | Get current stock; get-or-create seeding `expectedStock` (sets `stock` and `max`) |
| `POST .../decrease` | Atomically subtract `amount`, clamp at 0 |
| `POST .../adjust` | Signed `delta`; clamp at 0 (floor) and at the record's `max` (ceiling) |
| `POST .../set-max` | Set the per-record ceiling `targetStockMax`; lowering clamps stock down |
| `GET .../` | Pure read (no create) |

### Examples

```bash
KEY=dev_key_change_me_min_32_chars_00000000
BASE=http://localhost:3000/v1/games/sword-sim/stock/excalibur

# get-or-create with 1000 (seeds stock=1000, max=1000)
curl -sX POST "$BASE/get" -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"expectedStock":1000}'

# a purchase of 10 (reuse the SAME Idempotency-Key on any retry)
curl -sX POST "$BASE/decrease" -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -H 'idempotency-key: purchase-abc-123' -d '{"amount":10}'

# restock +250 (caps at max)
curl -sX POST "$BASE/adjust" -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -H 'idempotency-key: restock-xyz-9' -d '{"delta":250}'

# lower the ceiling to 500 (clamps current stock down to 500 if above)
curl -sX POST "$BASE/set-max" -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -H 'idempotency-key: setmax-1' -d '{"targetStockMax":500}'

# read
curl -s "$BASE" -H "x-api-key: $KEY"
```

Every response uses the standard envelope:

```json
{ "ok": true, "data": { "...": "..." }, "meta": { "requestId": "…", "timestamp": "…" } }
```

## Serial numbers (unique numbering)

A second module issues **unique sequential numbers** (edition/serial numbers) under
`/v1/games/{gameId}/serial/{serialKey}`. Create an issuer with `POST .../get`
(`{ start?, max?, stockKey? }`), then `POST .../issue` (needs an `Idempotency-Key`) to
atomically claim the next number (exactly-once — a retry replays the same number). Three modes:

- **Infinite** — no `max`, no `stockKey`: counts up from `start` forever.
- **Capped** — `max` set: issues `start..max`, then `409 SERIAL_EXHAUSTED`.
- **Stock-linked** — `stockKey` set: each issue also decrements that stock; `0` → exhausted
  (e.g. a stock of 100 unique items → issuing a number also consumes one unit, atomically).

`GET .../serial/{serialKey}` reads state (start, next, issued, remaining); `GET .../serial`
lists all issuers. Full auto-generated reference is at `/docs`.

## Roblox client

A ready-to-use ModuleScript is in [clients/roblox/GameApiClient.lua](clients/roblox/GameApiClient.lua).
It generates the idempotency GUID once per purchase and retries safely.

## Adding a new resource module

Drop `src/modules/<name>/` with the 4-part shape (`schemas` → `routes` → `service` →
`repository`), its own `lua/` and `sql/`, then add it to `MODULES` in [src/app.ts](src/app.ts).
Autoloaded migrations pick up its `sql/`. No other core changes.

## Scripts

| Script | What |
|---|---|
| `npm run dev` | API with reload (tsx) |
| `npm run build` | Clean + compile to `dist/` + copy `.sql` assets |
| `npm run migrate` / `migrate:dev` | Apply SQL migrations |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (Vitest) |

## Concurrency & idempotency

Postgres is the single source of truth. Each mutation is an atomic, row-locked
read-modify-write in one SQL statement (`GREATEST(0, current - $1)` under `FOR UPDATE`), so
concurrent servers on the same stock key never oversell. Retries are exactly-once via the
ledger `UNIQUE(game_id, stock_key, event_id)`: a retried `decrease` replays the stored
result instead of applying twice, and a key reused with a different body is rejected
(`422 IDEMPOTENCY_KEY_REUSED`). If Postgres is unavailable a mutation returns
`503 SERVICE_UNAVAILABLE` (retriable) — the Roblox client retries automatically.
