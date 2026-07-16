import type { Pool } from 'pg';

/**
 * Publishing to a Roblox experience's live servers via Open Cloud MessagingService.
 *
 * The game subscribes with MessagingService:SubscribeAsync(topic, ...) and receives whatever
 * string we publish here. Roblox's own limits are the design constraints, not ours:
 *
 *   topic    <= 80 characters
 *   message  <= 1024 characters (1 KiB)
 *   received <= (40 + 80 * number of servers) per topic per minute
 *
 * That receive budget is why this is a panel-only feature. A Roblox server doing thousands of
 * decreases a minute could never be mirrored here; a person clicking Send never comes close.
 *
 * Docs: https://create.roblox.com/docs/cloud/guides/usage-messaging
 */

/** Roblox's own caps. Enforced here so a rejection is a 400 from us, not a 4xx from them. */
export const TOPIC_MAX = 80;
export const MESSAGE_MAX = 1024;

const TIMEOUT_MS = 5_000;

/**
 * v2 is the only version the docs still document, and it is the one to prefer — but it has been
 * flagged beta since Jan 2025. v1 is undocumented, live for years, and has no announced
 * retirement. So: try v2, and fall back to v1 only when v2 answers like it does not exist.
 * A 401/403/429 is a real answer from a live endpoint and must NOT trigger a fallback — retrying
 * a bad key against v1 just burns the rate limit and muddies the error.
 */
const V2 = (universeId: string): string =>
  `https://apis.roblox.com/cloud/v2/universes/${encodeURIComponent(universeId)}:publishMessage`;
const V1 = (universeId: string, topic: string): string =>
  `https://apis.roblox.com/messaging-service/v1/universes/${encodeURIComponent(universeId)}/topics/${encodeURIComponent(topic)}`;

export interface RobloxConfig {
  gameId: string;
  universeId: string;
  apiKey: string;
}

export interface PublishOutcome {
  ok: boolean;
  status: number;
  api: 'v2' | 'v1' | null;
  error: string | null;
}

/** Roblox's errors are JSON or HTML depending on the layer that rejected you. Keep it short. */
function briefly(status: number, body: string): string {
  const trimmed = body.trim().slice(0, 300);
  try {
    const j = JSON.parse(trimmed) as { message?: string; error?: string; errors?: { message?: string }[] };
    const msg = j.message ?? j.error ?? j.errors?.[0]?.message;
    if (msg) return `HTTP ${status}: ${msg}`;
  } catch {
    /* not JSON — fall through */
  }
  return trimmed ? `HTTP ${status}: ${trimmed.slice(0, 120)}` : `HTTP ${status}`;
}

async function post(url: string, apiKey: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // Success is 200 with an EMPTY body, so this is only ever read to explain a failure.
  return { status: res.status, text: res.ok ? '' : await res.text().catch(() => '') };
}

export async function publish(cfg: RobloxConfig, topic: string, message: string): Promise<PublishOutcome> {
  try {
    const v2 = await post(V2(cfg.universeId), cfg.apiKey, { topic, message });
    if (v2.status === 200) return { ok: true, status: 200, api: 'v2', error: null };

    // Only "this endpoint isn't here" is a reason to try the older one. Anything else is v2
    // telling us something true about the request or the key.
    if (v2.status !== 404 && v2.status !== 501 && v2.status !== 405) {
      return { ok: false, status: v2.status, api: 'v2', error: briefly(v2.status, v2.text) };
    }

    const v1 = await post(V1(cfg.universeId, topic), cfg.apiKey, { message });
    if (v1.status === 200) return { ok: true, status: 200, api: 'v1', error: null };
    return { ok: false, status: v1.status, api: 'v1', error: briefly(v1.status, v1.text) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'request failed';
    return { ok: false, status: 0, api: null, error: reason.slice(0, 200) };
  }
}

/** Record the outcome so a rotated or expired key shows up in the panel, not just in a log. */
export async function recordOutcome(pg: Pool, gameId: string, o: PublishOutcome): Promise<void> {
  await pg
    .query(
      `UPDATE game_roblox SET
         last_status = $2, last_error = $3, last_api = $4, last_attempt_at = now(),
         last_ok_at = CASE WHEN $3::text IS NULL THEN now() ELSE last_ok_at END
       WHERE game_id = $1`,
      [gameId, o.status || null, o.error, o.api],
    )
    .catch(() => {
      /* health bookkeeping must not become the thing that fails */
    });
}

export async function findRobloxConfig(pg: Pool, gameId: string): Promise<RobloxConfig | null> {
  const r = await pg.query(`SELECT game_id, universe_id, api_key FROM game_roblox WHERE game_id = $1`, [gameId]);
  const row = r.rows[0];
  return row ? { gameId: row.game_id, universeId: row.universe_id, apiKey: row.api_key } : null;
}
