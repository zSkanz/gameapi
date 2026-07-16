import type { FastifyInstance } from 'fastify';
import { ok } from '../../core/http/envelope';
import { requireScope } from '../../core/http/guards';
import { Errors } from '../../core/errors/app-error';
import { generatePassword } from '../../core/auth/password';
import type { PanelSessions } from '../../core/auth/session';
import type { PanelRepository } from './panel.repository';
import { CreateUserBody, UpdateUserBody, UserParams, parseBody } from './panel.schemas';

/**
 * Accounts. Owner-only, and there is no public register — the owner creates every account.
 *
 * No DELETE route: `disabled_at` is the lever, matching revoked_at for keys. That removes the
 * two-mechanisms-drift problem, the last-owner guard on delete, the self-delete guard, and the
 * created_by FK hazard, all at once. A disabled account keeps its audit trail.
 */
export function registerPanelUsersRoutes(app: FastifyInstance, repo: PanelRepository, sessions: PanelSessions): void {
  const owner = { config: { session: true }, preHandler: [requireScope('panel:owner', 'Only an owner can manage accounts.')] };

  app.get('/users', owner, async (req) => ok({ items: await repo.list() }, req.id));

  app.post('/users', owner, async (req, reply) => {
    const { username, role } = parseBody(CreateUserBody, req.body, 'VALIDATION_ERROR');
    // Generated, never chosen by the creator: an operator-picked initial password gets reused
    // across accounts and lives in whatever chat it was pasted into.
    const password = generatePassword();
    const user = await repo.create(username, password, role, req.panel!.userId);
    reply.code(201);
    // The only time this password exists anywhere. Not stored, not refetchable.
    return ok({ user, password }, req.id);
  });

  app.patch('/users/:userId', owner, async (req) => {
    const { userId } = UserParams.parse(req.params);
    const patch = parseBody(UpdateUserBody, req.body, 'VALIDATION_ERROR');
    const user = await repo.update(userId, patch);
    // A demotion or a disable must take effect NOW, not whenever the session happens to expire.
    // The repository's never-zero-owners guard has already committed at this point.
    await sessions.revokeAll(userId);
    return ok(user, req.id);
  });

  app.post('/users/:userId/password', owner, async (req) => {
    const { userId } = UserParams.parse(req.params);
    if (userId === req.panel!.userId) {
      // Not a safety rail — a correctness one. This route sets must_change_password, so an
      // owner resetting themselves here would land in the change-password wall for no reason.
      throw Errors.conflict('Use "change my password" for your own account.', { userId });
    }
    const password = generatePassword();
    const user = await repo.resetPassword(userId, password);
    await sessions.revokeAll(userId); // a reset is remediation; existing sessions must die
    return ok({ user, password }, req.id);
  });
}
