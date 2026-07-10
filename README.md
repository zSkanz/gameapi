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
`http://localhost:3000`.

## Quickstart (local dev)

```bash
npm install
# point .env REDIS_URL / DATABASE_URL at local instances, then:
npm run migrate:dev           # apply SQL migrations
npm run dev                   # API with reload
```

## Authentication

Every request (except `/health`, `/ready`, `/degraded`, `/metrics`) requires the API key:

```
X-Api-Key: <one of API_KEYS>
```

Mutations (`decrease`, `adjust`, `set-max`) additionally require an idempotency key that the
game generates **once per logical action** and reuses on every retry:

```
Idempotency-Key: <^[A-Za-z0-9_-]{8,128}$>
```

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
