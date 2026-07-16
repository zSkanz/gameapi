import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { Pool } from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { Errors } from '../../core/errors/app-error';

/**
 * Discord webhook notifications for panel actions.
 *
 * Deliberately only panel actions: the discriminator is `req.panel`, which only the cookie
 * branch of the auth hook sets. A Roblox server decrementing stock 6000 times a minute is not
 * a log entry — the ledger already has it, and Discord would rate-limit us into the ground.
 *
 * This is a NOTIFICATION, not an audit trail. Delivery is fire-and-forget: it never blocks or
 * fails the action it describes, so a missing message means nothing was recorded, not that
 * nothing happened. stock_ledger remains the record.
 */

const DELIVERY_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------- URL safety

/**
 * The IPv4 inside a v4-mapped IPv6 address, or null.
 *
 * BOTH spellings are needed. `new URL('https://[::ffff:127.0.0.1]/')` reports its hostname as
 * `[::ffff:7f00:1]` — the WHATWG parser compresses the dotted quad to hex — so a check that
 * only knows the dotted form waves loopback straight through. DNS results arrive in the dotted
 * form, so that one is real too.
 */
function mappedIPv4(v6: string): string | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (dotted) return dotted[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (!hex) return null;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Blocks the ranges that make an outbound POST into a door onto our own network. */
function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // unique-local
    if (v6.startsWith('fe80')) return true; // link-local
    const mapped = mappedIPv4(v6);
    if (mapped) return isPrivateAddress(mapped);
    return false;
  }
  const p = ip.split('.').map(Number);
  const [a, b] = [p[0] ?? 0, p[1] ?? 0];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, and every cloud metadata endpoint
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/**
 * Validate a webhook URL at save time.
 *
 * The user chose to allow any https host (Slack, n8n, their own endpoint) rather than pinning
 * to discord.com, so this is what stands between a compromised panel account and our internal
 * network: https only, and the hostname must not resolve into private space. It is not
 * airtight — DNS can be re-pointed after this check, and delivery does not re-resolve — but it
 * closes the direct `http://postgres:5432` / `169.254.169.254` cases, which are the ones a
 * person would actually try.
 */
export async function assertSafeWebhookUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw Errors.validation('That is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw Errors.validation('The webhook URL must be https.');
  if (url.username || url.password) throw Errors.validation('The webhook URL must not contain credentials.');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw Errors.validation('That address is not reachable from here.');
    return;
  }
  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw Errors.validation('That hostname does not resolve.');
  }
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw Errors.validation('That address is not reachable from here.');
  }
}

