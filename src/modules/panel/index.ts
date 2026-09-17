import type { FastifyInstance } from 'fastify';
import { FunnelRepository } from '../funnel/funnel.repository';
import { StockRepository } from '../stock/stock.repository';
import { SerialRepository } from '../serial/serial.repository';
import { AttemptThrottle } from './login-throttle';
import { registerPanelAuthRoutes } from './auth.routes';
import { registerPanelGamesRoutes } from './games.routes';
import { registerPanelKeysRoutes } from './keys.routes';
import { registerPanelGate } from './panel.plugin';
import { registerPanelSerialRoutes } from './serial.routes';
import { registerPanelStockRoutes } from './stock.routes';
import { registerPanelUsersRoutes } from './users.routes';
import { registerPanelFunnelRoutes } from './funnel.routes';
import { registerPanelRobloxRoutes } from './roblox.routes';
import { registerPanelConfigRoutes } from './config.routes';
import { ConfigRepository } from '../config/config.repository';
import { registerPanelWebhookRoutes, registerWebhookNotifier } from './webhook.routes';
import { PanelRepository } from './panel.repository';

/**
 * The admin panel's API, mounted at /v1/panel.
 *
 * Not a ResourceModule: that interface mounts under /v1/games/:gameId/<name>, and the panel is
 * not a per-game resource — it is the control plane over all of them.
 *
 * The stock and serial repositories are the SAME classes the game-facing modules use. Reusing
 * them is what keeps the atomic write invariants and the ledger in one place instead of two.
 */
export async function panelPlugin(scope: FastifyInstance): Promise<void> {
  const { config, pg, redis } = scope;
  const panelRepo = new PanelRepository(pg);
  const stockRepo = new StockRepository(pg, redis, config);
  const serialRepo = new SerialRepository(pg, config.env.AUTO_PROVISION_GAMES);
  const funnelRepo = new FunnelRepository(pg);
  const throttle = new AttemptThrottle(redis, config.env.REDIS_KEY_PREFIX, config.env.PANEL_LOGIN_WINDOW_SECONDS);

  registerPanelGate(scope);
  // One notifier for the whole scope: every panel mutation is logged by construction, so a new
  // route cannot forget to. It reads req.panel, which is what makes this "people, not games".
  registerWebhookNotifier(scope);

  registerPanelAuthRoutes(scope, panelRepo, scope.panelSessions, throttle);
  registerPanelUsersRoutes(scope, panelRepo, scope.panelSessions);
  registerPanelGamesRoutes(scope);
  registerPanelKeysRoutes(scope);
  registerPanelStockRoutes(scope, stockRepo);
  registerPanelSerialRoutes(scope, serialRepo);
  registerPanelWebhookRoutes(scope);
  registerPanelRobloxRoutes(scope);
  registerPanelFunnelRoutes(scope, funnelRepo);
  registerPanelConfigRoutes(scope, new ConfigRepository(pg));
}
