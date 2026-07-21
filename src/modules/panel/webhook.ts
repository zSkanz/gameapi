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


/**
 * Neutralise Discord markdown in a value we interpolate.
 *
 * Every name below lands inside `**...**`, so a funnel called "**x**" or containing a backtick
 * closes our formatting early and reformats the rest of the line. Cheap to escape, and the
 * alternative — restricting what a game may call its own funnel — is worse.
 */
const md = (v: string): string => v.replace(/([\\*_~`|>[\]()])/g, '\\$1');
const n = (v: unknown): string => (typeof v === 'number' ? v.toLocaleString('en-US') : '?');

/**
 * Sanitise ANY value interpolated into a log line — the single gate every user-derived string in
 * describeAction passes through, replacing per-sink md().
 *
 * The earlier design trusted "these names are charset-restricted upstream" and only hardened the
 * obviously-free-text sinks (topic/message). That was wrong twice over: the API-key label has no
 * charset regex at all, and FUNNEL_NAME_REGEX bans only C0 controls — it permits U+0085/U+2028/
 * U+2029, which Discord renders as line breaks. Both let a privileged caller forge a second log
 * line spoofing another operator. So the rule is now uniform: strip every control byte AND the
 * Unicode line/paragraph separators, collapse runs to one space, cap length, THEN md-escape — so
 * one action can only ever produce one line, whatever the value or its upstream validation.
 */
const line = (v: unknown): string => {
  const s = typeof v === 'string' ? v : '';
  const collapsed = s.replace(/[\x00-\x20\x7F\u0085\u2028\u2029]+/g, ' ').trim();
  // Slice by CODE POINTS, not UTF-16 units: a plain slice can cut a surrogate pair and leave a
  // lone surrogate, which Discord 400s and a fire-and-forget delivery then silently drops.
  return md(Array.from(collapsed).slice(0, 300).join(''));
};

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
  // EVERY interpolated value goes through line() (control/separator strip + md-escape). Done here,
  // once, because the per-sink approach kept missing sinks (label, funnel name, displayName) and
  // each miss is an audit-line forgery. line() is a superset of md(), so it fully replaces it.
  const key = line(ctx.params.stockKey ?? ctx.params.serialKey ?? '');
  const funnel = line(ctx.params.funnelName ?? '?');
  const r = ctx.routeUrl;
  const m = ctx.method;

  // ---- stock ----
  if (r.endsWith('/stock') && m === 'POST') {
    return { emoji: '📦', text: `created stock key **${line(b.stockKey) || '?'}** — stock ${n(b.stock)} / max ${n(b.max)}`, colour: COLOUR.create };
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
    return { emoji: '🔢', text: `created serial **${line(b.serialKey) || '?'}** starting at ${n(b.start)}`, colour: COLOUR.create };
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
    return { emoji: '🔑', text: `created an API key **${line(b.label) || '?'}**${scopes ? ` — ${scopes}` : ''}`, colour: COLOUR.create };
  }
  if (r.endsWith('/keys/:keyId/revoke')) {
    return { emoji: '🚫', text: `revoked API key \`${line(ctx.params.keyId) || '?'}\``, colour: COLOUR.danger };
  }

  // ---- funnels ----
  // The funnel name is in its own param, so `key` (stockKey ?? serialKey) is empty here.
  if (r.endsWith('/funnels/:funnelName') && m === 'DELETE') {
    return {
      emoji: '🗑️',
      // Said explicitly because it is not what deleting a stock key does: the game's ingest starts
      // DROPPING events, so silence in the analytics would otherwise look like the game broke.
      text: `deleted funnel **${funnel}** — the game's events are now dropped`,
      colour: COLOUR.danger,
    };
  }
  if (r.endsWith('/funnels/:funnelName/restore')) {
    return { emoji: '♻️', text: `restored funnel **${funnel}**`, colour: COLOUR.create };
  }
  if (r.endsWith('/funnels/:funnelName/purge')) {
    return {
      emoji: '☠️',
      text: `**PURGED** funnel **${funnel}** — every event and run is gone`,
      colour: COLOUR.destroy,
    };
  }
  if (r.endsWith('/funnels/:funnelName') && m === 'PATCH') {
    return { emoji: '✏️', text: `renamed funnel **${funnel}** to "${line(b.displayName) || '—'}"`, colour: COLOUR.edit };
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
    // The message is the operator's own text, headed for a game chat — not a secret. But it is
    // free-form (no upstream charset regex), so it goes through line(): a `panel:write` holder
    // must not be able to smuggle newlines/markdown and forge extra log lines as someone else.
    return { emoji: '📣', text: `published to Roblox topic **${line(b.topic)}**: ${line(b.message)}`, colour: COLOUR.edit };
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
    // Nothing this bot posts may ping anybody. Names in these messages are attacker-influenceable
    // — a funnel name comes from the game, so whoever holds a funnel:write key chooses it — and
    // "@everyone" in a webhook body pings for real unless this is set. Defended at the sink
    // rather than by banning '@' from names, because the name is legitimate data.
    allowed_mentions: { parse: [] as string[] },
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
    // Re-check the host HERE, not just at save time. The URL was validated when it was stored,
    // but DNS can be re-pointed at a private address afterwards (rebinding) — so a webhook that
    // passed once could resolve to postgres:5432 or 169.254.169.254 by the time we deliver.
    // This is fire-and-forget, so the extra lookup costs no request latency.
    await assertSafeWebhookUrl(row.url);
    const res = await fetch(row.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      // NEVER follow a redirect. The allowlist above only vets the host we POST to; a 302 from an
      // allowed host to an internal one would walk straight past it, turning the stored webhook
      // into a blind SSRF primitive. A real Discord/Slack webhook answers 2xx, never 3xx.
      redirect: 'manual',
    });
    status = res.status;
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      error = 'refused a redirect (possible SSRF)';
    } else if (!res.ok) {
      error = `HTTP ${res.status}`;
    }
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