/** Never render the secret back to the browser — the URL IS the credential. */
export function maskWebhookUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}/…`;
  } catch {
    return '…';
  }
}

// ---------------------------------------------------------------- describing an action

interface ActionContext {
  method: string;
  /** The route pattern, e.g. /v1/panel/games/:gameId/stock/:stockKey/adjust */
  routeUrl: string;
  params: Record<string, string | undefined>;
  body: unknown;
}

interface Described {
  emoji: string;
  text: string;
  colour: number;
}

const COLOUR = { create: 0x3ba55d, edit: 0x5865f2, danger: 0xed4245, destroy: 0x992d22 };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const n = (v: unknown): string => (typeof v === 'number' ? v.toLocaleString('en-US') : '?');

/**
 * Turn a request into a line worth reading.
 *
 * Reads the REQUEST body, never the response — /keys returns the full API key and /users
 * returns a generated password, and neither may ever reach a chat client. The auth routes are
 * excluded upstream, because their request body holds the password.
 *
 * Unknown routes fall back to the method and path rather than being dropped: a new route
 * should show up in the log the day it ships, even if nobody taught this function about it.
 */
export function describeAction(ctx: ActionContext): Described | null {
  const b = (ctx.body ?? {}) as Record<string, unknown>;
  const key = ctx.params.stockKey ?? ctx.params.serialKey ?? '';
  const r = ctx.routeUrl;
  const m = ctx.method;

  // ---- stock ----
  if (r.endsWith('/stock') && m === 'POST') {
    return { emoji: '📦', text: `created stock key **${str(b.stockKey) ?? '?'}** — stock ${n(b.stock)} / max ${n(b.max)}`, colour: COLOUR.create };
  }
  if (r.endsWith('/stock/:stockKey/stock') && m === 'PUT') {
    return { emoji: '✏️', text: `set **${key}** stock to ${n(b.stock)}`, colour: COLOUR.edit };
  }
  if (r.endsWith('/stock/:stockKey/max') && m === 'PUT') {
    return { emoji: '✏️', text: `set **${key}** max to ${n(b.max)}`, colour: COLOUR.edit };
  }
  if (r.endsWith('/stock/:stockKey/adjust')) {
    const d = typeof b.delta === 'number' ? b.delta : 0;
    return { emoji: d < 0 ? '📉' : '📈', text: `adjusted **${key}** by ${d > 0 ? '+' : ''}${n(b.delta)}`, colour: COLOUR.edit };
  }
  if (r.endsWith('/stock/:stockKey/decrease')) {
    return { emoji: '📉', text: `decreased **${key}** by ${n(b.amount)}`, colour: COLOUR.edit };
  }
  if (r.endsWith('/stock/:stockKey') && m === 'DELETE') {
    return { emoji: '🗑️', text: `deleted stock key **${key}**`, colour: COLOUR.danger };
  }
  if (r.endsWith('/stock/:stockKey/restore')) {
    return { emoji: '♻️', text: `restored stock key **${key}**`, colour: COLOUR.create };
  }
  if (r.endsWith('/stock/:stockKey/purge')) {
    return { emoji: '☠️', text: `**PURGED** stock key **${key}** — the key and its whole history are gone`, colour: COLOUR.destroy };
  }

  // ---- serial ----
  if (r.endsWith('/serial') && m === 'POST') {
    return { emoji: '🔢', text: `created serial **${str(b.serialKey) ?? '?'}** starting at ${n(b.start)}`, colour: COLOUR.create };
  }
  if (r.endsWith('/serial/:serialKey') && m === 'PATCH') {
    return { emoji: '✏️', text: `edited serial **${key}**`, colour: COLOUR.edit };
  }
  if (r.endsWith('/serial/:serialKey/issue')) {
    return { emoji: '🎫', text: `issued a serial number from **${key}** by hand`, colour: COLOUR.edit };
  }
  if (r.endsWith('/serial/:serialKey') && m === 'DELETE') {
    return { emoji: '🗑️', text: `deleted serial **${key}**`, colour: COLOUR.danger };
  }
  if (r.endsWith('/serial/:serialKey/restore')) {
    return { emoji: '♻️', text: `restored serial **${key}**`, colour: COLOUR.create };
  }
  if (r.endsWith('/serial/:serialKey/purge')) {
    return { emoji: '☠️', text: `**PURGED** serial **${key}** — the issuer and its history are gone`, colour: COLOUR.destroy };
  }

  // ---- api keys ---- (label and scopes only: the key itself lives in the response)
  if (r.endsWith('/keys') && m === 'POST') {
    const scopes = Array.isArray(b.scopes) ? (b.scopes as string[]).join(', ') : '';
    return { emoji: '🔑', text: `created an API key **${str(b.label) ?? '?'}**${scopes ? ` — ${scopes}` : ''}`, colour: COLOUR.create };
  }
  if (r.endsWith('/keys/:keyId/revoke')) {
    return { emoji: '🚫', text: `revoked API key \`${ctx.params.keyId ?? '?'}\``, colour: COLOUR.danger };
  }

  // ---- game ----
  if (r.endsWith('/games/:gameId') && m === 'DELETE') {
    return { emoji: '🗑️', text: `deleted this game — its API keys stop working`, colour: COLOUR.danger };
  }
  if (r.endsWith('/games/:gameId/restore')) {
    return { emoji: '♻️', text: `restored this game`, colour: COLOUR.create };
  }
  if (r.endsWith('/webhook')) {
    return m === 'DELETE'
      ? { emoji: '🔕', text: `removed this webhook — no further actions will be logged here`, colour: COLOUR.danger }
      : { emoji: '🔔', text: `updated this webhook`, colour: COLOUR.edit };
  }

  // ---- roblox ----
  // The PUT body carries an Open Cloud API key with publish rights on a real experience. These
  // cases exist to say so out loud: describe the ACT, never the body. The fallback below is
  // safe for the same reason — it only ever emits the method and the route pattern.
  if (r.endsWith('/roblox')) {
    return m === 'DELETE'
      ? { emoji: '🔌', text: `disconnected this game from Roblox`, colour: COLOUR.danger }
      : { emoji: '🔌', text: `updated the Roblox connection`, colour: COLOUR.edit };
  }
  if (r.endsWith('/roblox/publish')) {
    // The message is the operator's own text, headed for a game chat — not a secret.
    return { emoji: '📣', text: `published to Roblox topic **${str(b.topic) ?? '?'}**: ${str(b.message) ?? ''}`, colour: COLOUR.edit };
  }

  return { emoji: '•', text: `${m} ${r.replace('/v1/panel', '')}`, colour: COLOUR.edit };
}

// ---------------------------------------------------------------- delivery

export interface WebhookRow {
  gameId: string;
  url: string;
  enabled: boolean;
}

/** Look up a game's webhook. Returns null when there is none or it is switched off. */
export async function findWebhook(pg: Pool, gameId: string): Promise<WebhookRow | null> {
  const r = await pg.query(`SELECT game_id, url, enabled FROM game_webhook WHERE game_id = $1 AND enabled`, [gameId]);
  const row = r.rows[0];
  return row ? { gameId: row.game_id, url: row.url, enabled: row.enabled } : null;
}

/**
 * POST one message. Fire-and-forget by contract: this never throws to the caller and never
 * delays the response — the action already happened, and Discord being down is not the
 * operator's problem. The outcome is recorded on the row so the panel can show a dead webhook
 * rather than leaving you to wonder.
 */
export async function deliver(
  pg: Pool,
  log: FastifyBaseLogger,
  row: WebhookRow,
  content: { username: string; role: string; gameId: string; action: Described; ip: string },
): Promise<void> {
  const { action } = content;
  const payload = {
    username: 'GameApi',
    embeds: [
      {
        color: action.colour,
        description: `${action.emoji}  **${content.username}** ${action.text}`,
        fields: [
          { name: 'Game', value: `\`${content.gameId}\``, inline: true },
          { name: 'By', value: `${content.username} (${content.role})`, inline: true },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: content.ip },
      },
    ],
  };

  let status = 0;
  let error: string | null = null;
  try {
    const res = await fetch(row.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 200) : 'delivery failed';
  }

  if (error) log.warn({ gameId: content.gameId, status, error }, 'webhook delivery failed');
  await pg
    .query(
      `UPDATE game_webhook SET
         last_status = $2, last_error = $3, last_attempt_at = now(),
         last_ok_at = CASE WHEN $3::text IS NULL THEN now() ELSE last_ok_at END
       WHERE game_id = $1`,
      [content.gameId, status || null, error],
    )
    .catch(() => {
      /* health bookkeeping must not become the thing that breaks */
    });
}
