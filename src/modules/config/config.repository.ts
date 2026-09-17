import type { Pool, PoolClient } from 'pg';
import { Errors } from '../../core/errors/app-error';

/**
 * Live game configs. See sql/013_game_config.sql for the model.
 *
 * Limits follow Roblox's Experience Configs where they have one (100,000-character strings and
 * JSON, 1,000 keys), plus a cap on the whole config, because every game server downloads all of
 * it whenever the version changes.
 */
export const CONFIG_LIMITS = {
  maxKeys: 1_000,
  keyPattern: '^[A-Za-z][A-Za-z0-9_.-]{0,99}$',
  maxStringLength: 100_000,
  maxJsonLength: 100_000,
  /** Deeper than any real config, shallow enough that no JSON encoder or Luau copy recurses into trouble. */
  maxJsonDepth: 32,
  maxDescriptionLength: 500,
  maxMessageLength: 500,
  /** Serialized size of the whole config. */
  maxTotalBytes: 1_000_000,
  /** Older versions are dropped past this many; a config's history is for undo, not an archive. */
  keepRevisions: 200,
} as const;

const KEY_REGEX = new RegExp(CONFIG_LIMITS.keyPattern);

/**
 * Names every JS object already answers to ("constructor", "toString", ...). They pass the key
 * pattern, but `key in entries` and `entries[key]` find the inherited member when the key is
 * absent — a removal would never register and a diff would compare against a function.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(Object.prototype));

export type ConfigType = 'string' | 'number' | 'boolean' | 'json';

export interface ConfigEntry {
  type: ConfigType;
  value: unknown;
  description: string;
  /** When this key's value last changed in a publish. Absent on a draft entry not yet published. */
  updatedAt?: string;
}

export type ConfigEntries = Record<string, ConfigEntry>;

/** What a writer sends for one key: the entry, or null to remove the key. */
export type EntryPatch = Record<string, { type: ConfigType; value: unknown; description?: string } | null>;

const own = <T>(o: Record<string, T>, key: string): T | undefined => (Object.hasOwn(o, key) ? o[key] : undefined);

// ---------------------------------------------------------------- pure rules

/**
 * JSON with object keys sorted at every level. Postgres JSONB reorders keys on the way in, so a
 * plain JSON.stringify comparison calls {"sword":1,"shield":2} and {"shield":2,"sword":1}
 * different — which made a no-op edit look like a change that then could not be published.
 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Depth of nested objects/arrays, without recursion (so a hostile 100k-deep value cannot blow the stack). */
function jsonDepth(value: unknown): number {
  let max = 0;
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [v, d] = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (d > max) max = d;
    if (d > CONFIG_LIMITS.maxJsonDepth) return d; // no need to walk the rest
    for (const child of Object.values(v as Record<string, unknown>)) stack.push([child, d + 1]);
  }
  return max;
}

/** Postgres text and JSONB refuse NUL; catch it here as a 400 instead of a 500 from the driver. */
const hasNul = (s: string): boolean => s.includes('\u0000');

