import { NavLink, Outlet } from 'react-router-dom';
import { Boxes, LogOut, Layers, UserCircle, Users } from 'lucide-react';
import { useAuth } from './auth';
import { RoleBadge, useToast } from './ui';

export function Shell() {
  const { session, isOwner, signOut } = useAuth();
  const toast = useToast();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <Layers size={14} />
          </span>
          GameApi
        </div>

        <nav className="nav">
          <div className="nav-label">Manage</div>
          <NavLink to="/games" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <Boxes size={15} />
            Games
          </NavLink>
          {/* Hidden for admins. Cosmetic — /users is owner-gated server-side. */}
          {isOwner ? (
            <NavLink to="/accounts" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <Users size={15} />
              Accounts
            </NavLink>
          ) : null}
          <NavLink to="/account" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <UserCircle size={15} />
            My account
          </NavLink>
        </nav>

        <div className="sidebar-foot">
          <div className="who">
            <span className="avatar" aria-hidden>
              {session?.username.charAt(0)}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="who-name">{session?.username}</div>
              <div style={{ marginTop: 2 }}>{session ? <RoleBadge role={session.role} /> : null}</div>
            </div>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            style={{ justifyContent: 'flex-start' }}
            onClick={() => {
              void signOut().catch((e) => toast.error(e));
            }}
          >
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
