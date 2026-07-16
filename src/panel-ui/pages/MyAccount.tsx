import { useAuth } from '../auth';
import { RoleBadge } from '../ui';
import { PasswordChangeForm } from './ChangePassword';

export function MyAccount() {
  const { session } = useAuth();

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">My account</h1>
          <div className="page-sub">Your sign-in details.</div>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="stat-label">Username</div>
          <div className="stat-value" style={{ fontSize: 'var(--text-lg)' }}>
            {session?.username}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Role</div>
          <div style={{ marginTop: 6 }}>{session ? <RoleBadge role={session.role} /> : null}</div>
        </div>
        <div className="stat">
          <div className="stat-label">User ID</div>
          <div className="mono" style={{ marginTop: 6 }}>
            {session?.userId}
          </div>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 460 }}>
        <div className="card-head">
          <span className="card-title">Change password</span>
        </div>
        <div className="card-body">
          <PasswordChangeForm />
        </div>
      </div>
    </div>
  );
}
