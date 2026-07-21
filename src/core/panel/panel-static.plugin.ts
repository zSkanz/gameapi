import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Errors } from '../errors/app-error';

/**
 * Serves the built admin SPA (src/panel-ui -> dist/panel) at /panel.
 *
 * Not @fastify/static: that registers its own wildcard and exposes no per-route `config`, and
 * `config.public` is the ONLY escape from the root auth hook — without it every asset request
 * would need an x-api-key or a session cookie, which the browser has not got when it is
 * fetching the login page's own JavaScript.
 *
 * Everything is read into memory once at boot rather than per request. That is not just a
 * latency choice: it means no user-controlled string ever reaches the filesystem, so the
 * classic `/panel/assets/../../../etc/passwd` traversal has nowhere to land, and it stays
 * correct under CLUSTER_WORKERS>1 where each worker would otherwise re-stat the same files.
 * The bundle is a few hundred KB and immutable for the process lifetime.
 */

/** Content-hashed filenames make these immutable; http-hooks.ts caches /panel/assets/* forever. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

interface Asset {
  body: Buffer;
  type: string;
}

/**
 * Resolves to <repo>/dist/panel from BOTH src/core/panel (tsx dev) and dist/core/panel
 * (compiled): the two live at the same depth, so one expression covers both.
 */
const PANEL_DIR = path.resolve(__dirname, '../../..', 'dist/panel');

function loadAssets(dir: string): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  if (!existsSync(dir)) return assets;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const type = CONTENT_TYPES[path.extname(entry.name).toLowerCase()];
    if (!type) continue; // .map and anything else Vite emits is not ours to serve
    assets.set(entry.name, { body: readFileSync(path.join(dir, entry.name)), type });
  }
  return assets;
}

export function panelStaticPlugin(app: FastifyInstance): void {
  const indexPath = path.join(PANEL_DIR, 'index.html');
  if (!existsSync(indexPath)) {
    // Register nothing rather than serve a broken shell. `npm run build` always produces it;
    // this is the `npm run dev` path where only `npm run build:panel` was skipped.
    app.log.warn({ panelDir: PANEL_DIR }, 'panel SPA not built — /panel is not served (run: npm run build:panel)');
    return;
  }

  const index = readFileSync(indexPath);
  const assets = loadAssets(path.join(PANEL_DIR, 'assets'));
  app.log.info({ assets: assets.size }, 'panel SPA loaded');

  /**
   * Honest 404 for a missing asset. Only /panel/assets/* gets this treatment — a real browser
   * only ever asks here for a filename the index it was served literally contains, so a miss
   * is a stale cache or a probe, never a route the SPA should try to render.
   */
  app.get('/panel/assets/*', { config: { public: true } }, async (req, reply) => {
    const name = (req.params as Record<string, string>)['*'] ?? '';
    const asset = assets.get(name);
    if (!asset) throw Errors.notFound('Asset not found.');
    reply.type(asset.type);
    return asset.body;
  });

  /**
   * SPA fallback: every other /panel/* path is a client-side route, so it gets index.html and
   * react-router decides. Deliberately NOT gated on an extension sniff (/\.[a-z0-9]+$/):
   * GAME_ID_REGEX permits '.', so /panel/games/my.game.v2 is a perfectly legal deep link that
   * such a check would answer with a JSON 404.
   *
   * Returns the Buffer instead of `reply.send(index)` — with an async handler the send is
   * already in flight when the handler's own return value is dispatched, which is an
   * FST_ERR_REP_ALREADY_SENT on every single panel load.
   */
  const serveIndex = async (_req: FastifyRequest, reply: FastifyReply): Promise<Buffer> => {
    reply.type(CONTENT_TYPES['.html']!);
    // Clickjacking defence on the ONE frameable resource — the SPA document itself. The app's
    // other CSP lives in the /v1/panel API scope and never reaches this HTML, and Caddy's global
    // header only applies once its config is reloaded (which a stale deploy may not have done). So
    // set it here too: unconditional, and independent of any edge layer.
    reply.header('Content-Security-Policy', "frame-ancestors 'none'");
    reply.header('X-Frame-Options', 'DENY');
    return index;
  };

  /**
   * '/panel' needs its own registration, and it is the URL a human actually types.
   *
   * The app sets `ignoreTrailingSlash: true`, which rewrites '/panel/' to '/panel' BEFORE
   * routing — and '/panel' does not match '/panel/*', whose static prefix is '/panel/'. So the
   * wildcard alone covers every deep link while 401ing the panel's own front door. Verified:
   * with only the wildcard, GET /panel/ answered 401 from the root auth hook.
   */
  app.get('/panel', { config: { public: true } }, serveIndex);
  app.get('/panel/*', { config: { public: true } }, serveIndex);
}

