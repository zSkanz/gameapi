import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { ok } from '../../core/http/envelope';
import { parseBody } from '../../core/http/schemas';
import { GAME_ID_REGEX } from '../../core/constants';
import type { RouteDoc } from '../../core/docs/types';
import { CONFIG_LIMITS, type ConfigRepository, type EntryPatch } from './config.repository';

const GameParams = z.object({ gameId: z.string().regex(GAME_ID_REGEX) });
const RevisionParams = GameParams.extend({ version: z.coerce.number().int().positive() });

const revision = z.coerce.number().int().min(0).optional();

const EntryInput = z.object({
  type: z.enum(['string', 'number', 'boolean', 'json']),
  value: z.unknown(),
  description: z.string().max(CONFIG_LIMITS.maxDescriptionLength).optional(),
});

export const DraftBody = z
  .object({
    entries: z.record(z.string(), EntryInput.nullable()),
    /** The draftRevision you read. Send it and a concurrent edit is a 409, not a silent overwrite. */
    draftRevision: revision,
  })
  .strict();

const PublishBody = z
  .object({
    message: z.string().trim().max(CONFIG_LIMITS.maxMessageLength).optional(),
    draftRevision: revision,
  })
  .strict();

const RevisionQuery = z.object({ draftRevision: revision });
const ValuesQuery = z.object({ knownVersion: z.coerce.number().int().min(0).optional() });
const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Draft writes carry whole JSON values; the global 16 KB body limit is sized for game traffic. */
const WRITE_BODY_LIMIT = CONFIG_LIMITS.maxTotalBytes + 64_000;

/**
 * Config writes per game per minute, across every key and panel user. A person or a tool editing a
 * config makes a handful; each write can be a megabyte held under a row lock and a pool connection,
 * so the request limiter's thousands-per-minute budget (sized for game traffic) is far too loose.
 */
const WRITES_PER_GAME_PER_MIN = 60;

export interface ConfigAccess {
  /** Route path for a suffix ('' = the config itself). */
  path: (suffix: string) => string;
  /** The published values — what a game reads. */
  read: preHandlerHookHandler[];
  /** Drafts, authors and history: not what a game needs, and not something a leaked game key should see. */
  inspect: preHandlerHookHandler[];
  write: preHandlerHookHandler[];
  /** Extra route config: `session` for the panel, `docs` for the public catalogue. */
  config: (docs: RouteDoc, extra?: Record<string, unknown>) => Record<string, unknown>;
  /** Who did it, as shown in history: a panel username or an API key id. */
  actor: (req: FastifyRequest) => string;
}

const ENTRY_EXAMPLE = { type: 'number', value: 500, description: 'Boss health in the Halloween dungeon' };

/**
 * Live configs. Registered twice, from this one definition: for API keys at
 * /v1/games/:gameId/config (config:read to read values; config:write for everything else) and
 * for the panel (panel:read / panel:write).
 *
 * No Idempotency-Key on the writes. A replayed draft PATCH lands on the same keys with the same
 * values (a no-op that does not even bump the revision), and a replayed publish finds the draft
 * already cleared and answers 409 — never a second version.
 */
