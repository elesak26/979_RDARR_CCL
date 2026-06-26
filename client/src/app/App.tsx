import { useState, useEffect, useCallback, useRef, Suspense, lazy } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { api, setCurrentUserId, getCurrentUserId } from '../api/client';
import { getIdentity, identityLabel, isAuthEnabled, logout } from '../auth/oidc';
import type { User, UserRole } from '../types';

// ── In-app notifications ──────────────────────────────────────────────────────
interface AppNotification {
  id: number;
  title: string;
  body: string;
  cycle_id: number | null;
  link: string | null;
  is_read: boolean;
  created_at: string;
}

function NotificationBell({ userId }: { userId: string | undefined }) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const fetchNotifications = useCallback(async () => {
    if (!userId) return;
    try {
      const data = await api.get<AppNotification[]>('/notifications');
      setItems(data);
    } catch {
      // silent — don't disrupt UI on polling failure
    }
  }, [userId]);

  useEffect(() => {
    fetchNotifications();
    const iv = setInterval(fetchNotifications, 30_000);
    return () => clearInterval(iv);
  }, [fetchNotifications]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const unread = items.filter(n => !n.is_read).length;

  async function markRead(id: number) {
    try {
      await api.put(`/notifications/${id}/read`);
      setItems(prev => prev.filter(n => n.id !== id));
    } catch { /* ignore */ }
  }

  async function markAllRead() {
    try {
      await api.put('/notifications/read-all');
      setItems([]);
    } catch { /* ignore */ }
  }

  if (!userId) return null;

  return (
    <div ref={dropRef} style={{ position: 'relative' }}>
      <button
        className="toolbar__btn"
        onClick={() => setOpen(o => !o)}
        title="Notifications"
        aria-label="Notifications"
        style={{ position: 'relative' }}
      >
        🔔
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: 4, right: 4,
            background: '#e03131', color: '#fff',
            borderRadius: '50%', fontSize: 10, fontWeight: 700,
            minWidth: 16, height: 16, lineHeight: '16px',
            textAlign: 'center', padding: '0 3px',
          }}>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 'calc(100% + 6px)',
          width: 340, maxHeight: 420, overflowY: 'auto',
          background: 'var(--bg)', border: '1px solid var(--border)',
          borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,.25)',
          zIndex: 1000,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px', borderBottom: '1px solid var(--border)',
          }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>Notifications</span>
            {unread > 0 && (
              <button
                className="btn"
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={markAllRead}
              >
                Mark all read
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <div style={{ padding: '20px 14px', color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
              No notifications
            </div>
          ) : items.map(n => (
            <div
              key={n.id}
              onClick={() => {
                markRead(n.id);
                if (n.link) {
                  setOpen(false);
                  navigate(n.link);
                }
              }}
              style={{
                padding: '10px 14px',
                borderBottom: '1px solid var(--border)',
                background: 'rgba(0,163,176,.08)',
                cursor: n.link ? 'pointer' : 'default',
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 3 }}>
                {n.title}
                {n.link && (
                  <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--accent)', opacity: 0.8 }}>→</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>
                {n.body}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, opacity: 0.7 }}>
                {new Date(n.created_at).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Lazy-loaded views
const Dashboard = lazy(() => import('../views/Dashboard'));
const MyAssignments = lazy(() => import('../views/MyAssignments'));
const ResponseForm = lazy(() => import('../views/ResponseForm'));
const ValidationQueue = lazy(() => import('../views/ValidationQueue'));
const ValidationDetail = lazy(() => import('../views/ValidationDetail'));
const CycleList = lazy(() => import('../views/CycleList'));
const UserManagement = lazy(() => import('../views/UserManagement'));
const Reports = lazy(() => import('../views/Reports'));
const ValidationOverview = lazy(() => import('../views/ValidationOverview'));
const ValidationOverviewDetail = lazy(() => import('../views/ValidationOverviewDetail'));

function hasRole(user: User | null, ...roles: UserRole[]): boolean {
  if (!user) return false;
  return roles.includes(user.role);
}

const ROLE_ORDER: UserRole[] = ['Admin', 'Validator', 'Senior Validator', 'Responder', 'Viewer'];

function groupUsersByRole(users: User[]): Map<UserRole, User[]> {
  const map = new Map<UserRole, User[]>();
  for (const role of ROLE_ORDER) map.set(role, []);
  for (const u of users) {
    const list = map.get(u.role) ?? [];
    list.push(u);
    map.set(u.role, list);
  }
  return map;
}

function getTheme(): string {
  return localStorage.getItem('ccl-theme') || 'light';
}
function setTheme(theme: string) {
  localStorage.setItem('ccl-theme', theme);
  document.documentElement.setAttribute('data-theme', theme);
}

// Initialise theme before first render
if (typeof window !== 'undefined') {
  document.documentElement.setAttribute('data-theme', getTheme());
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [theme, setThemeState] = useState<string>(getTheme());

  // currentUserId is read directly from sessionStorage on every request — no restore needed

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [users, me] = await Promise.all([
        api.get<User[]>('/users'),
        api.get<User>('/users/me'),
      ]);
      setAllUsers(users);
      setCurrentUser(me);
      // Always sync the resolved user so every subsequent request (incl. uploads) sends X-User-Id
      setCurrentUserId(me.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Server unreachable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadInitial(); }, [loadInitial]);

  function handleUserSwitch(userId: string) {
    setCurrentUserId(userId);
    loadInitial();
  }

  function toggleTheme() {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    setThemeState(next);
  }

  if (loading) {
    return (
      <div className="layout" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--muted)' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
          <div>Loading…</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="layout" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ textAlign: 'center', maxWidth: 400, padding: 24 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Cannot reach server</div>
          <div className="small" style={{ marginBottom: 16 }}>{error}</div>
          <button className="btn primary" onClick={loadInitial}>Retry</button>
        </div>
      </div>
    );
  }

  const grouped = groupUsersByRole(allUsers);
  const identity = isAuthEnabled() ? getIdentity() : null;

  return (
    <div className="layout">
      {/* Toolbar */}
      <div className="toolbar">
        <img src="/nbg-logo.svg" alt="NBG" className="toolbar__logo" />
        <span className="toolbar__title">NBG CCL — RDARR Compliance Checklist</span>
        <span className="toolbar__spacer" />

        {/* Dev user switcher */}
        <select
          className="toolbar__user-select"
          value={getCurrentUserId() || currentUser?.id || ''}
          onChange={e => handleUserSwitch(e.target.value)}
          title="Dev: switch user"
        >
          {ROLE_ORDER.map(role => {
            const roleUsers = grouped.get(role) ?? [];
            if (!roleUsers.length) return null;
            return (
              <optgroup key={role} label={role}>
                {roleUsers.map(u => (
                  <option key={u.id} value={u.id}>
                    {u.display_name}{u.primary_unit_code ? ` · ${u.primary_unit_code}` : ''}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>

        {currentUser && (
          <div className="toolbar__user">
            <span className="toolbar__role">{currentUser.role}</span>
            <span>{currentUser.display_name}</span>
            {currentUser.primary_unit_code && (
              <span className="toolbar__unit">{currentUser.primary_unit_code}</span>
            )}
          </div>
        )}

        {/* Notification bell */}
        <NotificationBell userId={currentUser?.id} />

        {/* Theme toggle */}
        <button
          className="toolbar__btn"
          onClick={toggleTheme}
          title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          aria-label="Toggle theme"
        >
          {theme === 'light' ? '🌙' : '☀️'}
        </button>

        {/* Signed-in NBG identity (gate) + logout — distinct from the persona dropdown */}
        {identity && (
          <div className="toolbar__user" title="Signed in via NBG Identity">
            <span className="toolbar__role">🔓</span>
            <span>{identityLabel(identity)}</span>
          </div>
        )}
        {isAuthEnabled() && (
          <button
            className="toolbar__btn"
            onClick={() => logout()}
            title="Sign out"
            aria-label="Sign out"
          >
            ⎋
          </button>
        )}
      </div>

      <div className="layout__body">
        {/* Sidebar */}
        {!hasRole(currentUser, 'Viewer') && <aside className="sidebar">
          <nav className="nav">
            <NavLink to="/" end>📊 Dashboard</NavLink>

            {hasRole(currentUser, 'Responder') && (
              <NavLink to="/assignments">📝 My Assignments</NavLink>
            )}

            {hasRole(currentUser, 'Validator') && (
              <NavLink to="/validation">✅ Validation Actions</NavLink>
            )}

            {hasRole(currentUser, 'Senior Validator') && (
              <NavLink to="/validation-overview">📋 Validation Overview</NavLink>
            )}

            {hasRole(currentUser, 'Admin', 'Validator', 'Senior Validator') && (
              <NavLink to="/cycles">🔄 Validation Cycles</NavLink>
            )}

            {hasRole(currentUser, 'Admin') && (
              <NavLink to="/users">👥 Users</NavLink>
            )}

            {hasRole(currentUser, 'Admin', 'Senior Validator', 'Validator') && (
              <NavLink to="/reports">📈 Reports</NavLink>
            )}
          </nav>
        </aside>}

        {/* Main content */}
        <main className="main">
          <Suspense fallback={<div className="small" style={{ padding: 24 }}>Loading view…</div>}>
            <Routes>
              <Route path="/" element={<Dashboard currentUser={currentUser} />} />

              {hasRole(currentUser, 'Responder') ? (
                <>
                  <Route path="/assignments" element={<MyAssignments currentUser={currentUser!} />} />
                  <Route path="/assignments/:responseId" element={<ResponseForm currentUser={currentUser!} />} />
                </>
              ) : (
                <>
                  <Route path="/assignments" element={<Navigate to="/" replace />} />
                  <Route path="/assignments/:responseId" element={<Navigate to="/" replace />} />
                </>
              )}

              {hasRole(currentUser, 'Admin', 'Validator') ? (
                <>
                  <Route path="/validation" element={<ValidationQueue />} />
                  <Route path="/validation/:validationId" element={<ValidationDetail />} />
                </>
              ) : hasRole(currentUser, 'Senior Validator') ? (
                <>
                  <Route path="/validation" element={<Navigate to="/" replace />} />
                  <Route path="/validation/:validationId" element={<ValidationDetail />} />
                </>
              ) : (
                <>
                  <Route path="/validation" element={<Navigate to="/" replace />} />
                  <Route path="/validation/:validationId" element={<Navigate to="/" replace />} />
                </>
              )}

              {hasRole(currentUser, 'Senior Validator') ? (
                <>
                  <Route path="/validation-overview" element={<ValidationOverview />} />
                  <Route path="/validation-overview/:cycleId/:questionId" element={<ValidationOverviewDetail />} />
                </>
              ) : (
                <>
                  <Route path="/validation-overview" element={<Navigate to="/" replace />} />
                  <Route path="/validation-overview/:cycleId/:questionId" element={<Navigate to="/" replace />} />
                </>
              )}

              {hasRole(currentUser, 'Admin', 'Validator', 'Senior Validator') ? (
                <Route path="/cycles" element={<CycleList currentUser={currentUser} />} />
              ) : (
                <Route path="/cycles" element={<Navigate to="/" replace />} />
              )}

              {hasRole(currentUser, 'Admin') ? (
                <Route path="/users" element={<UserManagement />} />
              ) : (
                <Route path="/users" element={<Navigate to="/" replace />} />
              )}

              {hasRole(currentUser, 'Admin', 'Viewer', 'Senior Validator', 'Validator') ? (
                <Route path="/reports" element={<Reports currentUser={currentUser} />} />
              ) : (
                <Route path="/reports" element={<Navigate to="/" replace />} />
              )}

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  );
}