/** Validate and normalize one entry. Throws VALIDATION_ERROR naming the key and what is wrong. */
export function validateEntry(key: string, input: { type: unknown; value: unknown; description?: unknown }): ConfigEntry {
  const bad = (why: string) => Errors.validation(`Config "${key}": ${why}`, { key });
  if (!KEY_REGEX.test(key)) {
    throw Errors.validation(`"${key}" is not a valid config key: start with a letter; letters, digits, _ . - only; max 100.`, { key });
  }
  if (RESERVED_KEYS.has(key)) throw Errors.validation(`"${key}" is a reserved name; pick another key.`, { key });

  const description = input.description === undefined || input.description === null ? '' : input.description;
  if (typeof description !== 'string' || description.length > CONFIG_LIMITS.maxDescriptionLength || hasNul(description)) {
    throw bad(`description must be text of at most ${CONFIG_LIMITS.maxDescriptionLength} characters.`);
  }
  const { type, value } = input;
  switch (type) {
    case 'string':
      if (typeof value !== 'string') throw bad('a string config needs a text value.');
      if (value.length > CONFIG_LIMITS.maxStringLength) throw bad(`strings are limited to ${CONFIG_LIMITS.maxStringLength.toLocaleString('en-US')} characters.`);
      if (hasNul(value)) throw bad('text cannot contain a NUL character.');
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw bad('a number config needs a finite number.');
      break;
    case 'boolean':
      if (typeof value !== 'boolean') throw bad('a boolean config needs true or false.');
      break;
    case 'json': {
      // An object or an array — the shape Luau decodes into a table. A bare scalar belongs in one
      // of the other types, and null would read as "no such key" in a game.
      if (value === null || typeof value !== 'object') throw bad('a JSON config needs an object or an array.');
      if (jsonDepth(value) > CONFIG_LIMITS.maxJsonDepth) throw bad(`JSON may nest at most ${CONFIG_LIMITS.maxJsonDepth} levels.`);
      const text = JSON.stringify(value);
      if (text.length > CONFIG_LIMITS.maxJsonLength) throw bad(`JSON is limited to ${CONFIG_LIMITS.maxJsonLength.toLocaleString('en-US')} characters.`);
      if (text.includes('\\u0000')) throw bad('JSON cannot contain a NUL character.');
      break;
    }
    default:
      throw bad('type must be string, number, boolean or json.');
  }
  return { type, value, description: description.trim() };
}

/** Apply a patch onto a base state. Validates every touched key and the whole-config limits. */
export function applyPatch(base: ConfigEntries, patch: EntryPatch): ConfigEntries {
  const next: ConfigEntries = { ...base };
  for (const [key, change] of Object.entries(patch)) {
    if (change === null) {
      delete next[key];
      continue;
    }
    const entry = validateEntry(key, change);
    // A key whose value did not change keeps its updatedAt; publish stamps the ones that did.
    const prev = own(base, key);
    next[key] = prev && sameValue(prev, entry) ? { ...entry, updatedAt: prev.updatedAt } : entry;
  }
  assertWithinLimits(next);
  return next;
}

export function assertWithinLimits(entries: ConfigEntries): void {
  const count = Object.keys(entries).length;
  if (count > CONFIG_LIMITS.maxKeys) {
    throw Errors.validation(`A game can have at most ${CONFIG_LIMITS.maxKeys.toLocaleString('en-US')} configs (this would be ${count}).`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(entries));
  if (bytes > CONFIG_LIMITS.maxTotalBytes) {
    throw Errors.validation(`The whole config would be ${bytes.toLocaleString('en-US')} bytes; the limit is ${CONFIG_LIMITS.maxTotalBytes.toLocaleString('en-US')}.`);
  }
}

/** Same type and value. Descriptions and timestamps are metadata, not something a game reads. */
function sameValue(a: ConfigEntry, b: ConfigEntry): boolean {
  return a.type === b.type && canonical(a.value) === canonical(b.value);
}

export interface EntryChange {
  before: { type: ConfigType; value: unknown } | null;
  after: { type: ConfigType; value: unknown } | null;
  /** Only the description changed — shown in the draft, but not a change a game would see. */
  descriptionOnly?: boolean;
}

/** Per-key difference between two states, keys sorted. Empty object = identical. */
export function diffEntries(before: ConfigEntries, after: ConfigEntries): Record<string, EntryChange> {
  const out: Record<string, EntryChange> = {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    const b = own(before, key);
    const a = own(after, key);
    const slim = (e: ConfigEntry | undefined) => (e ? { type: e.type, value: e.value } : null);
    if (!b || !a) out[key] = { before: slim(b), after: slim(a) };
    else if (!sameValue(b, a)) out[key] = { before: slim(b), after: slim(a) };
    else if (b.description !== a.description) out[key] = { before: slim(b), after: slim(a), descriptionOnly: true };
  }
  return out;
}

/** The values a game reads: `{ key: value }`, no types or metadata. */
export function valuesOf(entries: ConfigEntries): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).map(([k, e]) => [k, e.value]));
}

// ---------------------------------------------------------------- persistence

export interface ConfigState {
  version: number;
  publishedAt: string | null;
  publishedBy: string | null;
  published: ConfigEntries;
  draft: ConfigEntries | null;
  draftRevision: number;
  draftUpdatedAt: string | null;
  draftUpdatedBy: string | null;
  /** published -> draft, precomputed so every reader shows the same diff. Empty without a draft. */
  changes: Record<string, EntryChange>;
}