export function registerConfigRoutes(app: FastifyInstance, repo: ConfigRepository, access: ConfigAccess): void {
  const docs = (summary: string, extra: Partial<RouteDoc> = {}): RouteDoc => ({
    group: 'Config',
    summary,
    params: { gameId: 'Game identifier (path).' },
    ...extra,
  });

  const writeLimit: preHandlerHookHandler = async (req) => {
    const { gameId } = GameParams.parse(req.params);
    await app.rateLimit(`cfgw:game:${gameId}`, WRITES_PER_GAME_PER_MIN);
  };
  const write = [...access.write, writeLimit];

  // ---- reads ----

  app.get(
    access.path(''),
    {
      preHandler: access.read,
      config: access.config(
        docs(
          'The published config as plain values — what a game reads. Pass ?knownVersion=<version you have> and an ' +
            'unchanged config answers { version, changed: false } without the entries, so polling is cheap. Version 0 ' +
            'means nothing has been published yet. Polls are metered separately from other calls on the key.',
          {
            exampleQuery: '?knownVersion=0',
            responseExample: {
              version: 7,
              changed: true,
              publishedAt: '2026-09-17T12:00:00.000Z',
              entries: { bossHealth: 500, halloweenEnabled: true, shopPrices: { sword: 120, shield: 80 } },
            },
          },
        ),
        // Thousands of servers polling every 15s must not eat the budget stock and serial calls share.
        { rateLimitBucket: 'config-poll' },
      ),
    },
    async (req, reply) => {
      const { gameId } = GameParams.parse(req.params);
      const { knownVersion } = parseBody(ValuesQuery, req.query);
      const v = await repo.values(gameId, knownVersion ?? 0);
      if (knownVersion !== undefined && knownVersion === v.version) return ok({ version: v.version, changed: false }, req.id);
      // The entries were serialized once per version; splice them in rather than re-encode a megabyte.
      const head = JSON.stringify({ version: v.version, changed: true, publishedAt: v.publishedAt });
      const meta = JSON.stringify(ok(null, req.id).meta);
      reply.type('application/json; charset=utf-8');
      return `{"ok":true,"data":${head.slice(0, -1)},"entries":${v.entriesJson}},"meta":${meta}}`;
    },
  );

  app.get(
    access.path('/state'),
    {
      preHandler: access.inspect,
      config: access.config(
        docs(
          'Everything about the config: published entries with type, description and updatedAt; the pending draft (null ' +
            'if none) with its draftRevision; and the per-key changes the draft would publish. Needs config:write.',
          {
            responseExample: {
              version: 7,
              publishedAt: '2026-09-17T12:00:00.000Z',
              publishedBy: 'skanz',
              published: { bossHealth: { ...ENTRY_EXAMPLE, updatedAt: '2026-09-17T12:00:00.000Z' } },
              draft: { bossHealth: { ...ENTRY_EXAMPLE, value: 650 } },
              draftRevision: 12,
              draftUpdatedAt: '2026-09-17T12:05:00.000Z',
              draftUpdatedBy: 'key:gk_ab12cd',
              changes: { bossHealth: { before: { type: 'number', value: 500 }, after: { type: 'number', value: 650 } } },
            },
          },
        ),
      ),
    },
    async (req) => {
      const { gameId } = GameParams.parse(req.params);
      return ok(await repo.state(gameId), req.id);
    },
  );

  app.get(
    access.path('/revisions'),
    {
      preHandler: access.inspect,
      config: access.config(
        docs(
          `Published versions, newest first: message, author and which keys changed (the last ${CONFIG_LIMITS.keepRevisions} are ` +
            'kept). Fetch /revisions/:version for the before/after values. Needs config:write.',
          {
            exampleQuery: '?limit=20&offset=0',
            responseExample: {
              items: [{ version: 7, publishedAt: '2026-09-17T12:00:00.000Z', publishedBy: 'skanz', message: 'Halloween: tougher boss', changedKeys: ['bossHealth'] }],
              total: 7,
              limit: 20,
              offset: 0,
            },
          },
        ),
      ),
    },
    async (req) => {
      const { gameId } = GameParams.parse(req.params);
      const { limit, offset } = parseBody(PageQuery, req.query);
      return ok({ ...(await repo.revisions(gameId, limit, offset)), limit, offset }, req.id);
    },
  );

  app.get(
    access.path('/revisions/:version'),
    {
      preHandler: access.inspect,
      config: access.config(
        docs('One published version with the before/after value of every key it changed. Needs config:write.', {
          params: { gameId: 'Game identifier (path).', version: 'Config version (path).' },
          responseExample: {
            version: 7,
            publishedAt: '2026-09-17T12:00:00.000Z',
            publishedBy: 'skanz',
            message: 'Halloween: tougher boss',
            changes: { bossHealth: { before: { type: 'number', value: 300 }, after: { type: 'number', value: 500 } } },
          },
        }),
      ),
    },
    async (req) => {
      const { gameId, version } = RevisionParams.parse(req.params);
      return ok(await repo.revision(gameId, version), req.id);
    },
  );

  // ---- draft ----

  const draftDoc = (summary: string) =>
    docs(summary, {
      body: DraftBody,
      requestExample: { entries: { bossHealth: ENTRY_EXAMPLE, oldEventFlag: null }, draftRevision: 11 },
      responseExample: { version: 7, draft: { bossHealth: ENTRY_EXAMPLE }, draftRevision: 12, changes: {} },
    });

  app.patch(
    access.path('/draft'),
    {
      bodyLimit: WRITE_BODY_LIMIT,
      preHandler: write,
      config: access.config(
        draftDoc(
          'Stage changes to some keys: each listed key is set (type string/number/boolean/json, value, optional description), ' +
            `null removes it, unlisted keys stay. Nothing reaches games until you publish. Max ${WRITES_PER_GAME_PER_MIN} config writes per game per minute.`,
        ),
      ),
    },
    async (req) => {
      const { gameId } = GameParams.parse(req.params);
      const { entries, draftRevision } = parseBody(DraftBody, req.body);
      return ok(await repo.patchDraft(gameId, entries as EntryPatch, access.actor(req), draftRevision), req.id);
    },
  );

  app.put(
    access.path('/draft'),
    {
      bodyLimit: WRITE_BODY_LIMIT,
      preHandler: write,
      config: access.config(
        draftDoc('Stage the WHOLE config: the listed keys become the entire config, and any published key not listed is removed on publish.'),
      ),
    },
    async (req) => {
      const { gameId } = GameParams.parse(req.params);
      const { entries, draftRevision } = parseBody(DraftBody, req.body);
      return ok(await repo.overwriteDraft(gameId, entries as EntryPatch, access.actor(req), draftRevision), req.id);
    },
  );

  app.delete(
    access.path('/draft'),
    {
      preHandler: write,
      config: access.config(docs('Discard the pending draft. Pass ?draftRevision= to refuse if someone edited it meanwhile.')),
    },
    async (req) => {
      const { gameId } = GameParams.parse(req.params);
      const { draftRevision } = parseBody(RevisionQuery, req.query);
      return ok(await repo.discardDraft(gameId, access.actor(req), draftRevision), req.id);
    },
  );

  // ---- publish / restore ----

  app.post(
    access.path('/publish'),
    {
      preHandler: write,
      config: access.config(
        docs(
          'Publish the draft: it becomes the live config under the next version number, and game servers pick it up on ' +
            'their next poll (the Luau client checks every 15 seconds). 409 if there is no draft or it changes nothing.',
          { body: PublishBody, requestExample: { message: 'Halloween: tougher boss', draftRevision: 12 }, responseExample: { version: 8 } },
        ),
      ),
    },
    async (req) => {
      const { gameId } = GameParams.parse(req.params);
      const { message, draftRevision } = parseBody(PublishBody, req.body);
      const { version, state } = await repo.publish(gameId, access.actor(req), message || null, draftRevision);
      return ok({ version, state }, req.id);
    },
  );

  app.post(
    access.path('/revisions/:version/restore'),
    {
      preHandler: write,
      config: access.config(
        docs('Stage an old version as the draft (replacing any current draft). It does not go live until you publish.', {
          params: { gameId: 'Game identifier (path).', version: 'The version to bring back (path).' },
          body: RevisionQuery,
          requestExample: { draftRevision: 12 },
        }),
      ),
    },
    async (req) => {
      const { gameId, version } = RevisionParams.parse(req.params);
      const { draftRevision } = parseBody(RevisionQuery, req.body);
      return ok(await repo.restore(gameId, version, access.actor(req), draftRevision), req.id);
    },
  );
}
