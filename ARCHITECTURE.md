# GameApi — Final Architecture

> ⚠️ **Implementation pivot (2026-07-10).** The shipped scaffold does **not** follow the
> Redis-Lua-primary design below. To keep the whole codebase strongly typed (no Lua), it
> uses **PostgreSQL as the single source of truth**: every mutation is atomic via one
> row-locked SQL statement, idempotency lives in the ledger `UNIQUE(game_id, stock_key,
> event_id)`, and Redis is reduced to the rate limiter. Consequently the Redis Lua scripts
> (§8), the outbox/consumer + rehydration (§9), and the Redis fail-open path (§10) are
> **not implemented** — a Postgres outage simply returns a retriable 503. The endpoint
> contracts (§7), idempotency semantics (§6) and response envelope (§11) still hold. Auth (§5)
> became per-game keys minted in an admin panel, and modules have no service layer and no `lua/`
> (§12 does not hold). **`README.md` is the accurate reference for the code.**
> This document is kept for the design rationale and the trade-offs that led here.

> A generic, modular, high-concurrency HTTP resource API for Roblox games. First module: **Limited Stock**. This document is the single canonical specification. Where the six exploratory designs disagreed (route shape, Redis value type, idempotency, numeric bounds, config library), the conflict is resolved **once, here**, and every later section assumes those resolutions. Adversarial-review findings are folded directly into the design rather than listed.

---

## Table of Contents

