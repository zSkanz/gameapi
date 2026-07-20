import type { FastifyInstance } from 'fastify';
import type { ResourceModule } from '../../core/module';
import { FunnelRepository } from './funnel.repository';
import { registerFunnelRoutes } from './funnel.routes';

/** How often the retention sweep runs. Hardcoded — a second knob is config nobody tunes. */
const SWEEP_INTERVAL_MS = 3_600_000; // 1 hour

/** Funnel analytics module. Mounted at /v1/games/:gameId/funnel. */
export const funnelModule: ResourceModule = {
  name: 'funnel',
  register(scope: FastifyInstance): void {
    const repo = new FunnelRepository(scope.pg);
    registerFunnelRoutes(scope, repo);

    // Retention. funnel_event is the first table here that grows with player-seconds rather than
    // with purchases, so unlike the ledgers it needs a horizon or it ends in a full disk.
    // The sweep itself takes pg_try_advisory_lock, so running this on every replica is safe —
    // all but one return immediately.
    const days = scope.config.env.FUNNEL_RETENTION_DAYS;
    if (days > 0) {
      const timer = setInterval(() => {
        void repo
          .sweep(days)
          .then((r) => {
            if (r.eventsDeleted > 0 || r.runsDeleted > 0) scope.log.info(r, 'funnel retention sweep');
          })
          .catch((err: unknown) => scope.log.error({ err }, 'funnel retention sweep failed'));
      }, SWEEP_INTERVAL_MS);
      timer.unref(); // must never hold the process open at shutdown
      scope.addHook('onClose', async () => clearInterval(timer));
    }
  },
};

export default funnelModule;
