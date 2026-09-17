import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BadgeCheck, ExternalLink, Search } from 'lucide-react';
import { api, isApiError, type RobloxGroup, type RobloxUserLookup } from '../api';
import { useAsync } from '../useAsync';
import { Alert, EmptyState, ErrorState, LoadingState, TimeCell, num } from '../ui';
import { ExperienceView, StaleNote, Stat } from './RobloxOverview';

type Kind = 'user' | 'group' | 'experience';

const KINDS: { kind: Kind; label: string; placeholder: string; hint: string }[] = [
  {
    kind: 'user',
    label: 'User',
    placeholder: 'builderman or 156',
    hint: 'A username, or a numeric user ID.',
  },
  {
    kind: 'group',
    label: 'Group',
    placeholder: '295182 or a roblox.com/communities/… link',
    hint: 'A group ID, or a link to the group page.',
  },
  {
    kind: 'experience',
    label: 'Experience',
    placeholder: '383310974, 920587237 or a roblox.com/games/… link',
    hint: 'A universe ID, a place ID, or a link to the game page.',
  },
];

/**
 * Look up any Roblox user, group or experience — the same data the game-facing API serves, from
 * the same cache. The search lives in the URL, so a result is a link you can send someone.
 */
export function RobloxLookup() {
  const [params, setParams] = useSearchParams();
  const kind = (KINDS.some((k) => k.kind === params.get('type')) ? params.get('type') : 'user') as Kind;
  const q = params.get('q') ?? '';
  const [draft, setDraft] = useState(q);

  // Follow the URL: back/forward, and the in-result links that jump to another lookup.
  useEffect(() => setDraft(q), [q, kind]);

  const go = (nextKind: Kind, nextQ: string) => setParams(nextQ ? { type: nextKind, q: nextQ } : { type: nextKind });
  const meta = KINDS.find((k) => k.kind === kind)!;

  function submit(e: FormEvent) {
    e.preventDefault();
    go(kind, draft.trim());
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Roblox lookup</h1>
          <div className="page-sub">Any user, group or experience on Roblox — live stats, cached for a few minutes.</div>
        </div>
      </div>

      <div className="card">
        <form className="card-body stack" onSubmit={submit}>
          <div className="seg" role="group" aria-label="What to look up" style={{ alignSelf: 'flex-start' }}>
            {KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                className="seg-btn"
                aria-pressed={k.kind === kind}
                onClick={() => go(k.kind, k.kind === kind ? q : '')}
              >
                {k.label}
              </button>
            ))}
          </div>
          <div className="row">
            <div className="search" style={{ flex: 1 }}>
              <Search size={14} />
              <input
                className="input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={meta.placeholder}
                aria-label={meta.hint}
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={!draft.trim()}>
              Look up
            </button>
          </div>
          <span className="hint">{meta.hint}</span>
        </form>
      </div>

      {!q ? (
        <div className="card">
          <EmptyState title={`Look up a ${meta.label.toLowerCase()}`} msg={meta.hint} />
        </div>
      ) : kind === 'user' ? (
        <UserResult key={q} q={q} go={go} />
      ) : kind === 'group' ? (
        <GroupResult key={q} q={q} go={go} />
      ) : (
        <ExperienceResult key={q} q={q} />
      )}
    </div>
  );
}

type Go = (kind: Kind, q: string) => void;

/** A result is either loading, a friendly "nothing there", an error, or the data. */
function useLookup<T>(fn: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]) {
  const r = useAsync(fn, deps);
  const notFound = isApiError(r.error, 'NOT_FOUND');
  return { ...r, notFound };
}

function Missing({ msg }: { msg: string }) {
  return (
    <div className="card">
      <EmptyState title="Nothing found" msg={msg} />
    </div>
  );
}