1. [Overview & Goals](#1-overview--goals)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Tech Stack & Rationale](#3-tech-stack--rationale)
4. [Request Lifecycle](#4-request-lifecycle)
5. [Authentication & Security](#5-authentication--security)
6. [Idempotency & Retry Safety](#6-idempotency--retry-safety)
7. [Stock Module — Endpoint Contracts](#7-stock-module--endpoint-contracts)
8. [Concurrency & Atomicity](#8-concurrency--atomicity)
9. [Data Model](#9-data-model)
10. [Failure Modes & Degradation](#10-failure-modes--degradation)
11. [Standard Response Envelope & Error Model](#11-standard-response-envelope--error-model)
12. [Project Structure & Module Pattern](#12-project-structure--module-pattern)
13. [Configuration & Env Vars](#13-configuration--env-vars)
14. [Observability](#14-observability)
15. [Deployment](#15-deployment)
16. [Roblox Integration](#16-roblox-integration)
17. [Testing Strategy](#17-testing-strategy)
18. [Roadmap & Open Questions](#18-roadmap--open-questions)

---

## 0. Frozen Decisions (read this first)

These resolve the cross-dimension contradictions the reviews flagged. Everything downstream obeys them.

| Concern | Decision | Why |
|---|---|---|
| **Route identity** | `gameId` and `stockKey` live in the **URL path**: `/v1/games/{gameId}/stock/{stockKey}/{action}`. Operation inputs (`amount`, `delta`, `expectedStock`) live in the **JSON body**. | Middleware (auth scope-check, rate limit, metrics, routing) runs without parsing the body; storage namespaces cleanly by `gameId:stockKey`. |
| **Redis value type** | A **Hash** per key with fields `stock` (int64), `max` (int64, per-record ceiling), `ver` (monotonic int64), `updated_ms`. Arithmetic uses `HINCRBY`/guarded `HSET` (native int64, exact). Never bare-`SET` arithmetic. | The monotonic `ver` makes the async Postgres projection convergent and idempotent; `HINCRBY` avoids the Lua `%.14g` / 2⁵³ float-corruption trap. Per-record `max` lets `adjust`/`set-max` clamp at a ceiling owned by the key, not a global constant. |
| **Idempotency** | **Mandatory** on `decrease` and `adjust`. The dedupe record is written **inside the same atomic Lua script** as the counter mutation. One layer only. `eventId == Idempotency-Key`. | Closes the crash-gap a separate HTTP cache leaves; a retried request either runs once or replays the stored result. No `in_progress`/409 state, no double-decrement. |
| **Outbox trimming** | Hot-path `XADD` **never** trims (`MAXLEN` removed). The consumer trims with `XTRIM MINID` only after `XACK`. | `MAXLEN` trims by position, silently discarding un-consumed events during a consumer stall — permanent audit loss + later oversell. |
| **Consumer** | Idempotent: `INSERT ... ON CONFLICT (event_id) DO NOTHING`, snapshot upsert guarded by `WHERE version < EXCLUDED.version`, `XAUTOCLAIM` the PEL each loop, `XACK` after commit. | Redis Streams are at-least-once; without these guards redelivery duplicates rows and can regress the snapshot. |
| **Rehydration** | **Reconcile-or-refuse** (Redis **up**, key cold). A cold/lost key is only reseeded from a Postgres baseline that is proven caught-up (or rebuilt from `initial + Σapplied` over the ledger). If it cannot be proven, mutations **fail closed** (503). A full Redis **outage** does not hit this path — it takes the Postgres fail-open fallback (see Datastore errors / [§10.1](#101-postgres-fallback-redis-down-sell-path)), not a 503. | Trusting a lagging async snapshot resurrects already-sold units (oversell of a money counter). |
| **Numeric bounds** | Single shared constants: `MAX_STOCK = 1_000_000_000`. `amount ∈ [1, MAX_STOCK]`, `delta ∈ [-MAX_STOCK, MAX_STOCK] \ {0}`, `expectedStock ∈ [0, MAX_STOCK]`. All < 2⁵³. Per-record `max ∈ [0, MAX_STOCK]`; `targetStockMax ∈ [0, MAX_STOCK]`. `adjust` caps positives at the key's `max`, not at `MAX_STOCK`. | One constants module feeds both Zod schemas and Lua guards; no divergent limits. |
| **Readiness gating** | `/ready` (the proxy routing gate) depends on **Redis only**. Postgres health is a separate `degraded` alert signal, never a reason to pull a replica from rotation. | Postgres is off the hot path (write-behind); a PG outage must not black out the Redis-served stock path. |
| **Datastore errors** | Genuine bugs → 500. Validation/auth failures behave normally. BUT for the **stock hot path** (`decrease`/`adjust`/`get`), a Redis outage does **not** 503 — it **fails OPEN to a Postgres atomic fallback** so sales continue (product-owner mandate). Idempotency preserved via the ledger `UNIQUE(game_id,stock_key,event_id)`. | Owner rule: selling must not stop when Redis is down. Accepted trade-off: fallback runs on the write-behind snapshot, so a small oversell of the un-flushed tail is possible; the system re-converges via reconcile-rehydrate on Redis recovery. |
| **Config / validation** | One **Zod** config module; one `*_FILE` secret loader resolved before validation; fail-fast at boot. | Removes the TypeBox-vs-Zod and `API_KEY`-vs-`API_KEYS` split. |

---

## 1. Overview & Goals

GameApi is a shared HTTP backend consumed **concurrently by many Roblox game servers** (server-side Lua via `HttpService`). It exposes atomic, race-free resource operations behind a single API key today, designed to grow into per-game scoped keys with zero rework.

**First module — Limited Stock:**

- `decrease(amount)` — atomically subtract, **clamp at 0** (never negative), report how much was actually applied and the resulting value.
- `adjust(delta)` — signed raise/lower, clamp at 0 on negatives, cap at the per-record `max` on positives (the key's own ceiling, not the global `MAX_STOCK`).
- `set-max(targetStockMax)` — set the per-record ceiling; if the new ceiling is below current stock, clamp stock down to it; raising it never refills.
- `get(expectedStock?)` — return current stock; **atomic get-or-create** seeding `expectedStock` (into both `stock` and `max`) if the key does not exist.

**Non-negotiable goals**

1. **Correctness under concurrency** — many servers hitting the same `stockKey` never oversell.
2. **Exactly-once mutations** — a Roblox retry after a lost response never double-applies.
3. **Low latency** — the purchase hot path is Redis-only; Postgres is asynchronous.
4. **Durability & audit** — Postgres is the durable source of truth + append-only ledger.
5. **Modularity** — new resource systems (leaderboards, cooldowns, counters) drop in through the same generic core.
6. **Operability on one VPS** — Docker Compose, multiple Node workers, near-zero-downtime deploys, tested backups.

---

## 2. High-Level Architecture

```
                       Internet (Roblox HttpService, server-side Lua)
                                        │  HTTPS 443
                                 ┌──────▼───────┐
                                 │    Caddy     │  auto-TLS, LB (least_conn),
                                 │  reverse px  │  retries, /ready health gate
                                 └──────┬───────┘   (ONLY service bound to host)
                    frontend net        │  dynamic DNS upstream → api:3000
              ┌───────────────┬─────────┴─────────┬───────────────┐
          ┌───▼───┐       ┌───▼───┐           ┌───▼───┐   deploy.replicas ≈ vCPU
          │ api-1 │       │ api-2 │    ...     │ api-N │   Fastify, single-thread,
          └───┬───┘       └───┬───┘           └───┬───┘   non-root, stateless
              └───────────────┴───backend net─────┴───────────────┐
                       │ (internal: no egress)                     │
               ┌───────▼────────┐                        ┌─────────▼─────────┐
               │     Redis      │  authoritative live    │    PostgreSQL     │
               │ Hash counters  │  counters + idem +     │ durable truth +   │
               │ + outbox stream│  rate-limit buckets    │ ledger + snapshot │
               │ AOF everysec   │  (maxmemory+noevict)   │ WAL archiving     │
               └───────┬────────┘                        └─────────┬─────────┘
                       │  XREADGROUP (outbox)                      │
                 ┌─────▼──────┐   idempotent, version-guarded      │
                 │ outbox-    │────────────────────────────────────┘
                 │ consumer   │   ledger insert + snapshot upsert, then XACK+XTRIM
                 └────────────┘
                       │
                 ┌─────▼──────┐
                 │ pg-backup  │  pg_dump + WAL → rclone offsite (3-2-1)
                 └────────────┘
```

**Authority model:** Redis holds the *live* value (linearizable per key via single-threaded Lua). Postgres is a *lagging, convergent projection* fed by a transactional outbox — off the hot path, used for durability, audit, and recovery.

---

## 3. Tech Stack & Rationale

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | **Node.js 22 + TypeScript** | Fits Roblox HTTP integration ergonomics; strong ecosystem. |
| HTTP | **Fastify 5** | Fast, schema-first, plugin/decorator DI, `onRequest`/`preHandler`/`onSend` hook pipeline. |
| Validation & types | **Zod** + `fastify-type-provider-zod` | Single source of truth for validation, serialization, and TS types; no drift. |
| Hot store | **Redis 7** (`ioredis`) | Single-threaded Lua = serializable per-key atomicity; sub-ms mutations. |
| Durable store | **PostgreSQL 16** (`pg`) | Durable truth + append-only audit + recovery snapshot. |
| Reverse proxy | **Caddy 2** | Auto-HTTPS, dynamic Docker DNS upstreams, health-gated LB. |
| Deploy | **Docker Compose** on one VPS + `docker-rollout` | Multiple worker replicas, near-zero-downtime rolling deploys. |

Fixed by mandate; not reconsidered.

---

## 4. Request Lifecycle

Example: a player buys, game calls `POST /v1/games/sword-sim/stock/excalibur/decrease`.

```
Roblox HttpService:RequestAsync (POST, X-Api-Key, Idempotency-Key, {amount:10})
  │
  ▼ Caddy: TLS terminate → route to a healthy api replica (retries next on failure)
  │
  ▼ Fastify onRequest:  genReqId (X-Request-Id echoed)
  ▼ Fastify onRequest:  AUTH  — resolve X-Api-Key → Principal; check path.gameId ∈ allowedGameIds
  ▼ Fastify onRequest:  RATE LIMIT — per-key + per-game token buckets (Redis Lua, redis TIME)
  ▼ Fastify preValidation: Zod validates path params + body (amount ∈ [1, MAX_STOCK])
  ▼ Fastify preHandler:  require + format-check Idempotency-Key (mandatory on mutations)
  │
  ▼ Handler → StockService.decrease(gameId, stockKey, amount, idemKey, principal)
  │     → StockRepository → single EVALSHA:  decrease.lua
  │           KEYS = [counterHash, outboxStream, idemRecord]   (same hash slot)
  │           · replay?  return stored {applied, resulting}   ← exactly-once
  │           · missing? return 'no_key' → reconcile-rehydrate, retry once, else 404
  │           · Redis outage? → FAIL OPEN to Postgres atomic fallback (still exactly-once)
  │           · else: clamp, HINCRBY, write idem record, XADD outbox — all atomic
  │
  ▼ Map Lua reply → data envelope; onSend adds security headers
  ▼ 200 { ok:true, data:{ requested, decremented, stock, clamped }, meta }
  │
  ⋯ asynchronously: outbox-consumer drains stream → stock_ledger + stock_snapshot (Postgres)
```

On a Redis **outage** mid-path the stock handler **fails OPEN** to the Postgres atomic fallback ([§10.1](#101-postgres-fallback-redis-down-sell-path)) — still exactly-once via the ledger `UNIQUE(game_id, stock_key, event_id)` constraint — so the sale proceeds rather than 503ing (product-owner mandate). Only genuine bugs return **5xx**; validation/auth failures behave normally.

---

## 5. Authentication & Security

### 5.1 Principle

Every request except `/health` and `/ready` requires `X-Api-Key`. A `Principal` abstraction lets the single `.env` key of today become per-game scoped keys tomorrow with **zero route/handler changes** — handlers already validate the path `gameId` against the principal.

```ts
// src/core/auth/principal.ts
export interface Principal {
  keyId: string;                    // "env:primary" today; "gk_ab12cd" from DB later
  allowedGameIds: '*' | string[];   // '*' for the single global key today
  scopes: '*' | string[];           // e.g. ['stock:read','stock:write']; '*' today
}

export interface ApiKeyStore {
  resolve(rawKey: string): Promise<Principal | null>;
}
```

### 5.2 Constant-time verification (today: env key)

Both the presented key and each stored key are reduced to a fixed 32-byte SHA-256 digest, then compared with `timingSafeEqual`. Hashing first guarantees equal length (avoids the throw + length leak) and we iterate **all** candidates without early-return so loop time never reveals a match. `API_KEYS` is comma-separated so a key rotates with zero downtime (add new, deploy, remove old).

```ts
// src/core/auth/env-store.ts
import { createHash, timingSafeEqual } from 'node:crypto';
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest();

export class EnvApiKeyStore implements ApiKeyStore {
  private records: { keyId: string; digest: Buffer }[];
  constructor(apiKeysCsv: string) {
    this.records = apiKeysCsv.split(',').map((raw, i) => ({
      keyId: `env:${i === 0 ? 'primary' : i}`,
      digest: sha256(raw.trim()),
    }));
  }
  async resolve(rawKey: string): Promise<Principal | null> {
    const presented = sha256(rawKey);
    let matched: string | null = null;
    for (const r of this.records) {                       // no early break
      if (r.digest.length === presented.length && timingSafeEqual(r.digest, presented)) {
        matched = r.keyId;
      }
    }
    if (!matched) return null;
    return { keyId: matched, allowedGameIds: '*', scopes: '*' }; // wildcard while single-key
  }
}
```

### 5.3 Auth hook + scope guard

```ts
// src/core/plugins/auth.ts (onRequest)
app.addHook('onRequest', async (req, reply) => {
  if (req.routeOptions.config?.public) return;            // /health, /ready
  const raw = req.headers['x-api-key'];
  if (typeof raw !== 'string' || raw.length === 0) throw Errors.unauthenticated();
  const principal = await app.apiKeys.resolve(raw);
  if (!principal) throw Errors.unauthenticated();          // identical 401 for missing & invalid

  const gameId = (req.params as any).gameId as string | undefined;
  if (gameId && principal.allowedGameIds !== '*' && !principal.allowedGameIds.includes(gameId)) {
    throw Errors.forbidden();                              // per-game key touching another game
  }
  req.principal = principal;
});

// per-route preHandler
export const requireScope = (scope: string) => async (req: FastifyRequest) => {
  const s = req.principal!.scopes;
  if (s !== '*' && !s.includes(scope)) throw Errors.forbidden();
};
```

### 5.4 Multi-key auth — SHIPPED

Wire format `gk_<keyId>.<secret>`, and the forward path described here is now the live one:
`DbApiKeyStore` does an O(1) primary-key lookup on the public `keyId` and returns a real
`allowedGameIds`/`scopes`. Two details differ from what was planned here, both deliberate:

- **sha256, not argon2id.** `resolve()` runs on every request from every Roblox server, and the
  secret is 32 CSPRNG bytes — there is no dictionary for a KDF to slow down, while a KDF here
  caps a worker at roughly 34 req/s. Panel passwords are the opposite problem and do use scrypt.
  See `src/core/auth/key-format.ts`.
- **The separator is a dot.** Both halves are base64url, whose alphabet contains `_` — so
  splitting on the last `_` corrupts about half of all generated keys.

Never plaintext, prefix + digest only. The bootstrap `.env` key remains as a wildcard behind
`BOOTSTRAP_API_KEY_ENABLED`. Real DDL: `src/core/db/sql/`.

### 5.5 Rate limiting (atomic, cross-worker, single clock)

Two token buckets per request — **per-key** and **per-game** (fairness so one game's fleet cannot starve others) — evaluated in Redis via Lua so all workers share the counter. The script uses `redis.call('TIME')` (a single clock), **not** a per-worker `Date.now()`, eliminating clock-skew refill corruption. Denied if either bucket is empty → `429 RATE_LIMITED` + `Retry-After`. `tier` selects capacity for premium games later.

```lua
-- rate_limit.lua   KEYS[1]=bucket hash
-- ARGV[1]=capacity  ARGV[2]=refillPerSec  ARGV[3]=cost
-- returns { allowed, remaining, resetMs }
local t = redis.call('TIME')                       -- {sec, usec} — single Redis clock
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local cap    = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost   = tonumber(ARGV[3])
local d = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens, ts = tonumber(d[1]), tonumber(d[2])
if tokens == nil then tokens, ts = cap, now end
tokens = math.min(cap, tokens + math.max(0, now - ts) / 1000.0 * refill)
local allowed = 0
if tokens >= cost then allowed = 1; tokens = tokens - cost end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / refill * 1000) + 1000)
return { allowed, math.floor(tokens), math.ceil((cap - tokens) / refill * 1000) }
```

### 5.6 Other hardening

- `bodyLimit` 16 KB (payloads are tiny); Caddy `request_body max_size 16KB` as outer guard.
- `Content-Type: application/json` enforced by the parser.
- pino logger **redacts** `x-api-key`/`authorization`; secrets never hit logs.
- Uniform sanitized error envelope, `X-Request-Id` on every response; internal detail stays in logs.
- Security headers (`X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, HSTS at Caddy).
- **Interim tenant isolation:** while a single global key is used, the path `gameId` is authoritative but the key is not yet scoped — validate `gameId` against a provisioned allowlist (from `game` table) so a leaked key cannot address an arbitrary namespace, and enforce a **per-game max-distinct-keys quota** at create time so one tenant cannot exhaust Redis memory (noisy-neighbor DoS).

---

## 6. Idempotency & Retry Safety

### 6.1 The threat

`HttpService:RequestAsync` **retries on timeout** — including a timeout that occurred *after* the decrement committed but *before* the HTTP response arrived. A naive retry double-decrements a money-adjacent counter. Proxies can also replay.

### 6.2 The guarantee

**`Idempotency-Key` is MANDATORY on `decrease` and `adjust`** (rejected with `400 IDEMPOTENCY_KEY_REQUIRED` in `preHandler` before any mutation; format `^[A-Za-z0-9_-]{8,128}$`). The dedupe record is written **inside the same atomic Lua script** as the counter change. There is exactly **one** layer (no colliding second HTTP-cache layer). Because Redis runs the script to completion single-threaded, a concurrent or retried request either:

- finds **no record** → executes once, stores `{applied, resulting, existed}`, returns fresh result; or
- finds a **completed record** → returns the stored `{applied, resulting}` **without re-applying**, and **without emitting a second outbox event**.

There is no `in_progress` state and therefore no 409-strand-after-crash: a crash between the atomic commit and the HTTP response leaves a *completed* idem record, so the retry replays the authoritative answer.

### 6.3 Record shape & namespacing

The idem record key and the request fingerprint both include the **resolved resource address** (`gameId`, `stockKey`, action) — not the Fastify route template — so two decreases with the same `amount` on *different* stock keys can never collide.

```
Key:  gapi:v1:{sh:NN}:idem:{gameId}:{stockKey}:decrease:{idemKey}   (same hash slot as counter)
Hash: fp        sha256(gameId "\n" stockKey "\n" action "\n" canonicalJSON(body))
      applied   actual change applied
      resulting resulting stock
      existed   1 | 0
TTL:  IDEMPOTENCY_TTL_SECONDS = 86400  (well above the Roblox retry horizon)
```

A **fingerprint mismatch** on the same key (client accidentally reused one key for a different op) returns `422 IDEMPOTENCY_KEY_REUSED` instead of a wrong cached answer. The idem keyspace lives under `maxmemory-policy noeviction` and shares Redis's AOF fate with the counter, so a record cannot be evicted inside its window while the counter survives.

### 6.4 Client contract (enforced by shipped wrapper)

The game generates the GUID **once per logical purchase, outside the retry loop**, and reuses it on every attempt. This is the one client rule; the shipped Lua ModuleScript ([§16](#16-roblox-integration)) encodes it correctly. A soft server-side guard alerts when many *distinct* idem keys arrive for identical `(gameId, stockKey, body, source-IP)` within seconds — the signature of a client regenerating the key per attempt.

### 6.5 Ledger-level assertion

The outbox `event_id == Idempotency-Key`. The ledger enforces `UNIQUE (game_id, stock_key, event_id)`; if the same purchase key ever appears with two *distinct* stream events, that is a true double-apply (distinct from harmless stream redelivery, which reuses the event id) and pages an operator. The audit layer can thus *detect* a double-apply rather than faithfully mirror one. During a Redis outage the Postgres fail-open fallback ([§10.1](#101-postgres-fallback-redis-down-sell-path)) reuses this same `UNIQUE (game_id, stock_key, event_id)` constraint (the Idempotency-Key is the `event_id`) to claim the slot, so a retried decrease still applies exactly once and never double-applies.

---

## 7. Stock Module — Endpoint Contracts

Base URL: `https://api.<domain>/v1`. All actions are `POST` (Roblox always uses `RequestAsync` with a body; one code path). Generic module grammar:

```
/v1/games/{gameId}/{module}/{resourceKey}/{action}
```

Path params (validated in middleware, else `VALIDATION_ERROR`):

| Param | Regex |
|---|---|
| `gameId` | `^[A-Za-z0-9:_.\-]{1,64}$` |
| `stockKey` | `^[A-Za-z0-9:_.\-]{1,128}$` (`HttpService:UrlEncode` is a no-op for this charset) |

Headers:

| Header | Required | Purpose |
|---|---|---|
| `X-Api-Key` | yes (all but health) | Auth |
| `Idempotency-Key` | **yes** on `decrease`/`adjust` | Exactly-once |
| `X-Request-Id` | optional | Correlation; generated + echoed if absent |

### 7.1 `POST .../stock/{stockKey}/decrease`

Atomically subtract, clamp at 0. Requires an initialized key.

Request body:
```json
{ "type":"object", "additionalProperties":false, "required":["amount"],
  "properties": { "amount": { "type":"integer", "minimum":1, "maximum":1000000000 } } }
```
Success `200`:
```json
{ "ok": true,
  "data": { "gameId":"sword-sim", "stockKey":"excalibur",
            "requested":10, "decremented":5, "stock":0, "clamped":true },
  "meta": { "requestId":"req_01J8Z...", "timestamp":"2026-07-10T18:24:11.204Z" } }
```
Status: `200` · `400 IDEMPOTENCY_KEY_REQUIRED` / `STOCK_INVALID_AMOUNT` · `401` · `403` · `404 STOCK_KEY_NOT_FOUND` · `422 IDEMPOTENCY_KEY_REUSED` · `429` · `503`.

### 7.2 `POST .../stock/{stockKey}/adjust`

Signed delta; clamp at 0 on negatives, cap at the per-record `max` field on positives (the key's own ceiling, **not** the global `MAX_STOCK`) — returns a flag, not an error. Requires an initialized key (**no auto-create** — matches the single creation path).

Request body:
```json
{ "type":"object", "additionalProperties":false, "required":["delta"],
  "properties": { "delta": { "type":"integer", "minimum":-1000000000, "maximum":1000000000,
                             "not": { "const":0 } } } }
```
Success `200` (`capped` is `true` only when the result hit the floor `0` or the ceiling `max`):
```json
{ "ok": true,
  "data": { "gameId":"sword-sim", "stockKey":"excalibur",
            "delta":250, "applied":250, "stock":250, "max":1000, "clamped":false, "capped":false },
  "meta": { "requestId":"req_01J8Z...", "timestamp":"..." } }
```
Status: `200` · `400 IDEMPOTENCY_KEY_REQUIRED` / `STOCK_INVALID_DELTA` · `404 STOCK_KEY_NOT_FOUND` · `401/403/422/429/503`.

### 7.3 `POST .../stock/{stockKey}/get` (get-or-create)

Returns current stock. If missing and `expectedStock` is provided, atomically **write-through** creates it (Postgres definition first, then Redis `SET NX`). `expectedStock` is a **seed only** — never overwrites an existing value — and on create it seeds **both** `stock` and the per-record `max`.

Request body (both optional):
```json
{ "type":"object", "additionalProperties":false,
  "properties": { "expectedStock": { "type":"integer", "minimum":0, "maximum":1000000000 } } }
```
Success `200`:
```json
{ "ok": true,
  "data": { "gameId":"sword-sim", "stockKey":"excalibur", "stock":1000, "max":1000, "created":true },
  "meta": { "requestId":"req_01J8Z...", "timestamp":"..." } }
```
Rules: key exists → return, `created:false` (seed ignored). Missing + seed → create, `created:true`. Missing + no seed → `404 STOCK_KEY_NOT_FOUND`. `get` needs no `Idempotency-Key` (`SET NX` is naturally idempotent). On creation, `max` is set equal to `expectedStock`.

Status: `200` · `400 STOCK_INVALID_EXPECTED_STOCK` · `404 STOCK_KEY_NOT_FOUND` · `401/403/429/503`.

### 7.4 `GET .../stock/{stockKey}` (pure read, no create)

Dashboards/observability. `200 {gameId, stockKey, stock, max}` or `404`. `Cache-Control: no-store`.

### 7.5 `POST .../stock/{stockKey}/set-max`

Set the per-record ceiling. Requires an `Idempotency-Key` (it is a mutation). Requires an initialized key → `404 STOCK_KEY_NOT_FOUND` otherwise.

Request body:
```json
{ "type":"object", "additionalProperties":false, "required":["targetStockMax"],
  "properties": { "targetStockMax": { "type":"integer", "minimum":0, "maximum":1000000000 } } }
```
Success `200`:
```json
{ "ok": true,
  "data": { "gameId":"sword-sim", "stockKey":"excalibur",
            "max":500, "stock":500, "stockClamped":true },
  "meta": { "requestId":"req_01J8Z...", "timestamp":"..." } }
```
Rules: sets `max=targetStockMax`; if prior `stock > max`, `stock` is clamped down (`stockClamped:true`); raising the ceiling leaves `stock` untouched (`stockClamped:false`). Requires an initialized key → `404 STOCK_KEY_NOT_FOUND` otherwise.

Status: `200` · `400 IDEMPOTENCY_KEY_REQUIRED` / `STOCK_INVALID_TARGET_MAX` · `404 STOCK_KEY_NOT_FOUND` · `401/403/422/429/503`.

### 7.6 Error path examples

```json
// decrease before init → 404
{ "ok": false,
  "error": { "code":"STOCK_KEY_NOT_FOUND",
             "message":"Stock key has not been initialized. Call /get with expectedStock first.",
             "details": { "gameId":"sword-sim", "stockKey":"ghostkey" } },
  "meta": { "requestId":"req_01J8Z...", "timestamp":"..." } }
```
```json
// missing idempotency key → 400
{ "ok": false,
  "error": { "code":"IDEMPOTENCY_KEY_REQUIRED",
             "message":"decrease requires an Idempotency-Key header." },
  "meta": { "requestId":"req_01J8Z...", "timestamp":"..." } }
```

---

## 8. Concurrency & Atomicity

### 8.1 Why the Lua scripts are correct

Redis executes each `EVALSHA` script **single-threaded, run-to-completion**: between two `redis.call`s inside one script no other client command interleaves. Therefore each script is a **serializable** read-modify-write for the keys it touches. The classic TOCTOU window ("read 5, someone buys, I subtract 10") *does not exist* — the check (`applied = min(amount, cur)`) and the write (`HINCRBY`) are one non-interruptible unit. Worker count is irrelevant: all atomicity is centralized in the one Redis node.

Nuances honored in code:
- **Native int64 arithmetic** via `HINCRBY` (exact, no float rendering). Every numeric argument passed to `redis.call` is formatted with `I(n) = string.format('%d', n)` to dodge the `%.14g` scientific-notation trap. `MAX_STOCK < 2⁵³` keeps every `tonumber` intermediate exact.
- **Atomic ≠ rollback.** The only realistic mid-script error is OOM. We order **mutation before `XADD`**, keep memory headroom below `maxmemory`, and run a drift reconciler (`Σ signed applied == current_value`) that fails a drifted key closed until an operator reconciles.
- Scripts are **O(1)**. `EVALSHA` in steady state; `SCRIPT LOAD` at boot; `EVAL` fallback on `NOSCRIPT` (ioredis `defineCommand` handles this).
- The three keys (counter, outbox, idem) share one **hash-tag slot** (`{sh:NN}`), so a single script can touch all three even under future Redis Cluster.

### 8.2 `decrease.lua`

```lua
-- KEYS[1]=counter hash  KEYS[2]=outbox stream  KEYS[3]=idem record
-- ARGV[1]=amount  ARGV[2]=eventId(=idemKey)  ARGV[3]=nowMs  ARGV[4]=idemTtlSec
-- ARGV[5]=gameId  ARGV[6]=stockKey  ARGV[7]=keyId  ARGV[8]=fingerprint
-- RETURN: { status, applied, resulting }  status: replayed|ok|no_key|fp_mismatch
local function I(n) return string.format('%d', n) end

-- 1) idempotency replay (exactly-once)
local storedFp = redis.call('HGET', KEYS[3], 'fp')
if storedFp then
  if storedFp ~= ARGV[8] then return {'fp_mismatch', '0', '0'} end
  return {'replayed', redis.call('HGET', KEYS[3], 'applied'),
                      redis.call('HGET', KEYS[3], 'resulting')}
end

-- 2) require an initialized key
local raw = redis.call('HGET', KEYS[1], 'stock')
if not raw then return {'no_key', '0', '0'} end          -- caller rehydrates or 404s

-- 3) atomic clamp + decrement
local cur = tonumber(raw)
local amt = tonumber(ARGV[1])
local applied = amt; if applied > cur then applied = cur end   -- CLAMP: never below 0
local newv = cur - applied
local ver = redis.call('HINCRBY', KEYS[1], 'ver', 1)
if applied > 0 then
  redis.call('HSET', KEYS[1], 'stock', I(newv), 'updated_ms', ARGV[3])
else
  redis.call('HSET', KEYS[1], 'updated_ms', ARGV[3])
end

-- 4) durable idempotency record (committed atomically with the decrement)
redis.call('HSET', KEYS[3], 'fp', ARGV[8], 'applied', I(applied), 'resulting', I(newv))
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[4]))

-- 5) transactional outbox event (NO MAXLEN trim here)
redis.call('XADD', KEYS[2], '*',
  'eid', ARGV[2], 'op', 'decrease', 'gid', ARGV[5], 'skey', ARGV[6],
  'requested', I(amt), 'applied', I(-applied), 'newValue', I(newv),
  'ver', I(ver), 'ts', ARGV[3], 'akid', ARGV[7])

return {'ok', I(applied), I(newv)}
```

### 8.3 `adjust.lua`

```lua
-- KEYS as above. ARGV[1]=delta  ARGV[2]=eventId  ARGV[3]=nowMs  ARGV[4]=idemTtlSec
-- ARGV[5]=gameId ARGV[6]=stockKey ARGV[7]=keyId ARGV[8]=fp
-- RETURN: { status, applied, resulting, capped }  capped: 0 normal | -1 floor | 1 ceiling
local function I(n) return string.format('%d', n) end

local storedFp = redis.call('HGET', KEYS[3], 'fp')
if storedFp then
  if storedFp ~= ARGV[8] then return {'fp_mismatch','0','0','0'} end
  return {'replayed', redis.call('HGET', KEYS[3],'applied'),
                      redis.call('HGET', KEYS[3],'resulting'),
                      redis.call('HGET', KEYS[3],'capped')}
end

local raw = redis.call('HGET', KEYS[1], 'stock')
if not raw then return {'no_key','0','0','0'} end        -- NO auto-create (single creation path)

local cur   = tonumber(raw)
local delta = tonumber(ARGV[1])
local cap   = tonumber(redis.call('HGET', KEYS[1], 'max'))   -- per-record ceiling
local target = cur + delta
local capped = 0
if target < 0   then target = 0;   capped = -1 end
if target > cap then target = cap; capped =  1 end
local applied = target - cur
local ver = redis.call('HINCRBY', KEYS[1], 'ver', 1)
redis.call('HSET', KEYS[1], 'stock', I(target), 'updated_ms', ARGV[3])

redis.call('HSET', KEYS[3], 'fp', ARGV[8], 'applied', I(applied),
           'resulting', I(target), 'capped', I(capped))
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[4]))

redis.call('XADD', KEYS[2], '*',
  'eid', ARGV[2], 'op', 'adjust', 'gid', ARGV[5], 'skey', ARGV[6],
  'requested', I(delta), 'applied', I(applied), 'newValue', I(target),
  'ver', I(ver), 'ts', ARGV[3], 'akid', ARGV[7])

return {'ok', I(applied), I(target), I(capped)}
```

### 8.4 `get_or_create.lua`

Creation stores the value as the **verbatim string** via `SET NX` (never `tonumber`), so any integer ≤ `MAX_STOCK` is exact. Postgres definition is written *before* this by the repository (write-through), so a durable baseline always exists to rehydrate from.

```lua
-- KEYS[1]=counter hash  KEYS[2]=outbox stream
-- ARGV[1]=expectedStock or ''  ARGV[2]=createIfMissing("1"/"0")
-- ARGV[3]=eventId ARGV[4]=nowMs ARGV[5]=gameId ARGV[6]=stockKey ARGV[7]=keyId
-- RETURN: { value, max, created }   value = -1 sentinel when absent & no create
local function I(n) return string.format('%d', n) end

local cur = redis.call('HGET', KEYS[1], 'stock')
if cur then return { tonumber(cur), tonumber(redis.call('HGET', KEYS[1], 'max')), 0 } end
if ARGV[2] ~= '1' then return { -1, -1, 0 } end

-- create: HSETNX makes the field-create idempotent even under a race
local ok = redis.call('HSETNX', KEYS[1], 'stock', ARGV[1])   -- verbatim string, exact
if ok == 0 then
  return { tonumber(redis.call('HGET', KEYS[1], 'stock')),
           tonumber(redis.call('HGET', KEYS[1], 'max')), 0 }
end
redis.call('HSET', KEYS[1], 'max', ARGV[1], 'ver', '1', 'updated_ms', ARGV[4])  -- max seeded = expectedStock

redis.call('XADD', KEYS[2], '*',
  'eid', ARGV[3], 'op', 'create', 'gid', ARGV[5], 'skey', ARGV[6],
  'requested', ARGV[1], 'applied', ARGV[1], 'newValue', ARGV[1],
  'max', ARGV[1], 'ver', '1', 'ts', ARGV[4], 'akid', ARGV[7])

return { tonumber(ARGV[1]), tonumber(ARGV[1]), 1 }
```

### 8.5 `set_max.lua`

Sets the per-record ceiling atomically and reconciles `stock` down if the new ceiling is below it (raising the ceiling never refills). Mutation → mandatory `Idempotency-Key`; the idem record is written inside the script exactly like `decrease`/`adjust`.

```lua
-- KEYS[1]=counter hash  KEYS[2]=outbox stream  KEYS[3]=idem record
-- ARGV[1]=targetMax  ARGV[2]=eventId  ARGV[3]=nowMs  ARGV[4]=idemTtlSec
-- ARGV[5]=gameId ARGV[6]=stockKey ARGV[7]=keyId ARGV[8]=fingerprint
-- RETURN: { status, newMax, stock, stockClamped }  status: replayed|ok|no_key|fp_mismatch
local function I(n) return string.format('%d', n) end

local storedFp = redis.call('HGET', KEYS[3], 'fp')
if storedFp then
  if storedFp ~= ARGV[8] then return {'fp_mismatch','0','0','0'} end
  return {'replayed', redis.call('HGET', KEYS[3],'newMax'),
                      redis.call('HGET', KEYS[3],'resulting'),
                      redis.call('HGET', KEYS[3],'clamped')}
end

local raw = redis.call('HGET', KEYS[1], 'stock')
if not raw then return {'no_key','0','0','0'} end        -- requires an initialized key

local cur     = tonumber(raw)
local newMax  = tonumber(ARGV[1])
local stock   = cur
local clamped = 0
if stock > newMax then stock = newMax; clamped = 1 end   -- lower ceiling clamps stock down
local ver = redis.call('HINCRBY', KEYS[1], 'ver', 1)
redis.call('HSET', KEYS[1], 'max', I(newMax), 'stock', I(stock), 'updated_ms', ARGV[3])

redis.call('HSET', KEYS[3], 'fp', ARGV[8], 'newMax', I(newMax),
           'resulting', I(stock), 'clamped', I(clamped))
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[4]))

redis.call('XADD', KEYS[2], '*',
  'eid', ARGV[2], 'op', 'set_max', 'gid', ARGV[5], 'skey', ARGV[6],
  'requested', I(newMax), 'applied', I(stock - cur), 'newValue', I(stock),
  'newMax', I(newMax), 'ver', I(ver), 'ts', ARGV[3], 'akid', ARGV[7])

return {'ok', I(newMax), I(stock), I(clamped)}
```

### 8.6 Consistency model

- **Redis:** authoritative, linearizable per key. `Redis.ver ≥ PG.version` always (Redis leads).
- **Redis → Postgres:** asynchronous, at-least-once, **idempotent → effectively-once**, bounded staleness (seconds).
- **Invariant:** for each key, the highest-`version` ledger `new_value` equals `stock_snapshot.current_stock`, and `Σ signed applied == current_stock`. A scheduled reconciler asserts this and pages on drift beyond expected flush lag.

---

## 9. Data Model

### 9.1 Redis key schema

Grammar: `gapi:{ver}:{sh:NN}:{kind}:g:{gameId}:{module}:{resourceKey}`

`{sh:NN}` is the only `{}` (the Cluster hash tag), `NN = crc16(gameId ':' resourceKey) % 16`. It colocates a counter, its outbox shard, and its idem records in one slot. Harmless on single node; free future-proofing + N parallel outbox streams.

| Purpose | Key | Type | TTL |
|---|---|---|---|
| Stock counter | `gapi:v1:{sh:07}:c:g:sword-sim:stock:excalibur` | Hash `{stock,max,ver,updated_ms}` | none |
| Outbox (per shard) | `gapi:v1:{sh:07}:outbox:stock` | Stream | trimmed by MINID (consumer only) |
| Idempotency | `gapi:v1:{sh:07}:idem:g:sword-sim:stock:excalibur:decrease:<idemKey>` | Hash | 24 h |
| Rate-limit bucket | `gapi:v1:rl:key:<keyId>` / `gapi:v1:rl:game:<gameId>` | Hash | derived |

Durable modules (`stock`) are **persistent (no TTL)** — Redis holds the freshest, possibly-unflushed value; expiring it would lose committed decrements. A cold-key sweeper may drop a key **only** once its ledger is fully ACKed *and* its snapshot is current; it is then lazily reconcile-rehydrated on next touch. Redis runs `appendonly yes` + `appendfsync everysec` + RDB.

### 9.2 PostgreSQL DDL

```sql
-- ---- tenants (allowlist + FK anchor) ----
CREATE TABLE game (
  game_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',      -- active|disabled
  max_keys   INT  NOT NULL DEFAULT 10000,         -- per-game key quota (noisy-neighbor guard)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- durable definition (written WRITE-THROUGH on get-or-create) ----
CREATE TABLE stock_definition (
  game_id       TEXT   NOT NULL REFERENCES game(game_id),
  stock_key     TEXT   NOT NULL,
  initial_stock BIGINT NOT NULL CHECK (initial_stock >= 0),
  max_cap       BIGINT NOT NULL DEFAULT 1000000000 CHECK (max_cap > 0 AND max_cap <= 1000000000),  -- per-record ceiling (seeded = expectedStock, mutated by set-max)
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, stock_key)
);

-- ---- current snapshot (convergent projection) ----
CREATE TABLE stock_snapshot (
  game_id        TEXT   NOT NULL,
  stock_key      TEXT   NOT NULL,
  current_stock  BIGINT NOT NULL CHECK (current_stock >= 0),
  max_cap        BIGINT NOT NULL DEFAULT 1000000000,  -- last-applied ceiling (restored on rehydration)
  version        BIGINT NOT NULL DEFAULT 0,        -- last-applied Redis ver
  last_stream_id TEXT,                             -- last consumed outbox id (rehydrate gate)
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, stock_key),
  FOREIGN KEY (game_id, stock_key) REFERENCES stock_definition(game_id, stock_key)
);

-- ---- append-only audit ledger (partitioned) ----
CREATE TABLE stock_ledger (
  id           BIGINT GENERATED ALWAYS AS IDENTITY,
  event_id     TEXT   NOT NULL,                    -- outbox eid == Idempotency-Key
  stream_id    TEXT   NOT NULL,                    -- Redis stream entry id
  game_id      TEXT   NOT NULL,
  stock_key    TEXT   NOT NULL,
  op           TEXT   NOT NULL,                    -- decrease|adjust|create|set_max
  requested    BIGINT,
  applied      BIGINT NOT NULL,                    -- signed actual change
  new_value    BIGINT NOT NULL CHECK (new_value >= 0),
  version      BIGINT NOT NULL,
  api_key_id   TEXT,
  event_ms     BIGINT NOT NULL,
  source       TEXT   NOT NULL DEFAULT 'redis',    -- redis | pg_fallback (audits the Redis-down fail-open path)
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, recorded_at),
  UNIQUE (stream_id),                              -- dedupe stream redelivery
  UNIQUE (game_id, stock_key, event_id)            -- at-most-once purchase assertion (detects double-apply)
) PARTITION BY RANGE (recorded_at);

-- automatic partitions: pg_partman pre-creates next month + a DEFAULT catch-all
CREATE TABLE stock_ledger_default PARTITION OF stock_ledger DEFAULT;
CREATE INDEX ON stock_ledger (game_id, stock_key, version DESC);

-- ---- outbox consumer checkpoint (observability) ----
CREATE TABLE flush_checkpoint (
  module         TEXT NOT NULL,
  shard          INT  NOT NULL,
  last_stream_id TEXT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (module, shard)
);

-- ---- multi-key auth: SHIPPED, and this copy had already drifted ----
-- The real DDL lives in src/core/db/sql/ (000_core_init.sql + 003_api_keys_per_game.sql).
-- What was written here was wrong on three counts by the time it shipped: game_id is NOT NULL
-- (a per-game key is always scoped to exactly one game; the only wildcard is the .env bootstrap
-- key), `active` is gone (revoked_at is the single disable mechanism — two would drift), and
-- secret_hash is sha256, not argon2id. See src/core/auth/key-format.ts for why a KDF is wrong
-- for a 256-bit CSPRNG secret on a path that runs per request.
```

### 9.3 Outbox consumer (idempotent, version-guarded, crash-safe)

Runs as its own process. Per shard stream, a consumer group `pg-writer`.

```ts
// src/workers/outbox-consumer.ts (core loop, per shard)
for (;;) {
  // reclaim entries stranded by a crashed consumer, then read new ones
  await redis.xautoclaim(stream, GROUP, CONSUMER, 60000, '0', 'COUNT', 128).catch(() => {});
  const batch = await redis.xreadgroup('GROUP', GROUP, CONSUMER,
    'COUNT', 256, 'BLOCK', 2000, 'STREAMS', stream, '>');
  if (!batch) continue;
  const events = parse(batch);

  await pg.tx(async (tx) => {
    for (const e of events) {
      // 1) append-only audit; drop redelivery
      await tx.query(
        `INSERT INTO stock_ledger (event_id, stream_id, game_id, stock_key, op,
             requested, applied, new_value, version, api_key_id, event_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (stream_id) DO NOTHING`,
        [e.eid, e.id, e.gid, e.skey, e.op, e.requested, e.applied, e.newValue, e.ver, e.akid, e.ts]);
      // definition may not exist yet if create event is first-seen: upsert on demand
      await tx.query(
        `INSERT INTO stock_definition (game_id, stock_key, initial_stock, created_by)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [e.gid, e.skey, e.op === 'create' ? e.newValue : 0, e.akid]);
      // 2) snapshot upsert, VERSION-GUARDED (out-of-order & replay safe)
      //    (a set_max event carries newValue = the clamped stock, so current_stock is fixed here)
      await tx.query(
        `INSERT INTO stock_snapshot (game_id, stock_key, current_stock, version, last_stream_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (game_id, stock_key) DO UPDATE
           SET current_stock=EXCLUDED.current_stock, version=EXCLUDED.version,
               last_stream_id=EXCLUDED.last_stream_id, updated_at=now()
           WHERE stock_snapshot.version < EXCLUDED.version`,
        [e.gid, e.skey, e.newValue, e.ver, e.id]);
      // 3) set_max: propagate the new ceiling to definition + snapshot (version-guarded)
      if (e.op === 'set_max') {
        await tx.query(
          `UPDATE stock_definition SET max_cap=$3 WHERE game_id=$1 AND stock_key=$2`,
          [e.gid, e.skey, e.newMax]);
        await tx.query(
          `UPDATE stock_snapshot SET max_cap=$3, updated_at=now()
           WHERE game_id=$1 AND stock_key=$2 AND version <= $4`,   -- guard: don't regress a newer ceiling
          [e.gid, e.skey, e.newMax, e.ver]);
      }
    }
  });

  await redis.xack(stream, GROUP, ...events.map(e => e.id));
  // trim ONLY consumed history, by MINID at the smallest un-ACKed id
  const minPending = await smallestPendingId(redis, stream, GROUP);
  if (minPending) await redis.xtrim(stream, 'MINID', '~', minPending);
}
```

Poison events (e.g. a genuinely un-insertable row) are moved to a dead-letter stream after N attempts rather than head-of-line-blocking the whole shard.

### 9.4 get-or-create (write-through) & rehydration

**get-or-create** (repository):
1. `HGET stock` — hit → return.
2. Miss + `expectedStock`: enforce per-game key quota; `INSERT stock_definition ... ON CONFLICT DO NOTHING` writing **both** `initial_stock` AND `max_cap` = `expectedStock` (durable baseline **first**); run `get_or_create.lua` (seeds Redis `stock` + `max` + emits create event). Concurrent creators converge via `HSETNX` / `ON CONFLICT`.
3. Miss + no `expectedStock`: attempt **reconcile-rehydrate** (below); if a durable value is proven, seed and return; else `404`.

**Reconcile-rehydrate** (cold/lost key on `no_key` from a mutation):
1. Acquire a short load lock (`SET lock NX PX 5000`).
2. Read `stock_snapshot`. **Only** trust it if the outbox for that shard is drained up to `snapshot.last_stream_id` (no pending entries for the key); otherwise rebuild the value as `initial_stock + Σ applied` from the ledger.
3. If neither a caught-up snapshot nor a ledger rebuild is available (e.g. Postgres unreachable), **fail closed**: return `503`, never seed to `expectedStock` (which would resurrect sold units).
4. Seed Redis (`HSETNX` guarded) with the reconciled value + its version; retry the original script once.

This is the single most important oversell guard: a monotonically-decreasing counter is **never** reseeded from a value that could be higher than reality.

---

## 10. Failure Modes & Degradation

Guiding rule: the **stock hot path** (`decrease`/`adjust`/`get`) **fails OPEN to a Postgres atomic fallback** on a Redis outage (product-owner mandate — selling must not stop when Redis is down), while the asynchronous Postgres projection remains best-effort; only genuine bugs return 5xx. (Rehydrate ambiguity while Redis is *up* but a key is cold still **fails closed** — never over-seed a money counter.)

| Failure | Behavior | Design response |
|---|---|---|
| **Postgres down** | Redis hot path keeps serving `decrease`/`adjust`/`get` (existing keys); outbox buffers. `/ready` stays **green** (gated on Redis only). `get` on a *brand-new* key needing a durable baseline returns `503`. | Split health: `/ready` = Redis; PG = separate `degraded` alert. Write-behind means PG lag is tolerable. |
| **Redis down / partition** | Stock `decrease`/`adjust`/`get` **fail open** to an atomic Postgres fallback ([§10.1](#101-postgres-fallback-redis-down-sell-path)), idempotent via the ledger `UNIQUE(game_id,stock_key,event_id)` — the sale proceeds. ioredis `enableOfflineQueue:false` + short timeouts → fail fast, so the error *triggers the fallback* (not a 503) with no offline-queue stampede on recovery. | Client reuses the **same** Idempotency-Key; on Redis recovery reconcile-rehydrate re-converges the counter as `initial + Σ applied`. |
| **Redis restart (AOF)** | Counters + outbox + consumer offsets recover to ≤ 1 s (everysec). Consumer resumes from group cursor + PEL. | No loss beyond the fsync window. |
| **Catastrophic Redis loss (AOF gone)** | Keys rebuilt lazily via **reconcile-rehydrate** from PG snapshot/ledger — never over-seeded. Un-flushed tail (≤ fsync + consumer lag) is the RPO. | Mitigate with **Redis replica + Sentinel** (roadmap milestone), `appendfsync always` (or synchronous `durable=true` PG write) for scarce low-stock keys, and drift reconciliation before trusting a rehydrated key. |
| **Outbox consumer stalled** | Stream grows in memory; PG lags. | Alert on `XLEN`, consumer-group PEL depth, oldest-unacked age. `XAUTOCLAIM` recovers stuck entries. **No `MAXLEN` trim on the hot path**, so no un-consumed event is ever lost. |
| **Disk full** | Redis stops accepting writes (fail-closed → 503); Postgres halts if WAL can't archive. | `pg_wal_archive` + `pg_backups` on a **separate volume/quota** from `pg_data` and Redis data, so archive/backup growth can't halt the DB. Disk alerts at 70/80 %. |
| **Redis OOM** | With `maxmemory` set + `noeviction`, writes return OOM → clean **503**, not an OS-kill that would lose the AOF tail. | `maxmemory` explicitly configured; alert on `used_memory / maxmemory`. Ephemeral (idem, rate-limit) vs durable (counters) sized with headroom; option to isolate on a second logical DB. |
| **VPS reboot** | Whole stock system unavailable for restart + AOF-replay window (correct fail-closed). | Documented window + AOF-everysec RPO; replica/Sentinel is the next step. |
| **Mid-script OOM (atomic ≠ rollback)** | Counter changed but `XADD` skipped → snapshot under-counts. | Memory headroom (only realistic trigger), mutation-before-`XADD` ordering, reconciler asserting `Σ applied == current_stock`, drifted key fails closed until reconciled. |

Error-handler mapping (repository boundary):

```ts
// Generic repository boundary. NOTE: the stock hot path (decrease/adjust/get) intercepts a Redis
// outage FIRST and fails OPEN to the Postgres fallback (§10.1) when STOCK_FALLBACK_TO_POSTGRES is on;
// this generic mapping applies to non-fallback paths (e.g. PG itself unavailable, other modules).
catch (e) {
  if (isDatastoreUnavailable(e)) throw Errors.upstream();   // 503 + Retry-After (non-fallback path)
  throw e;                                                  // → 500 only for true bugs
}
```

### 10.1 Postgres fallback (Redis-down sell path)

```ts
// StockRepository.decreaseViaPostgres — invoked only when the Redis EVALSHA throws a
// connection/timeout error. Exactly-once is enforced by the ledger UNIQUE(game_id,stock_key,event_id).
async decreaseViaPostgres(gameId, stockKey, amount, eventId, keyId, nowMs) {
  return this.pg.tx(async (tx) => {
    // 1) claim the idempotency slot + write an audit row in one shot
    const claim = await tx.query(
      `INSERT INTO stock_ledger (event_id, stream_id, game_id, stock_key, op,
           requested, applied, new_value, version, api_key_id, event_ms, source)
       VALUES ($1, 'pgf:'||$1, $2, $3, 'decrease', $4, 0, 0, 0, $5, $6, 'pg_fallback')
       ON CONFLICT (game_id, stock_key, event_id) DO NOTHING
       RETURNING id`,
      [eventId, gameId, stockKey, amount, keyId, nowMs]);

    if (claim.rowCount === 0) {                         // retry during the outage → replay
      const prev = await tx.query(
        `SELECT applied, new_value FROM stock_ledger
         WHERE game_id=$1 AND stock_key=$2 AND event_id=$3`, [gameId, stockKey, eventId]);
      return { decremented: -prev.rows[0].applied, stock: prev.rows[0].new_value, replay: true };
    }

    // 2) atomic clamp-decrement on the durable snapshot (may be slightly stale — accepted).
    //    A CTE captures the pre-value under FOR UPDATE so `applied` is exact even when the
    //    result clamps to 0, and concurrent fallback decrements on the same key serialize.
    const upd = await tx.query(
      `WITH prev AS (
         SELECT current_stock AS old_value FROM stock_snapshot
         WHERE game_id=$1 AND stock_key=$2 FOR UPDATE
       )
       UPDATE stock_snapshot s
         SET current_stock = GREATEST(0, prev.old_value - $3),
             version = s.version + 1, updated_at = now()
       FROM prev
       WHERE s.game_id=$1 AND s.stock_key=$2
       RETURNING prev.old_value AS old_value, s.current_stock AS new_value`,
      [gameId, stockKey, amount]);
    if (upd.rowCount === 0) throw Errors.notFound('STOCK_KEY_NOT_FOUND');

    const oldValue = Number(upd.rows[0].old_value);
    const newValue = Number(upd.rows[0].new_value);
    const applied  = -(oldValue - newValue);            // signed, exact even when clamped to 0
    // 3) backfill the ledger row we inserted with the real numbers
    await tx.query(
      `UPDATE stock_ledger SET applied=$4, new_value=$5
       WHERE game_id=$1 AND stock_key=$2 AND event_id=$3`,
      [gameId, stockKey, eventId, applied, newValue]);
    return { decremented: -applied, stock: newValue, replay: false };
  });
}
```

`adjust` and `get` use the same pattern (`adjust` clamps to `[0, max_cap]` from `stock_definition`; `get` reads `stock_snapshot`, and get-or-create still write-through creates the definition). RESIDUAL RISK (accepted by owner): the snapshot lags Redis by the write-behind window, so the fallback can oversell by the un-flushed tail; on Redis recovery the counter is rebuilt as `initial + Σ applied` over the ledger (including `pg_fallback` rows) and re-converges. This fallback is gated by `STOCK_FALLBACK_TO_POSTGRES` (default true); set false to revert to strict fail-closed 503 for stricter inventories.

---

## 11. Standard Response Envelope & Error Model

One envelope for the whole API, all modules. Lua branches on `res.ok`.

```ts
type ApiResponse<T> =
  | { ok: true;  data: T;        meta: Meta }
  | { ok: false; error: ApiError; meta: Meta };

interface Meta    { requestId: string; timestamp: string; }   // ISO-8601 UTC; requestId also in X-Request-Id
interface ApiError { code: ErrorCode; message: string; details?: Record<string, unknown>; }
```

Error codes are decoupled from HTTP status (a shared lookup table derives status):

```ts
type ErrorCode =
  // ---- generic (reused by every module) ----
  | 'VALIDATION_ERROR'           // 400
  | 'IDEMPOTENCY_KEY_REQUIRED'   // 400  missing on decrease/adjust
  | 'IDEMPOTENCY_KEY_REUSED'     // 422  same key, different fingerprint
  | 'UNAUTHENTICATED'            // 401
  | 'FORBIDDEN'                  // 403
  | 'NOT_FOUND'                  // 404
  | 'PAYLOAD_TOO_LARGE'          // 413
  | 'UNSUPPORTED_MEDIA_TYPE'     // 415
  | 'RATE_LIMITED'               // 429  (Retry-After)
  | 'INTERNAL_ERROR'             // 500
  | 'SERVICE_UNAVAILABLE'        // 503  (Retry-After) Redis/PG down / load-shed / rehydrate-ambiguous
  // ---- stock module ----
  | 'STOCK_KEY_NOT_FOUND'         // 404
  | 'STOCK_INVALID_AMOUNT'        // 400  amount not integer ≥ 1
  | 'STOCK_INVALID_DELTA'         // 400  delta not non-zero integer in range
  | 'STOCK_INVALID_EXPECTED_STOCK'// 400  expectedStock not integer in [0, MAX_STOCK]
  | 'STOCK_INVALID_TARGET_MAX'    // 400  targetStockMax not integer in [0, MAX_STOCK]
```

`401` is identical for missing and invalid keys (no key-existence oracle). `429`/`503` set `Retry-After`. 5xx bodies are never cached by idempotency (a transient error stays retriable). Unknown internal errors log full detail, expose nothing.

---

## 12. Project Structure & Module Pattern

The **core** is pure plumbing; each **module** is a self-contained Fastify plugin auto-discovered from `src/modules/*`. Adding a resource system = drop a folder. No core edits (migrations auto-glob `modules/*/sql`).

```
GameApi/
├─ docker-compose.yml  Dockerfile  .env.example  package.json  tsconfig.json
├─ ops/                Caddyfile  redis.conf  postgres/  backup/  deploy.sh
├─ src/
│  ├─ server.ts                     # lifecycle: config, migrate, buildApp, listen, graceful shutdown
│  ├─ app.ts                        # buildApp(): registers core plugins + autoloads modules
│  ├─ config/env.ts                 # Zod schema + *_FILE secret loader + loadConfig() (fail-fast)
│  ├─ core/
│  │  ├─ constants.ts               # MAX_STOCK, MAX_AMOUNT, MAX_DELTA, IDEMPOTENCY_TTL — single source
│  │  ├─ module.ts                  # ResourceModule contract
│  │  ├─ errors/app-error.ts        # AppError + ErrorCode→HTTP map + Errors.* factories
│  │  ├─ http/envelope.ts           # ok()/fail() + Zod envelope schemas
│  │  ├─ auth/                      # Principal, ApiKeyStore, EnvApiKeyStore
│  │  ├─ idempotency/               # header check, fingerprint, resource-namespaced record key
│  │  ├─ ratelimit/                 # token-bucket Lua runner (redis TIME)
│  │  ├─ lua/                       # LuaRegistry (defineCommand, EVALSHA + NOSCRIPT fallback)
│  │  ├─ db/migrate.ts              # advisory-locked runner, globs core + modules/*/sql
│  │  └─ plugins/                   # error-handler, postgres, redis, auth, ratelimit, health
│  ├─ modules/
│  │  └─ stock/
│  │     ├─ index.ts                # loads lua/, registers routes → mounted at /v1/games/:gameId/stock
│  │     ├─ stock.schemas.ts        # Zod params/body + response views (from core/constants)
│  │     ├─ stock.routes.ts         # thin handlers → service, requireScope, idempotency
│  │     ├─ stock.service.ts        # domain rules; HTTP-agnostic; throws Errors.*
│  │     ├─ stock.repository.ts     # ONLY IO layer: Lua calls + PG write-through/hydrate
│  │     ├─ lua/  decrease.lua  adjust.lua  get_or_create.lua  set_max.lua
│  │     ├─ sql/  001_init.sql
│  │     └─ __tests__/              # unit + Testcontainers integration
│  ├─ modules/admin/                # provisioning/operator API (game+key CRUD, set/reset, ledger, reconcile)
│  └─ workers/outbox-consumer.ts    # idempotent stream → PG projector
└─ test/helpers/build-test-app.ts
```

**Fixed 4-part module contract:** `schemas` (Zod) → `routes` (HTTP) → `service` (domain, HTTP-agnostic) → `repository` (the only layer touching Redis/Lua/PG). Every module inherits auth, rate limiting, idempotency, the envelope, the outbox+consumer machinery, and audit for free.

**To add a module** (e.g. `leaderboards`): create `src/modules/leaderboards/` with the four files, its own `lua/` (ZADD/ZREVRANGE), and `sql/`. Autoload mounts it at `/v1/games/:gameId/leaderboards`; migrations pick up its `sql/` via the glob. No core file changes.

Handler shape (thin):

```ts
// stock.routes.ts
r.post('/:stockKey/decrease', {
  preHandler: [requireScope('stock:write'), requireIdempotencyKey],
  schema: { params: S.StockKeyParams, body: S.DecreaseBody, response: { 200: okEnvelope(S.DecreaseResult) } },
}, async (req) =>
  ok(await service.decrease(req.params.gameId, req.params.stockKey,
                            req.body.amount, req.idempotencyKey!, req.principal!)));
```

---

## 13. Configuration & Env Vars

One Zod-validated config, one `*_FILE` secret loader (resolves file secrets **before** validation), fail-fast at boot.

```ini
# .env.example  — real .env is git-ignored, chmod 600; secrets/* are chmod-600 files

# ---- infra / compose ----
REGISTRY=registry.example.com/skanz
API_IMAGE_TAG=1.0.0            # PINNED immutable git-sha tag, never :latest
API_REPLICAS=3                # ≈ vCPU count
DOMAIN=api.yourgame.com
ACME_EMAIL=ops@yourgame.com
TZ=UTC

# ---- app runtime ----
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
LOG_LEVEL=info
TRUST_PROXY=true
SHUTDOWN_TIMEOUT_MS=20000
REQUEST_TIMEOUT_MS=8000
BODY_LIMIT_BYTES=16384
METRICS_ENABLED=true

# ---- auth (single key today; comma-separated set = zero-downtime rotation & multi-key later) ----
API_KEYS_FILE=/run/secrets/api_keys          # preferred (docker secret)
# API_KEYS=key_live_min_32_chars_high_entropy # fallback if not using secrets

# ---- redis ----
REDIS_URL=redis://:PLACEHOLDER@redis:6379/0
REDIS_PASSWORD_FILE=/run/secrets/redis_password
REDIS_KEY_PREFIX=gapi:v1:

# ---- postgres ----
DATABASE_URL=postgres://gameapi@postgres:5432/gameapi
PGPASSWORD_FILE=/run/secrets/postgres_password
PG_POOL_MAX=10                # per replica; API_REPLICAS × this < max_connections (100)

# ---- domain constants (mirror src/core/constants.ts) ----
MAX_STOCK=1000000000
IDEMPOTENCY_TTL_SECONDS=86400
STOCK_FALLBACK_TO_POSTGRES=true   # Redis-down stock sell path falls back to Postgres; false = strict 503 fail-closed

# ---- rate limits ----
RATE_LIMIT_KEY_PER_MIN=6000
RATE_LIMIT_KEY_BURST=300
RATE_LIMIT_GAME_PER_MIN=12000
RATE_LIMIT_GAME_BURST=600

# ---- backups ----
BACKUP_CRON=0 3 * * *
BACKUP_RETENTION_DAYS=14
RCLONE_REMOTE=b2:gameapi-backups
```

---

## 14. Observability

**Health/readiness (the split that keeps PG off the routing gate):**

```ts
// liveness — process up, no deps. Docker HEALTHCHECK.
app.get('/health', { config: { public: true } }, async () => ({ ok: true, data: { status: 'up' } }));

// readiness — HOT-PATH deps only (Redis). Caddy routing gate.
app.get('/ready', { config: { public: true } }, async (_req, reply) => {
  try { await app.redis.ping(); return { ok: true, data: { status: 'ready' } }; }
  catch (err) { app.log.error({ err }, 'not ready'); return reply.code(503).send(fail('SERVICE_UNAVAILABLE')); }
});

// degraded — PG + outbox lag; ALERT signal, never pulls a replica from rotation.
app.get('/degraded', { config: { public: true } }, async () => ({
  ok: true, data: { postgres: await pgOk(), outboxLag: await streamLag() },
}));
```

**Metrics (prom-client, scraped over the backend net; Caddy 404s public `/metrics`):**

- `http_request_duration_seconds` (histogram, labels method/route/status)
- `stock_operations_total{op,result}` — `result = ok|clamped|replayed|not_found|created`
- `outbox_stream_length`, `outbox_consumer_lag`, `outbox_pending_oldest_seconds` — **write-behind divergence alerts**
- `reconciler_drift_total` — pages on any `Σapplied ≠ current_stock`
- Redis `used_memory/maxmemory`, Postgres connection saturation

**Logging:** pino JSON to stdout → Docker json-file (bounded `max-size 10m max-file 5`) → optional Loki. `x-api-key`/`authorization` redacted. Every response carries `X-Request-Id`.

**Alerts:** `/ready` failing, 5xx rate, p99 latency, disk > 80 %, Redis mem ratio, PG connection saturation, outbox lag/PEL depth, reconciler drift, **backup age > 26 h**, per-game key-count near quota.

---

## 15. Deployment

Single VPS, Docker Compose. Only **Caddy** binds host ports; Redis/Postgres live on an `internal` backend network. N stateless single-thread API replicas behind Caddy (per-worker health isolation, clean rolling deploys). **Postgres connection math:** `API_REPLICAS × PG_POOL_MAX` must stay under `max_connections`; insert PgBouncer (transaction mode) before scaling replicas past ~8.

```yaml
name: gameapi
networks: { frontend: {}, backend: { internal: true } }
volumes: { caddy_data: {}, redis_data: {}, pg_data: {}, pg_wal_archive: {}, pg_backups: {} }
secrets:
  postgres_password: { file: ./secrets/postgres_password }
  redis_password:    { file: ./secrets/redis_password }
  api_keys:          { file: ./secrets/api_keys }

services:
  caddy:
    image: caddy:2.8-alpine
    ports: ["80:80","443:443","443:443/udp"]        # ONLY publicly bound service
    volumes: [ "./ops/Caddyfile:/etc/caddy/Caddyfile:ro", "caddy_data:/data" ]
    environment: { DOMAIN: ${DOMAIN}, ACME_EMAIL: ${ACME_EMAIL} }
    networks: [frontend]
    restart: unless-stopped

  api:
    image: ${REGISTRY}/gameapi:${API_IMAGE_TAG}     # pinned, never :latest; no host ports (rollout-friendly)
    deploy: { replicas: ${API_REPLICAS:-3} }
    stop_grace_period: 25s                          # > SHUTDOWN_TIMEOUT_MS, drains in-flight
    env_file: .env
    secrets: [postgres_password, redis_password, api_keys]
    networks: [frontend, backend]
    depends_on:
      redis:    { condition: service_healthy }
      postgres: { condition: service_healthy }
    healthcheck:                                     # docker-rollout waits on this (liveness)
      test: ["CMD","node","-e","fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 15s
    restart: unless-stopped

  redis:
    image: redis:7.4-alpine
    command: ["sh","-c","redis-server /usr/local/etc/redis/redis.conf --requirepass \"$$(cat /run/secrets/redis_password)\""]
    volumes: [ "./ops/redis.conf:/usr/local/etc/redis/redis.conf:ro", "redis_data:/data" ]
    secrets: [redis_password]
    networks: [backend]
    restart: unless-stopped

  postgres:
    image: postgres:16-bookworm
    command: ["postgres","-c","config_file=/etc/postgresql/postgresql.conf"]
    environment: { POSTGRES_USER: gameapi, POSTGRES_DB: gameapi, POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password, TZ: UTC }
    volumes:
      - pg_data:/var/lib/postgresql/data
      - pg_wal_archive:/wal_archive                  # SEPARATE from pg_data
      - ./ops/postgres/postgresql.conf:/etc/postgresql/postgresql.conf:ro
    secrets: [postgres_password]
    networks: [backend]
    shm_size: 256mb
    restart: unless-stopped

  outbox-consumer:
    image: ${REGISTRY}/gameapi:${API_IMAGE_TAG}
    command: ["node","dist/workers/outbox-consumer.js"]
    env_file: .env
    secrets: [postgres_password, redis_password]
    networks: [backend]
    depends_on: { redis: { condition: service_healthy }, postgres: { condition: service_healthy } }
    restart: unless-stopped

  pg-backup:
    image: postgres:16-bookworm
    entrypoint: ["/bin/bash","/entrypoint.sh"]
    volumes: [ "./ops/backup/entrypoint.sh:/entrypoint.sh:ro", "pg_backups:/backups", "pg_wal_archive:/wal_archive" ]
    secrets: [postgres_password]
    networks: [backend]
    restart: unless-stopped
```

**`ops/redis.conf` (critical correctness lines):**
```conf
appendonly yes
appendfsync everysec               # ≤1s RPO (use 'always' for money path if required)
maxmemory 2gb                      # EXPLICIT ceiling so noeviction fails-closed, not OS-OOM-kill
maxmemory-policy noeviction        # never silently evict a live stock counter
save 900 1
save 300 100
```

**Caddy** uses `dynamic a { name api; port 3000; refresh 5s }`, `lb_policy least_conn`, `health_uri /ready`, `lb_try_duration 5s`, `fail_duration 10s` — so rolled/scaled replicas are discovered live and traffic only hits ready ones. Combined with graceful shutdown + `stop_grace_period` → near-zero dropped requests.

**Deploy flow (`ops/deploy.sh`)** via `docker-rollout`:
```bash
export API_IMAGE_TAG="$1"
docker compose pull api outbox-consumer
docker compose run --rm --no-deps api node dist/migrate.js up   # expand/contract, backward-compatible
docker rollout -f docker-compose.yml api                        # health-gated rolling replace
docker compose up -d --no-deps outbox-consumer caddy redis postgres pg-backup
docker image prune -f
```
Rollback = `deploy.sh <previous-tag>`; expand/contract migrations mean a code rollback never needs a schema rollback.

**Backups:** nightly `pg_dump` (logical) + continuous WAL archiving with weekly `pg_basebackup` (physical PITR), rclone-synced offsite (3-2-1). `pg_wal_archive`/`pg_backups` on a separate volume so backup/archive growth can't halt the DB. **Monthly restore drill** into a scratch DB is mandatory — untested backups don't count.

**Roadmap for HA:** Redis replica + Sentinel with client failover; PgBouncer when scaling replicas.

---

## 16. Roblox Integration

A versioned ModuleScript is shipped as a first-class deliverable. It encodes the one rule that makes exactly-once real: **the idempotency GUID is generated once per purchase, outside the retry loop, and reused on every attempt.**

```lua
--!strict
-- GameApiClient.lua  — ServerScriptService ModuleScript
local HttpService = game:GetService("HttpService")

local GameApi = {}
GameApi.__index = GameApi

function GameApi.new(config)
	return setmetatable({
		baseUrl = config.baseUrl,          -- "https://api.yourgame.com/v1"
		apiKey  = config.apiKey,           -- from a secret store, NOT hard-coded in client-facing code
		gameId  = config.gameId,           -- "sword-sim"
		maxRetries = config.maxRetries or 5,
	}, GameApi)
end

-- Core request with retry + backoff. idemKey (if given) is REUSED across all attempts.
function GameApi:_request(method, path, body, idemKey)
	local url = self.baseUrl .. path
	local headers = { ["Content-Type"] = "application/json", ["X-Api-Key"] = self.apiKey }
	if idemKey then headers["Idempotency-Key"] = idemKey end
	local payload = body and HttpService:JSONEncode(body) or nil

	for attempt = 1, self.maxRetries do
		local ok, res = pcall(function()
			return HttpService:RequestAsync({ Url = url, Method = method, Headers = headers, Body = payload })
		end)

		if ok and res.Body ~= nil and res.Body ~= "" then
			local parsed = HttpService:JSONDecode(res.Body)
			if parsed.ok then
				return parsed.data                                   -- success
			end
			local code = parsed.error and parsed.error.code
			-- retriable server-side conditions: back off and retry with the SAME idemKey
			if code == "SERVICE_UNAVAILABLE" or code == "RATE_LIMITED" then
				task.wait(0.5 * attempt)                             -- linear backoff
			else
				error(("GameApi error %s: %s"):format(tostring(code), tostring(parsed.error and parsed.error.message)))
			end
		else
			-- network/timeout: the mutation MAY have applied; retry SAME idemKey → server dedupes
			task.wait(0.5 * attempt)
		end
	end
	error("GameApi request failed after " .. self.maxRetries .. " attempts")
end

-- Server startup: guarantee the key exists (idempotent seed).
function GameApi:getOrCreate(stockKey, expectedStock)
	local path = ("/games/%s/stock/%s/get"):format(self.gameId, HttpService:UrlEncode(stockKey))
	return self:_request("POST", path, { expectedStock = expectedStock })
end

-- Purchase: generate the idempotency key ONCE, before any retry.
function GameApi:decrease(stockKey, amount)
	local idemKey = HttpService:GenerateGUID(false)                  -- ONCE per logical purchase
	local path = ("/games/%s/stock/%s/decrease"):format(self.gameId, HttpService:UrlEncode(stockKey))
	return self:_request("POST", path, { amount = amount }, idemKey)  -- SAME idemKey every retry
end

-- Admin restock / correction.
function GameApi:adjust(stockKey, delta)
	local idemKey = HttpService:GenerateGUID(false)
	local path = ("/games/%s/stock/%s/adjust"):format(self.gameId, HttpService:UrlEncode(stockKey))
	return self:_request("POST", path, { delta = delta }, idemKey)
end

-- Admin set per-record ceiling (clamps stock down if the new ceiling is below current stock).
function GameApi:setMax(stockKey, targetStockMax)
	local idemKey = HttpService:GenerateGUID(false)                  -- ONCE per logical call
	local path = ("/games/%s/stock/%s/set-max"):format(self.gameId, HttpService:UrlEncode(stockKey))
	return self:_request("POST", path, { targetStockMax = targetStockMax }, idemKey)
end

return GameApi
```

Usage:

```lua
local GameApi = require(game.ServerScriptService.GameApiClient)
local api = GameApi.new({ baseUrl = "https://api.yourgame.com/v1", apiKey = API_KEY, gameId = "sword-sim" })

-- on server start
api:getOrCreate("excalibur", 1000)

-- on purchase — grant EXACTLY data.decremented (source of truth, never assume the request applied verbatim)
local data = api:decrease("excalibur", 10)
if data.decremented > 0 then
	grantItemsToPlayer(player, data.decremented)
end
if data.stock == 0 then
	markSoldOut("excalibur")
end
```

**Rules the wrapper enforces:** generate the key before retrying; reuse it on every attempt; retry only on timeout / `SERVICE_UNAVAILABLE` / `RATE_LIMITED`; grant exactly `data.decremented`. To stay under the ~500 req/min/server `HttpService` budget during spikes, coalesce/queue client-side (a future `batchDecrease` endpoint is on the roadmap).

---

## 17. Testing Strategy

The core guarantee lives in the Lua scripts, so tests exercise **real Redis + Postgres** (Testcontainers), not mocks. CI blocks deploy on failure.

**Concurrency / atomicity (the headline suite):**
- Seed a key to 1000; fire thousands of parallel `decrease` calls from many connections; assert `Σ decremented == 1000`, `stock` floor never `< 0`, and no request reports more `decremented` than existed at its moment.
- Race concurrent `get-or-create` from N clients on a missing key; assert exactly one `created:true`, all converge on one value, exactly one `stock_definition` row.

**Idempotency / retry:**
- Same `Idempotency-Key` replayed → identical `{decremented, stock}`, applied **once**, exactly one outbox event, exactly one ledger row.
- Simulate crash between atomic commit and HTTP response → retry replays the stored result.
- Reused key with a *different* body → `422 IDEMPOTENCY_KEY_REUSED`.
- Distinct keys, different stockKeys, same amount → independent (no fingerprint collision — validates path-resolved fingerprint).

**Rehydration / recovery:**
- Seed 1000, decrease 700 (Redis 300), flush lagging (snapshot stale at 900), drop the Redis key → next mutation must **not** oversell: it either rebuilds `300` from `initial + Σapplied` or fails closed (503). Assert it never reseeds to 900.
- Consumer redelivery / out-of-order events → no duplicate ledger rows, snapshot never regresses (version guard).
- Consumer crash mid-batch (commit before `XACK`) → `XAUTOCLAIM` reprocesses idempotently.

**Reconciliation:** after a randomized op stream, assert `Σ signed applied == current_stock` per key and snapshot matches highest-version ledger row.

**Validation / auth / rate limit:** bound checks (`amount`/`delta`/`expectedStock`), `additionalProperties:false`, constant-time key compare (all-candidate scan), token-bucket refill under load, per-game fairness.

**Contract:** responses conform to the published envelope + error-code enum (generated OpenAPI); Lua-script unit tests for each branch (clamp, cap, no_key, replay, fp_mismatch).

**Migrations:** apply on a clean DB in CI; expand/contract compliance check; rehearsed rollback.

**Failure injection:** kill Redis mid-load — with `STOCK_FALLBACK_TO_POSTGRES=true` expect the **Postgres fail-open fallback** (sales continue, exactly-once via the ledger `UNIQUE(game_id,stock_key,event_id)`, `source='pg_fallback'` rows), with it `false` expect **503 fail-closed**; then on recovery reconcile-rehydrate re-converges the counter as `initial + Σ applied`. Kill Postgres (expect hot path stays green, `/ready` green, outbox buffers, drains on restart).

---

## 18. Roadmap & Open Questions

**Roadmap (ordered):**
1. Ship stock module with the frozen decisions above; full concurrency + idempotency + rehydration test suites in CI.
2. ~~**Admin/provisioning module**~~ — **DONE.** The admin panel (`/panel`) covers game +
   API-key CRUD, stock/serial inspect/set/adjust/delete/restore/purge, and accounts. Ledger
   query is the one piece not built: the ledger accrues correctly and a read view is purely
   additive, so it was left out rather than shipped as a `COUNT(*) OVER()` over an unbounded
   offset on the hottest table in the system.
3. **Redis HA** — replica + Sentinel, ioredis failover config; documented unavailability window.
   Now also carries panel sessions and the login throttle, so a Redis outage locks the panel
   (503) — the game path still fails open on the limiter.
4. `pg_partman` automatic partition creation + DEFAULT partition; ledger retention/archival policy.
5. ~~Multi-key auth~~ — **DONE**, see §5.4. sha256 rather than argon2id, and a dot separator.
6. PgBouncer once replicas scale past ~8.
7. Second module (leaderboards or cooldowns) to validate the generic core end-to-end.
8. `batchDecrease` endpoint to help games stay under the `HttpService` request budget.

**Open questions (deliberately deferred, with a current default):**
- **Durability tier for scarce stock** — is `appendfsync everysec` acceptable, or should low-stock keys use `appendfsync always` / a synchronous `durable=true` PG write? *Default: everysec + replica; per-key `durable=true` available.*
- **Idempotency TTL vs retry horizon** — 24 h assumed; confirm the maximum realistic Roblox retry/replay window.
- **`adjust` positive overflow** — hard cap at `MAX_STOCK` returning `capped:true` (chosen) vs error. *Default: cap + flag.*
- **Ledger retention & `source_ip` PII** — drop/cold-archive after N months; store, hash, or omit `source_ip`.
- **VPS sizing** — vCPU/RAM/disk fixes `API_REPLICAS`, Redis `maxmemory`, PG `shared_buffers`/`max_connections`, and whether the working set fits under `noeviction`.
- **Peak RPS / hottest-key contention** — a single hot `stockKey` serializes on one Redis core (correct, bounded); load-test to confirm headroom and whether per-`(key,stockKey)` rate limiting is needed at launch.
- **`gameId` provenance in the multi-key future** — key-derived (authoritative) vs cross-checked against the path (studio master key serving multiple games).
- **Fail-open sell path during a Redis outage** — serving the stock hot path from the Postgres write-behind snapshot instead of 503ing is a **deliberate product-owner decision** (availability of sales over strict accuracy), accepting a small oversell of the un-flushed tail; the counter re-converges via reconcile-rehydrate on Redis recovery. A **Redis replica + Sentinel** (roadmap #3) would shrink the fallback window and thus the residual oversell; `STOCK_FALLBACK_TO_POSTGRES=false` reverts to strict fail-closed 503 for scarce/high-value inventories. *Default: fallback on.*