export interface PublishedValues {
  version: number;
  publishedAt: string | null;
  /**
   * The entries already serialized. Every server downloads the whole config once per publish, and
   * encoding up to a megabyte per request would put that cost on the event loop thousands of times.
   */
  entriesJson: string;
}

/** A version in the history list: which keys changed, not their values (those can be megabytes). */
export interface RevisionSummary {
  version: number;
  publishedAt: string;
  publishedBy: string | null;
  message: string | null;
  changedKeys: string[];
}

export interface RevisionDetail extends Omit<RevisionSummary, 'changedKeys'> {
  changes: Record<string, EntryChange>;
}

const iso = (v: unknown): string | null => (v ? (v as Date).toISOString() : null);

/** Game servers poll this; one database read per game per worker per few seconds is plenty. */
const VALUES_CACHE_MS = 3_000;
/** A draft write waits at most this long for another writer's row lock, rather than holding a pool slot. */
const LOCK_TIMEOUT = '3s';

interface ValuesCache {
  entries: Map<string, { at: number; value: PublishedValues }>;
  /** Concurrent misses for the same game share one query. */
  inflight: Map<string, Promise<PublishedValues>>;
}

/**
 * One values cache per pool, shared by every ConfigRepository on it — the game-facing module and
 * the panel each construct their own, and a publish from either must clear the cache both read.
 */
const cachesByPool = new WeakMap<Pool, ValuesCache>();

export class ConfigRepository {
  private readonly cache: ValuesCache;

  constructor(private readonly pg: Pool) {
    let cache = cachesByPool.get(pg);
    if (!cache) cachesByPool.set(pg, (cache = { entries: new Map(), inflight: new Map() }));
    this.cache = cache;
  }

  /**
   * The hot read. Cached in-process briefly; a publish on this worker clears it after commit.
   * `atLeast` is the version the caller already holds: a cached copy older than that is stale by
   * definition (another worker published), so it is skipped instead of served.
   */
  async values(gameId: string, atLeast = 0): Promise<PublishedValues> {
    const hit = this.cache.entries.get(gameId);
    if (hit && Date.now() - hit.at < VALUES_CACHE_MS && hit.value.version >= atLeast) return hit.value;

    const pending = this.cache.inflight.get(gameId);
    if (pending) return pending;

    const load = (async () => {
      const r = await this.pg.query(`SELECT version, published, published_at FROM game_config WHERE game_id = $1`, [gameId]);
      const row = r.rows[0];
      const value: PublishedValues = row
        ? { version: Number(row.version), publishedAt: iso(row.published_at), entriesJson: JSON.stringify(valuesOf(row.published as ConfigEntries)) }
        : { version: 0, publishedAt: null, entriesJson: '{}' };
      if (this.cache.entries.size > 10_000) this.cache.entries.clear(); // bounded; game ids are checked against keys, but stay safe
      this.cache.entries.set(gameId, { at: Date.now(), value });
      return value;
    })().finally(() => this.cache.inflight.delete(gameId));
    this.cache.inflight.set(gameId, load);
    return load;
  }

  async state(gameId: string): Promise<ConfigState> {
    const r = await this.pg.query(`SELECT * FROM game_config WHERE game_id = $1`, [gameId]);
    return toState(r.rows[0]);
  }

  /** Partial update: listed keys change, null removes a key, everything else stays. */
  patchDraft(gameId: string, patch: EntryPatch, actor: string, expectedRevision?: number): Promise<ConfigState> {
    return this.writeDraft(gameId, actor, expectedRevision, (s) => applyPatch(s.draft ?? s.published, patch));
  }

