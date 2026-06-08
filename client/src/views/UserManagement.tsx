import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import type { User, UserRole, LoginHistoryEntry } from '../types';

const ROLES: UserRole[] = ['Admin', 'Senior Validator', 'Validator', 'Responder', 'Viewer'];

const ROLE_COLORS: Record<UserRole, { bg: string; color: string; border: string }> = {
  'Admin':            { bg: 'rgba(220,53,69,.1)',   color: '#a61c2e', border: 'rgba(220,53,69,.3)'  },
  'Senior Validator': { bg: 'rgba(124,58,237,.1)',  color: '#6d28d9', border: 'rgba(124,58,237,.3)' },
  'Validator':        { bg: 'rgba(0,123,133,.1)',   color: 'var(--accent-dark)', border: 'rgba(0,123,133,.3)' },
  'Responder':        { bg: 'rgba(255,193,7,.15)',  color: '#856404', border: 'rgba(255,193,7,.4)'  },
  'Viewer':           { bg: 'rgba(108,117,125,.1)', color: '#495057', border: 'rgba(108,117,125,.3)' },
};

interface UserForm {
  display_name: string;
  role: UserRole;
  primary_unit_code: string;
  unit_codes: string;
}

const EMPTY_FORM: UserForm = { display_name: '', role: 'Responder', primary_unit_code: '', unit_codes: '' };

