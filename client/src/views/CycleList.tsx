import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getCurrentUserId } from '../api/client';
import type { Cycle, User } from '../types';
import WorkflowBadge from '../components/common/WorkflowBadge';

interface Props {
  currentUser: User | null;
}

interface NewCycleForm {
  name: string;
  year: string;
}

export default function CycleList({ currentUser }: Props) {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<NewCycleForm>({ name: '', year: String(new Date().getFullYear()) });
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rejectingCycleId, setRejectingCycleId] = useState<number | null>(null);
  const [rejectComment, setRejectComment] = useState('');
  const [uploadingCycleId, setUploadingCycleId] = useState<number | null>(null);
  const fileInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const navigate = useNavigate();

  const role = currentUser?.role;

  function nextStepHint(c: Cycle): string | null {
    if (c.status === 'draft') {
      if (role === 'Validator') return 'Next: submit this cycle for Senior Validator approval.';
      if (role === 'Senior Validator') return 'Waiting for a Validator to submit for approval.';
      if (role === 'Admin') return 'Waiting for a Validator to submit for approval.';
    }
    if (c.status === 'pending_approval') {
      if (role === 'Senior Validator') return 'Action required: approve or reject this cycle.';
      return 'Awaiting Senior Validator approval.';
    }
    if (c.status === 'published') {
      if (role === 'Validator') return 'Next: distribute this cycle to BU respondents.';
      return 'Approved — waiting for a Validator to distribute.';
    }
    if (c.status === 'distributed') {
      if (role === 'Admin') return 'BUs are filling in their responses. You can close this cycle when ready.';
      return 'Active — BUs are responding.';
    }
    if (c.status === 'closed') return 'This cycle is closed. View reports for results.';
    return null;
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<Cycle[]>('/cycles');
      setCycles(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleAction(cycleId: number, action: string, body?: object) {
    setActionError(null);
    try {
      await api.put(`/cycles/${cycleId}/${action}`, body);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Action failed');
    }
  }

  async function handleReject(cycleId: number) {
    if (!rejectComment.trim()) return;
    setActionError(null);
    try {
      await api.put(`/cycles/${cycleId}/reject`, { comment: rejectComment.trim() });
      setRejectingCycleId(null);
      setRejectComment('');
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Reject failed');
    }
  }

  async function handleChecklistUpload(cycleId: number, file: File) {
    setUploadingCycleId(cycleId);
    setActionError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const headers: Record<string, string> = {};
      const userId = getCurrentUserId();
      if (userId) headers['X-User-Id'] = userId;
      const res = await fetch(`/api/cycles/${cycleId}/checklist`, { method: 'POST', body: formData, headers });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploadingCycleId(null);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setActionError(null);
    try {
      await api.post<Cycle>('/cycles', {
        name: form.name.trim(),
        year: parseInt(form.year, 10),
      });
      setShowModal(false);
      setForm({ name: '', year: String(new Date().getFullYear()) });
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to create');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="small">Loading cycles…</div>;
  if (error) return (
    <div style={{ color: 'var(--danger)', padding: 16 }}>
      Error: {error} <button className="btn" onClick={load} style={{ marginLeft: 8 }}>Retry</button>
    </div>
  );

  return (
    <div>
      <div className="topbar" style={{ marginBottom: 16 }}>
        <div className="left">
          <strong style={{ fontSize: 18 }}>Validation Cycles</strong>
          <span className="chip">{cycles.length} total</span>
        </div>
        {role === 'Admin' && (
          <button className="btn primary" onClick={() => setShowModal(true)}>+ New Cycle</button>
        )}
      </div>

      {actionError && (
        <div style={{ color: 'var(--danger)', marginBottom: 12, padding: '8px 12px', background: 'rgba(220,53,69,.08)', borderRadius: 6, border: '1px solid var(--danger)' }}>
          {actionError}
        </div>
      )}

      <div className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Year</th>
              <th>Status</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {cycles.length === 0 && (
              <tr><td colSpan={5} className="small" style={{ textAlign: 'center', padding: 32 }}>No cycles yet.</td></tr>
            )}
            {cycles.map(c => (
              <React.Fragment key={c.id}>
                <tr>
                  <td><strong>{c.name}</strong></td>
                  <td>{c.year}</td>
                  <td>
                    <WorkflowBadge status={c.status} size="sm" />
                    {nextStepHint(c) && (
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>
                        {nextStepHint(c)}
                      </div>
                    )}
                  </td>
                  <td className="small">{new Date(c.created_at).toLocaleDateString()}</td>
                  <td>
                    <div className="actions">
                      {/* Validator: submit draft for approval */}
                      {c.status === 'draft' && role === 'Validator' && (
                        <button className="btn primary" onClick={() => handleAction(c.id, 'submit')}>
                          Submit for Approval
                        </button>
                      )}

                      {/* Senior Validator: approve or reject pending cycles */}
                      {c.status === 'pending_approval' && role === 'Senior Validator' && (
                        <>
                          <button className="btn primary" onClick={() => handleAction(c.id, 'approve')}>
                            Approve
                          </button>
                          <button className="btn danger" onClick={() => { setRejectingCycleId(c.id); setRejectComment(''); }}>
                            Reject
                          </button>
                        </>
                      )}

                      {/* Validator: distribute an approved cycle */}
                      {c.status === 'published' && role === 'Validator' && (
                        <button className="btn primary" onClick={() => handleAction(c.id, 'distribute')}>
                          Distribute
                        </button>
                      )}

                      {/* Admin: close a distributed cycle */}
                      {c.status === 'distributed' && role === 'Admin' && (
                        <button className="btn danger" onClick={() => handleAction(c.id, 'close')}>Close</button>
                      )}

                      {c.status === 'closed' && (
                        <button className="btn" onClick={() => navigate('/reports')}>Reports →</button>
                      )}

                      {/* Admin: checklist upload for any cycle */}
                      {role === 'Admin' && (
                        <>
                          <input
                            type="file"
                            accept=".xlsx,.xls,.pdf,.doc,.docx"
                            style={{ display: 'none' }}
                            ref={el => { fileInputRefs.current[c.id] = el; }}
                            onChange={e => {
                              const file = e.target.files?.[0];
                              if (file) handleChecklistUpload(c.id, file);
                              e.target.value = '';
                            }}
                          />
                          <button
                            className="btn"
                            title={c.checklist_file ? 'Replace checklist' : 'Upload checklist'}
                            onClick={() => fileInputRefs.current[c.id]?.click()}
                            disabled={uploadingCycleId === c.id}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                            </svg>
                            {uploadingCycleId === c.id ? 'Uploading…' : c.checklist_file ? 'Replace Checklist' : 'Upload Checklist'}
                          </button>
                          {c.checklist_file && (
                            <span style={{ fontSize: 11, color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                              Checklist uploaded
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>

                {/* Rejection comment banner shown to all when cycle is back in draft */}
                {c.status === 'draft' && c.rejection_comment && (
                  <tr>
                    <td colSpan={5} style={{ padding: '6px 12px 10px', background: 'rgba(220,53,69,.05)', borderBottom: '1px solid var(--line)' }}>
                      <span style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 600 }}>Rejected: </span>
                      <span style={{ fontSize: 12, color: 'var(--danger)' }}>{c.rejection_comment}</span>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Reject modal */}
      {rejectingCycleId !== null && (
        <div className="modal-backdrop" onClick={() => setRejectingCycleId(null)}>
          <div className="modal" style={{ padding: 24, minWidth: 400 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 12px' }}>Reject Cycle</h2>
            <p className="small" style={{ marginBottom: 12, color: 'var(--muted)' }}>
              Please provide a reason for rejection. The Admin will see this comment.
            </p>
            <div className="field">
              <label>Rejection Comment</label>
              <textarea
                value={rejectComment}
                onChange={e => setRejectComment(e.target.value)}
                rows={4}
                style={{ width: '100%', resize: 'vertical' }}
                placeholder="Describe what needs to be changed…"
                autoFocus
              />
            </div>
            {actionError && (
              <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 8 }}>{actionError}</div>
            )}
            <div className="actions" style={{ marginTop: 12 }}>
              <button
                className="btn danger"
                onClick={() => handleReject(rejectingCycleId)}
                disabled={!rejectComment.trim()}
              >
                Confirm Rejection
              </button>
              <button className="btn" onClick={() => setRejectingCycleId(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* New Cycle Modal (Admin only) */}
      {showModal && (
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="modal" style={{ padding: 24, minWidth: 360 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 16px' }}>New Cycle</h2>
            <form className="form" onSubmit={handleCreate}>
              <div className="field">
                <label>Cycle Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. RDARR 2025 H1"
                  required
                  autoFocus
                />
              </div>
              <div className="field">
                <label>Year</label>
                <input
                  type="number"
                  value={form.year}
                  onChange={e => setForm(f => ({ ...f, year: e.target.value }))}
                  min={2020}
                  max={2099}
                  required
                />
              </div>
              {actionError && (
                <div style={{ color: 'var(--danger)', fontSize: 13 }}>{actionError}</div>
              )}
              <div className="actions" style={{ marginTop: 16 }}>
                <button type="submit" className="btn primary" disabled={saving}>
                  {saving ? 'Creating…' : 'Create Cycle'}
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