  /** Full replacement: the body is the whole intended config; keys not listed are removed. */
  overwriteDraft(gameId: string, entries: EntryPatch, actor: string, expectedRevision?: number): Promise<ConfigState> {
    return this.writeDraft(gameId, actor, expectedRevision, (s) => {
      const nulls = Object.entries(entries).filter(([, v]) => v === null);
      if (nulls.length > 0) throw Errors.validation(`An overwrite lists the full config; "${nulls[0]![0]}" cannot be null there.`);
      // Start from published so an unchanged key keeps its updatedAt.
      const removed = Object.fromEntries(Object.keys(s.published).filter((k) => !Object.hasOwn(entries, k)).map((k) => [k, null]));
      return applyPatch(s.published, { ...removed, ...entries });
    });
  }

  discardDraft(gameId: string, actor: string, expectedRevision?: number): Promise<ConfigState> {
    return this.writeDraft(gameId, actor, expectedRevision, () => null);
  }

  /** Stage an old version's full state as the draft. Nothing goes live until it is published. */
  async restore(gameId: string, version: number, actor: string, expectedRevision?: number): Promise<ConfigState> {
    const r = await this.pg.query(`SELECT entries FROM game_config_revision WHERE game_id = $1 AND version = $2`, [gameId, version]);
    if (!r.rows[0]) throw Errors.notFound(`This game has no config version ${version}.`);
    const entries = r.rows[0].entries as ConfigEntries;
    return this.writeDraft(gameId, actor, expectedRevision, (s) => {
      // Keep current updatedAt for keys whose value is the same as now.
      const restored: ConfigEntries = {};
      for (const [k, e] of Object.entries(entries)) {
        const cur = own(s.published, k);
        restored[k] = cur && sameValue(cur, e) ? { ...e, updatedAt: cur.updatedAt } : { type: e.type, value: e.value, description: e.description };
      }
      return restored;
    });
  }