function UserResult({ q, go }: { q: string; go: Go }) {
  const r = useLookup((signal) => api.lookupRobloxUser(q, signal), [q]);
  if (r.loading && !r.data) return <LoadingState label="Asking Roblox…" />;
  if (r.notFound) return <Missing msg={r.error instanceof Error ? r.error.message : 'No such user.'} />;
  if (r.error || !r.data) return <ErrorState error={r.error} retry={r.reload} />;

  const { profile: p, groups, errors }: RobloxUserLookup = r.data;
  return (
    <div className="stack">
      {errors.profile ? <Alert kind="warn">Profile: {errors.profile}</Alert> : null}
      {p ? (
        <>
          <div className="card">
            <div className="card-body roblox-hero">
              {p.avatarUrl ? <img className="roblox-icon roblox-avatar" src={p.avatarUrl} alt="" referrerPolicy="no-referrer" /> : null}
              <div className="stack" style={{ gap: 4, minWidth: 0, flex: 1 }}>
                <div className="row row-wrap">
                  <a className="roblox-name" href={p.profileUrl} target="_blank" rel="noreferrer">
                    {p.displayName}
                    <ExternalLink size={13} />
                  </a>
                  {p.hasVerifiedBadge ? <BadgeCheck size={16} style={{ color: 'var(--accent)' }} aria-label="Verified" /> : null}
                  {p.isBanned ? <span className="badge badge-danger">banned</span> : null}
                </div>
                <div className="hint">
                  @{p.username} · user <span className="mono">{p.userId}</span> · joined <TimeCell iso={p.createdAt} />
                </div>
                <StaleNote fetchedAt={p.fetchedAt} />
              </div>
            </div>
            {p.description ? <div className="card-body roblox-description">{p.description}</div> : null}
          </div>

          <div className="stats">
            <Stat label="Friends" value={p.friends} />
            <Stat label="Followers" value={p.followers} />
            <Stat label="Following" value={p.following} />
            <Stat label="Groups" value={groups ? groups.length : null} />
          </div>
        </>
      ) : null}

      {errors.groups ? <Alert kind="warn">Groups: {errors.groups}</Alert> : null}
      {groups ? (
        <div className="card">
          <div className="card-head">
            <span className="card-title">Groups ({groups.length})</span>
          </div>
          {groups.length === 0 ? (
            <div className="card-body hint">Not in any group.</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Group</th>
                    <th>Role</th>
                    <th className="num">Rank</th>
                    <th className="num">Members</th>
                  </tr>
                </thead>
                <tbody>
                  {[...groups]
                    .sort((a, b) => b.role.rank - a.role.rank || b.memberCount - a.memberCount)
                    .map((g) => (
                      <tr key={g.groupId}>
                        <td>
                          <button type="button" className="btn-link" onClick={() => go('group', String(g.groupId))}>
                            {g.name}
                          </button>
                          {g.hasVerifiedBadge ? (
                            <BadgeCheck size={13} style={{ color: 'var(--accent)', marginLeft: 4, verticalAlign: 'middle' }} />
                          ) : null}
                        </td>
                        <td>{g.role.name}</td>
                        <td className="num">{g.role.rank}</td>
                        <td className="num">{num(g.memberCount)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** A group id, or the id out of a pasted /communities/<id> or /groups/<id> link. */
function groupIdFrom(q: string): string | null {
  const link = /\/(?:communities|groups)\/(\d{1,16})/i.exec(q);
  const id = link ? link[1]! : q.trim();
  return /^\d{1,16}$/.test(id) ? id : null;
}

function GroupResult({ q, go }: { q: string; go: Go }) {
  const id = groupIdFrom(q);
  const r = useLookup((signal) => (id ? api.getRobloxGroup(id, signal) : Promise.resolve(null)), [id]);
  if (!id) return <Missing msg="That is not a group ID or a group link." />;
  if (r.loading && !r.data) return <LoadingState label="Asking Roblox…" />;
  if (r.notFound) return <Missing msg={`Roblox has no group with ID ${id}.`} />;
  if (r.error || !r.data) return <ErrorState error={r.error} retry={r.reload} />;

  const g: RobloxGroup = r.data;
  return (
    <div className="stack">
      <div className="card">
        <div className="card-body roblox-hero">
          {g.iconUrl ? <img className="roblox-icon" src={g.iconUrl} alt="" referrerPolicy="no-referrer" /> : null}
          <div className="stack" style={{ gap: 4, minWidth: 0, flex: 1 }}>
            <div className="row row-wrap">
              <a className="roblox-name" href={g.url} target="_blank" rel="noreferrer">
                {g.name}
                <ExternalLink size={13} />
              </a>
              {g.hasVerifiedBadge ? <BadgeCheck size={16} style={{ color: 'var(--accent)' }} aria-label="Verified" /> : null}
              <span className={`badge badge-${g.publicEntryAllowed ? 'ok' : 'muted'}`}>
                {g.publicEntryAllowed ? 'anyone can join' : 'join by request'}
              </span>
            </div>
            <div className="hint">
              group <span className="mono">{g.groupId}</span>
              {g.owner ? (
                <>
                  {' '}
                  · owned by{' '}
                  <button type="button" className="btn-link" onClick={() => go('user', String(g.owner!.userId))}>
                    @{g.owner.username}
                  </button>
                </>
              ) : (
                ' · no owner'
              )}
            </div>
            <StaleNote fetchedAt={g.fetchedAt} />
          </div>
        </div>
        {g.description ? <div className="card-body roblox-description">{g.description}</div> : null}
      </div>

      <div className="stats">
        <Stat label="Members" value={g.memberCount} />
        <Stat label="Roles" value={g.roles ? g.roles.length : null} />
      </div>

      {g.shout ? (
        <div className="card">
          <div className="card-head">
            <span className="card-title">Shout</span>
            <span className="hint">
              {g.shout.posterUsername ? `@${g.shout.posterUsername} · ` : ''}
              <TimeCell iso={g.shout.updatedAt} />
            </span>
          </div>
          <div className="card-body roblox-description">{g.shout.body}</div>
        </div>
      ) : null}

      {g.roles === null ? (
        <Alert kind="warn">Roblox did not return this group's roles. Try again shortly.</Alert>
      ) : (
        <div className="card">
          <div className="card-head">
            <span className="card-title">Roles ({g.roles.length})</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="num">Rank</th>
                  <th>Role</th>
                  <th className="num">Members</th>
                  <th className="num">Role ID</th>
                </tr>
              </thead>
              <tbody>
                {[...g.roles].reverse().map((role) => (
                  <tr key={role.roleId}>
                    <td className="num">{role.rank}</td>
                    <td className="cell-strong">{role.name}</td>
                    <td className="num">{num(role.memberCount)}</td>
                    <td className="num mono">{role.roleId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ExperienceResult({ q }: { q: string }) {
  const r = useLookup((signal) => api.lookupRobloxExperience(q, signal), [q]);
  if (r.loading && !r.data) return <LoadingState label="Asking Roblox…" />;
  if (r.notFound) return <Missing msg={r.error instanceof Error ? r.error.message : 'No such experience.'} />;
  if (r.error || !r.data) return <ErrorState error={r.error} retry={r.reload} />;

  return (
    <div className="stack">
      <ExperienceView
        data={r.data}
        onRefresh={r.reload}
        refreshing={r.loading}
        note={
          r.data.resolvedFrom === 'place' ? (
            <div className="hint">Found through its place ID — the universe ID above is what the API takes.</div>
          ) : null
        }
      />
    </div>
  );
}
