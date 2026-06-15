import { useState, useEffect, useCallback, Suspense, lazy } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { api, setCurrentUserId, getCurrentUserId } from '../api/client';
import { getIdentity, identityLabel, isAuthEnabled, logout } from '../auth/oidc';
import type { User, UserRole } from '../types';

// Lazy-loaded views
const Dashboard = lazy(() => import('../views/Dashboard'));
const MyAssignments = lazy(() => import('../views/MyAssignments'));
const ResponseForm = lazy(() => import('../views/ResponseForm'));
const ValidationQueue = lazy(() => import('../views/ValidationQueue'));
const ValidationDetail = lazy(() => import('../views/ValidationDetail'));
const CycleList = lazy(() => import('../views/CycleList'));
const UserManagement = lazy(() => import('../views/UserManagement'));
const Reports = lazy(() => import('../views/Reports'));

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
          {(() => {
            const bu979 = allUsers.filter(u => u.primary_unit_code === '979' && u.role !== 'Responder');
            return bu979.length ? (
              <optgroup key="bu979" label="── BU 979 ──">
                {bu979.map(u => (
                  <option key={u.id} value={u.id}>
                    {u.display_name} · {u.role}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })()}
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

            {hasRole(currentUser, 'Admin', 'Validator', 'Senior Validator') && (
              <NavLink to="/validation">✅ Validation Actions</NavLink>
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

              {hasRole(currentUser, 'Admin', 'Validator', 'Senior Validator') ? (
                <>
                  <Route path="/validation" element={<ValidationQueue />} />
                  <Route path="/validation/:validationId" element={<ValidationDetail />} />
                </>
              ) : (
                <>
                  <Route path="/validation" element={<Navigate to="/" replace />} />
                  <Route path="/validation/:validationId" element={<Navigate to="/" replace />} />
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