  async publish(gameId: string, actor: string, message: string | null, expectedRevision?: number): Promise<{ version: number; state: ConfigState }> {
    if (message !== null && hasNul(message)) throw Errors.validation('The message cannot contain a NUL character.');
    const out = await this.tx(async (c) => {
      const s = await this.lockState(c, gameId);
      checkRevision(s, expectedRevision);
      if (s.draft === null) throw Errors.conflict('There is nothing to publish: the draft is empty.', { gameId });

      const changes = diffEntries(s.published, s.draft);
      if (Object.keys(changes).length === 0) throw Errors.conflict('The draft is identical to what is published.', { gameId });

      const now = new Date().toISOString();
      const next: ConfigEntries = {};
      for (const [k, e] of Object.entries(s.draft)) {
        const change = own(changes, k);
        const valueChanged = change !== undefined && !change.descriptionOnly;
        next[k] = { type: e.type, value: e.value, description: e.description, updatedAt: valueChanged || !e.updatedAt ? now : e.updatedAt };
      }
      const version = s.version + 1;

      await c.query(
        `INSERT INTO game_config_revision (game_id, version, entries, changes, message, published_by, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [gameId, version, JSON.stringify(next), JSON.stringify(changes), message, actor, now],
      );
      const u = await c.query(
        `UPDATE game_config
         SET version = $2, published = $3, published_at = $4, published_by = $5,
             draft = NULL, draft_revision = draft_revision + 1, draft_updated_at = $4, draft_updated_by = $5
         WHERE game_id = $1
         RETURNING *`,
        [gameId, version, JSON.stringify(next), now, actor],
      );
      await c.query(`DELETE FROM game_config_revision WHERE game_id = $1 AND version <= $2`, [gameId, version - CONFIG_LIMITS.keepRevisions]);
      return { version, state: toState(u.rows[0]) };
    });
    // After COMMIT: cleared inside the transaction, a read in between would re-cache the old version.
    this.cache.entries.delete(gameId);
    return out;
  }

  async revisions(gameId: string, limit: number, offset: number): Promise<{ items: RevisionSummary[]; total: number }> {
    const [rows, count] = await Promise.all([
      this.pg.query(
        // Only the changed key NAMES: the values ride in `changes` and can be megabytes per version.
        `SELECT version, published_at, published_by, message,
                ARRAY(SELECT jsonb_object_keys(changes) ORDER BY 1) AS changed_keys
         FROM game_config_revision
         WHERE game_id = $1 ORDER BY version DESC LIMIT $2 OFFSET $3`,
        [gameId, limit, offset],
      ),
      this.pg.query(`SELECT COUNT(*)::int AS n FROM game_config_revision WHERE game_id = $1`, [gameId]),
    ]);
    return {
      items: rows.rows.map((r) => ({
        version: Number(r.version),
        publishedAt: iso(r.published_at)!,
        publishedBy: (r.published_by as string | null) ?? null,
        message: (r.message as string | null) ?? null,
        changedKeys: (r.changed_keys as string[] | null) ?? [],
      })),
      total: (count.rows[0]?.n as number) ?? 0,
    };
  }

  async revision(gameId: string, version: number): Promise<RevisionDetail> {
    const r = await this.pg.query(
      `SELECT version, published_at, published_by, message, changes FROM game_config_revision WHERE game_id = $1 AND version = $2`,
      [gameId, version],
    );
    const row = r.rows[0];
    if (!row) throw Errors.notFound(`This game has no config version ${version}.`);
    return {
      version: Number(row.version),
      publishedAt: iso(row.published_at)!,
      publishedBy: (row.published_by as string | null) ?? null,
      message: (row.message as string | null) ?? null,
      changes: row.changes as Record<string, EntryChange>,
    };
  }

  /** Read-modify-write of the draft under a row lock, with the optional revision check. */
  private writeDraft(
    gameId: string,
    actor: string,
    expectedRevision: number | undefined,
    compute: (s: ConfigState) => ConfigEntries | null,
  ): Promise<ConfigState> {
    return this.tx(async (c) => {
      const s = await this.lockState(c, gameId);
      checkRevision(s, expectedRevision);
      let draft = compute(s);
      // A draft that ends up identical to what is live is no draft at all.
      if (draft !== null && Object.keys(diffEntries(s.published, draft)).length === 0) draft = null;
      // Nothing moved: no megabyte rewrite, no revision bump that would 409 the next honest writer.
      if (sameDraft(s.draft, draft)) return s;
      const u = await c.query(
        `UPDATE game_config
         SET draft = $2, draft_revision = draft_revision + 1, draft_updated_at = now(), draft_updated_by = $3
         WHERE game_id = $1
         RETURNING *`,
        [gameId, draft === null ? null : JSON.stringify(draft), actor],
      );
      return toState(u.rows[0]);
    });
  }

  /** The config row for this game, created on first write, locked for the transaction. */
  private async lockState(c: PoolClient, gameId: string): Promise<ConfigState> {
    await c.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await c.query(`INSERT INTO game_config (game_id) VALUES ($1) ON CONFLICT (game_id) DO NOTHING`, [gameId]);
    const r = await c.query(`SELECT * FROM game_config WHERE game_id = $1 FOR UPDATE`, [gameId]);
    return toState(r.rows[0]);
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pg.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }
}

/** Two drafts are the same when every key has the same type, value and description. */
function sameDraft(a: ConfigEntries | null, b: ConfigEntries | null): boolean {
  if (a === null || b === null) return a === b;
  const strip = (e: ConfigEntries) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, [v.type, v.value, v.description]]));
  return canonical(strip(a)) === canonical(strip(b));
}

function checkRevision(s: ConfigState, expected: number | undefined): void {
  if (expected !== undefined && expected !== s.draftRevision) {
    throw Errors.conflict('The draft changed since you loaded it. Reload, then apply your edit again.', {
      expectedRevision: expected,
      draftRevision: s.draftRevision,
    });
  }
}

function toState(row: Record<string, unknown> | undefined): ConfigState {
  if (!row) {
    return { version: 0, publishedAt: null, publishedBy: null, published: {}, draft: null, draftRevision: 0, draftUpdatedAt: null, draftUpdatedBy: null, changes: {} };
  }
  const published = row.published as ConfigEntries;
  const draft = (row.draft as ConfigEntries | null) ?? null;
  return {
    version: Number(row.version),
    publishedAt: iso(row.published_at),
    publishedBy: (row.published_by as string | null) ?? null,
    published,
    draft,
    draftRevision: Number(row.draft_revision),
    draftUpdatedAt: iso(row.draft_updated_at),
    draftUpdatedBy: (row.draft_updated_by as string | null) ?? null,
    changes: draft ? diffEntries(published, draft) : {},
  };
}
