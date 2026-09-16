import type { FastifyInstance } from 'fastify';
import { ok } from '../../core/http/envelope';
import { Errors } from '../../core/errors/app-error';
import { clearSessionCookie, readSessionCookie, serializeSessionCookie } from '../../core/auth/cookie';
import { equalizeLoginTiming, verifyPassword } from '../../core/auth/password';
import type { PanelSessions } from '../../core/auth/session';
import type { PanelRepository } from './panel.repository';
import { AttemptThrottle, loginBuckets } from './login-throttle';
import { ChangePasswordBody, LoginBody, parseBody } from './panel.schemas';

/**
 * Sign-in, sign-out, whoami, and self-service password change.
 *
 * Every route here is `pwExempt`: they are the only routes reachable while
 * must_change_password is set, and /auth/me has to be among them or the SPA can never read
 * the flag that tells it to show the change-password screen.
 */
export function registerPanelAuthRoutes(
  app: FastifyInstance,
  repo: PanelRepository,
  sessions: PanelSessions,
  throttle: AttemptThrottle,
): void {
  const { env } = app.config;

  app.post(
    '/auth/login',
    { config: { session: 'anon', pwExempt: true } },
    async (req, reply) => {
      const { username, password } = parseBody(LoginBody, req.body, 'VALIDATION_ERROR');

      // Charged BEFORE the hash, and counting attempts rather than failures: a
      // check-then-record split lets N concurrent requests all read 0 and all hash.
      // Only the per-user bucket is cleared on success — clearing the IP bucket would let
      // anyone with an account reset the shared-IP budget at will and keep grinding.
      await throttle.charge(loginBuckets(req.ip, username, env.PANEL_LOGIN_MAX_PER_IP, env.PANEL_LOGIN_MAX_PER_USER));

      const user = await repo.findForAuth(username);
      if (!user || user.disabledAt) {
        // Burn an equivalent scrypt. Without it, an unknown username answers in ~1 ms and a
        // real one in ~123 ms — a user-existence oracle readable straight off the wire.
        await equalizeLoginTiming();
        throw Errors.panelLoginFailed();
      }
      if (!(await verifyPassword(password, user.passwordHash))) throw Errors.panelLoginFailed();

      await throttle.clear(`pl:u:${username.toLowerCase()}`);
      await repo.recordLogin(user.userId);
      const raw = await sessions.create({
        userId: user.userId,
        username: user.username,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
      });
      reply.header('Set-Cookie', serializeSessionCookie(raw));
      return ok(
        { userId: user.userId, username: user.username, role: user.role, mustChangePassword: user.mustChangePassword },
        req.id,
      );
    },
  );

  // 'anon': signing out of an already-dead session is a success, not a 401.
  app.post('/auth/logout', { config: { session: 'anon', pwExempt: true } }, async (req, reply) => {
    const raw = readSessionCookie(req.headers.cookie);
    if (raw) await sessions.destroy(raw);
    reply.header('Set-Cookie', clearSessionCookie());
    return ok({ signedOut: true }, req.id);
  });

  app.get('/auth/me', { config: { session: true, pwExempt: true } }, async (req) => {
    const s = req.panel!;
    return ok(
      { userId: s.userId, username: s.username, role: s.role, mustChangePassword: s.mustChangePassword },
      req.id,
    );
  });

  app.post('/auth/password', { config: { session: true, pwExempt: true } }, async (req, reply) => {
    const s = req.panel!;
    const { currentPassword, newPassword } = parseBody(ChangePasswordBody, req.body, 'VALIDATION_ERROR');

    // Session-gated, so the login buckets never apply here — and RATE_LIMIT_KEY_PER_MIN is
    // sized for the Roblox hot path (6000/min), which against a 4-thread scrypt is no bound
    // at all. Its own bucket, keyed by user.
    await throttle.charge([{ key: `pp:u:${s.userId}`, limit: 10 }]);

    const user = await repo.findForAuth(s.username);
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) throw Errors.panelLoginFailed();

    const updated = await repo.setPassword(s.userId, newPassword);

    // Revoke every session, including this one: a password change is the remediation for a
    // stolen cookie, so leaving other sessions alive would defeat the point.
    await sessions.revokeAll(s.userId);

    // Then mint a fresh one from the row the UPDATE returned — not from the row read above,
    // whose must_change_password is still true and would trap the account in a loop.
    const raw = await sessions.create({
      userId: updated.userId,
      username: updated.username,
      role: updated.role,
      mustChangePassword: updated.mustChangePassword,
    });
    reply.header('Set-Cookie', serializeSessionCookie(raw));
    return ok({ userId: updated.userId, username: updated.username, role: updated.role, mustChangePassword: false }, req.id);
  });
}
