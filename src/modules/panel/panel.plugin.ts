import type { FastifyInstance } from 'fastify';
import { Errors } from '../../core/errors/app-error';

/**
 * The gate in front of every /v1/panel route.
 *
 * `requireScope('panel:owner')` cannot carry this on its own: an api-key principal used to be
 * minted with `scopes:'*'`, and hasScope() short-circuits on '*', so the key pasted into every
 * Roblox script would have satisfied it. env-store no longer mints a wildcard, but that is
 * defence in depth — this is the actual control, and it is structural: `req.panel` is set only
 * by the cookie branch of the root auth hook, so an api key can never be on the other side of it.
 *
 * Fails closed in both directions. A panel route that forgets `config.session` gets
 * authenticated by x-api-key, which leaves `req.panel` unset and is refused here. A non-panel
 * route that sets `config.session` takes the cookie branch and 401s for want of a cookie.
 */
export function registerPanelGate(scope: FastifyInstance): void {
  const expectedOrigin = scope.config.env.PANEL_ORIGIN;

  scope.addHook('onRequest', async (req, reply) => {
    const mode = req.routeOptions.config?.session;
    if (!mode) throw Errors.forbidden('This route is not reachable with an API key.');
    if (mode !== 'anon' && !req.panel) throw Errors.panelSessionInvalid();

    // SameSite=Strict kills classic CSRF, but same-site is not same-origin: a sibling host
    // still counts as same-site. Checking Origin closes that gap without a token to mint,
    // store, rotate and hand to the SPA. Skipped when unset (dev only — production boot
    // refuses to start without PANEL_ORIGIN).
    if (expectedOrigin && req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers.origin !== expectedOrigin) throw Errors.forbidden('Request origin is not allowed.');
    }

    // Keyed on the flag, never on a URL list: renaming a route would silently drop a user out
    // of the only endpoints that can clear this, locking them out permanently.
    if (req.panel?.mustChangePassword && !req.routeOptions.config?.pwExempt) {
      throw Errors.panelPasswordChangeRequired();
    }

    // The Origin check does nothing against clickjacking — a framed victim's real clicks carry
    // the correct Origin. Caddy sets this too; set it here so a direct hit is covered as well.
    reply.header('Content-Security-Policy', "frame-ancestors 'none'");
  });
}