function RoleBadge({ role }: { role: string }) {
  const c = ROLE_COLORS[role as UserRole] ?? { bg: 'var(--chip)', color: 'var(--muted)', border: 'var(--line)' };
  return (
    <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>
      {role}
    </span>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700,
      background: active ? 'rgba(40,167,69,.1)' : 'rgba(108,117,125,.1)',
      color: active ? 'var(--ok)' : 'var(--muted)',
      border: `1px solid ${active ? 'rgba(40,167,69,.3)' : 'rgba(108,117,125,.3)'}`,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: active ? 'var(--ok)' : 'var(--muted)', flexShrink: 0 }} />
      {active ? 'Active' : 'Disabled'}
    </span>
  );
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function UserManagement() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add / Edit modal
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [form, setForm] = useState<UserForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Login history
  const [loginHistory, setLoginHistory] = useState<LoginHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyFilterUser, setHistoryFilterUser] = useState('');
  const [historyFilterRole, setHistoryFilterRole] = useState('');

  // Tab
  const [tab, setTab] = useState<'users' | 'history'>('users');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<User[]>('/users');
      setUsers(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const params = new URLSearchParams();
      if (historyFilterUser) params.set('user_id', historyFilterUser);
      if (historyFilterRole) params.set('role', historyFilterRole);
      params.set('limit', '300');
      const data = await api.get<LoginHistoryEntry[]>(`/users/login-history?${params.toString()}`);
      setLoginHistory(data);
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : 'Failed to load login history');
    } finally {
      setHistoryLoading(false);
    }
  }, [historyFilterUser, historyFilterRole]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === 'history') loadHistory(); }, [tab, loadHistory]);

  function openAdd() {
    setEditingUser(null);
    setForm(EMPTY_FORM);
    setActionError(null);
    setShowModal(true);
  }

  function openEdit(user: User) {
    setEditingUser(user);
    setForm({
      display_name: user.display_name,
      role: user.role,
      primary_unit_code: user.primary_unit_code ?? '',
      unit_codes: user.unit_codes.join(', '),
    });
    setActionError(null);
    setShowModal(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setActionError(null);
    const payload = {
      display_name: form.display_name.trim(),
      role: form.role,
      primary_unit_code: form.primary_unit_code.trim() || null,
      unit_codes: form.unit_codes.split(',').map(s => s.trim()).filter(Boolean),
    };
    try {
      if (editingUser) {
        await api.put(`/users/${editingUser.id}`, payload);
      } else {
        await api.post<User>('/users', payload);
      }
      setShowModal(false);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(userId: string) {
    if (!window.confirm('Delete this user? This cannot be undone.')) return;
    setDeletingId(userId);
    setActionError(null);
    try {
      await api.delete(`/users/${userId}`);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeletingId(null);
    }
  }

  async function handleToggleActive(userId: string) {
    setTogglingId(userId);
    setActionError(null);
    try {
      await api.put(`/users/${userId}/toggle-active`);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Toggle failed');
    } finally {
      setTogglingId(null);
    }
  }

  if (loading) return <div className="small">Loading users…</div>;
  if (error) return (
    <div style={{ color: 'var(--danger)', padding: 16 }}>
      Error: {error} <button className="btn" onClick={load} style={{ marginLeft: 8 }}>Retry</button>
    </div>
  );

  const activeCount = users.filter(u => u.is_active).length;
  const disabledCount = users.length - activeCount;

  return (
    <div>
      {/* Header */}
      <div className="topbar" style={{ marginBottom: 16 }}>
        <div className="left">
          <strong style={{ fontSize: 18 }}>User Management</strong>
          <span className="chip">{users.length} users</span>
          {disabledCount > 0 && (
            <span className="chip" style={{ background: 'rgba(220,53,69,.1)', color: 'var(--danger)', border: '1px solid rgba(220,53,69,.2)' }}>
              {disabledCount} disabled
            </span>
          )}
        </div>
        <button className="btn primary" onClick={openAdd}>+ Add User</button>
      </div>

      {actionError && (
        <div style={{ color: 'var(--danger)', marginBottom: 12, padding: '8px 12px', background: 'rgba(220,53,69,.08)', borderRadius: 6, border: '1px solid var(--danger)' }}>
          {actionError}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderBottom: '2px solid var(--line)' }}>
        {(['users', 'history'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 20px', border: 'none', background: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 600,
              color: tab === t ? 'var(--accent)' : 'var(--muted)',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -2,
            }}
          >
            {t === 'users' ? 'Users & Permissions' : 'Login History'}
          </button>
        ))}
      </div>

      {/* ── Users & Permissions tab ── */}
      {tab === 'users' && (
        <>
          {/* Summary cards */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
            {ROLES.map(role => {
              const count = users.filter(u => u.role === role).length;
              const c = ROLE_COLORS[role];
              return (
                <div key={role} style={{
                  flex: '1 1 140px', padding: '12px 16px',
                  background: 'var(--panel)', border: `1px solid ${c.border}`,
                  borderTop: `3px solid ${c.color}`,
                  borderRadius: 'var(--radius2)',
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: c.color, textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4 }}>{role}</div>
                  <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--text)' }}>{count}</div>
                </div>
              );
            })}
          </div>

          <div className="panel">
            <table className="table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Primary Unit</th>
                  <th>Last Login</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 && (
                  <tr><td colSpan={6} className="small" style={{ textAlign: 'center', padding: 32 }}>No users yet.</td></tr>
                )}
                {ROLES.map(role => {
                  const roleUsers = users.filter(u => u.role === role);
                  if (roleUsers.length === 0) return null;
                  return (
                    <React.Fragment key={role}>
                      <tr style={{ background: 'var(--panel2)' }}>
                        <td colSpan={6} style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '6px 12px' }}>
                          {role} ({roleUsers.length})
                        </td>
                      </tr>
                      {roleUsers.map(u => (
                        <tr key={u.id} style={{ opacity: u.is_active ? 1 : 0.55 }}>
                          <td>
                            <div style={{ fontWeight: 600, fontSize: 13 }}>{u.display_name}</div>
                            <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>{u.id}</div>
                          </td>
                          <td><RoleBadge role={u.role} /></td>
                          <td><StatusBadge active={u.is_active} /></td>
                          <td className="small">{u.primary_unit_code ?? <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                          <td className="small" style={{ whiteSpace: 'nowrap', color: u.last_login_at ? 'var(--text)' : 'var(--muted)' }}>
                            {formatDate(u.last_login_at)}
                          </td>
                          <td>
                            <div className="actions">
                              <button className="btn" onClick={() => openEdit(u)} style={{ fontSize: 12, padding: '4px 10px' }}>Edit</button>
                              <button
                                className="btn"
                                onClick={() => handleToggleActive(u.id)}
                                disabled={togglingId === u.id}
                                style={{
                                  fontSize: 12, padding: '4px 10px',
                                  color: u.is_active ? 'var(--danger)' : 'var(--ok)',
                                  borderColor: u.is_active ? 'var(--danger)' : 'var(--ok)',
                                }}
                              >
                                {togglingId === u.id ? '…' : u.is_active ? 'Disable' : 'Enable'}
                              </button>
                              <button
                                className="btn danger"
                                onClick={() => handleDelete(u.id)}
                                disabled={deletingId === u.id}
                                style={{ fontSize: 12, padding: '4px 10px' }}
                              >
                                {deletingId === u.id ? '…' : 'Delete'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Login History tab ── */}
      {tab === 'history' && (
        <div>
          {/* Filters */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span className="small" style={{ color: 'var(--muted)' }}>Filter by User</span>
              <select
                value={historyFilterUser}
                onChange={e => setHistoryFilterUser(e.target.value)}
                style={{ minWidth: 200 }}
              >
                <option value="">All users</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.display_name}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span className="small" style={{ color: 'var(--muted)' }}>Filter by Role</span>
              <select
                value={historyFilterRole}
                onChange={e => setHistoryFilterRole(e.target.value)}
                style={{ minWidth: 160 }}
              >
                <option value="">All roles</option>
                {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <button className="btn" onClick={loadHistory} disabled={historyLoading} style={{ alignSelf: 'flex-end' }}>
              {historyLoading ? 'Loading…' : 'Apply'}
            </button>
          </div>

          {/* Stats row */}
          {!historyLoading && loginHistory.length > 0 && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
              {ROLES.map(role => {
                const count = loginHistory.filter(e => e.role === role).length;
                if (count === 0) return null;
                const c = ROLE_COLORS[role as UserRole];
                return (
                  <div key={role} style={{ padding: '8px 14px', background: 'var(--panel)', border: `1px solid ${c.border}`, borderRadius: 'var(--radius2)', fontSize: 12 }}>
                    <span style={{ fontWeight: 700, color: c.color }}>{role}</span>
                    <span style={{ marginLeft: 8, fontWeight: 700 }}>{count}</span>
                    <span style={{ color: 'var(--muted)', marginLeft: 2 }}>logins</span>
                  </div>
                );
              })}
            </div>
          )}

          {historyError && (
            <div style={{ color: 'var(--danger)', marginBottom: 12, padding: '8px 12px', background: 'rgba(220,53,69,.08)', borderRadius: 6, border: '1px solid var(--danger)' }}>
              {historyError}
            </div>
          )}

          <div className="panel">
            <table className="table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>User</th>
                  <th>Role</th>
                  <th>IP Address</th>
                </tr>
              </thead>
              <tbody>
                {historyLoading && (
                  <tr><td colSpan={5} className="small" style={{ textAlign: 'center', padding: 24 }}>Loading…</td></tr>
                )}
                {!historyLoading && loginHistory.length === 0 && (
                  <tr><td colSpan={5} className="small" style={{ textAlign: 'center', padding: 24 }}>No login history found.</td></tr>
                )}
                {!historyLoading && loginHistory.map(entry => (
                  <tr key={entry.id}>
                    <td style={{ whiteSpace: 'nowrap', color: 'var(--muted)' }}>{formatDate(entry.logged_in_at)}</td>
                    <td><strong>{entry.display_name}</strong></td>
                    <td><RoleBadge role={entry.role} /></td>
                    <td style={{ fontFamily: 'monospace', color: 'var(--muted)' }}>{entry.ip_address ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="modal" style={{ padding: 24, minWidth: 420 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 16px' }}>{editingUser ? 'Edit User' : 'Add User'}</h2>
            <form className="form" onSubmit={handleSave}>
              {!editingUser && (
                <div className="field">
                  <label>User ID</label>
                  <input
                    type="text"
                    value={form.display_name ? form.display_name.toLowerCase().replace(/\s+/g, '-') : ''}
                    readOnly
                    style={{ color: 'var(--muted)', fontFamily: 'monospace', fontSize: 12 }}
                    placeholder="Auto-generated from name"
                  />
                </div>
              )}
              <div className="field">
                <label>Display Name</label>
                <input
                  type="text"
                  value={form.display_name}
                  onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
                  placeholder="e.g. Maria Papadopoulou"
                  required autoFocus
                />
              </div>
              <div className="field">
                <label>Role</label>
                <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value as UserRole }))}>
                  {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>
                  {form.role === 'Admin' && 'Full access: manage users, cycles, reports.'}
                  {form.role === 'Senior Validator' && 'Approve or reject validated assessments.'}
                  {form.role === 'Validator' && 'Evaluate BU self-assessments and submit for approval.'}
                  {form.role === 'Responder' && 'Submit self-assessments for assigned BU questions.'}
                  {form.role === 'Viewer' && 'Read-only access to closed cycle reports.'}
                </div>
              </div>
              <div className="field">
                <label>Primary Unit Code</label>
                <input
                  type="text"
                  value={form.primary_unit_code}
                  onChange={e => setForm(f => ({ ...f, primary_unit_code: e.target.value }))}
                  placeholder="e.g. 966"
                />
              </div>
              <div className="field">
                <label>Unit Codes <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(comma-separated)</span></label>
                <input
                  type="text"
                  value={form.unit_codes}
                  onChange={e => setForm(f => ({ ...f, unit_codes: e.target.value }))}
                  placeholder="e.g. 966, 030"
                />
              </div>
              {actionError && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{actionError}</div>}
              <div className="actions" style={{ marginTop: 16 }}>
                <button type="submit" className="btn primary" disabled={saving}>
                  {saving ? 'Saving…' : editingUser ? 'Save Changes' : 'Add User'}
                </button>
                <button type="button" className="btn" onClick={() => setShowModal(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
