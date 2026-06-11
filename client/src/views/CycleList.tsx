import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getCurrentUserId } from '../api/client';
import type { Cycle, CycleComment, User } from '../types';
import WorkflowBadge from '../components/common/WorkflowBadge';
import { displayFileName } from '../utils/displayFileName';

interface Props {
  currentUser: User | null;
}

interface NewCycleForm {
  name: string;
  year: string;
  description: string;
}

export default function CycleList({ currentUser }: Props) {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<NewCycleForm>({ name: '', year: String(new Date().getFullYear()), description: '' });
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deletingCycle, setDeletingCycle] = useState<Cycle | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [comments, setComments] = useState<Record<number, CycleComment[]>>({});
  const [commentInput, setCommentInput] = useState<Record<number, string>>({});
  const [postingComment, setPostingComment] = useState<number | null>(null);
  const [expandedComments, setExpandedComments] = useState<Set<number>>(new Set());
  const [uploadingCycleId, setUploadingCycleId] = useState<number | null>(null);
  const [checklistMenuOpen, setChecklistMenuOpen] = useState<number | null>(null);
  const checklistFileRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const navigate = useNavigate();

  const role = currentUser?.role;

  function nextStepHint(c: Cycle): string | null {
    if (c.status === 'draft') {
      if (role === 'Validator') return 'Next: submit this cycle for Senior Validator approval.';
      if (role === 'Senior Validator') return 'Waiting for a Validator to submit for approval.';
      if (role === 'Admin') return null;
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
      if (role === 'Validator') return 'BUs are filling in their responses. You can close this cycle when ready.';
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
      // Load comments for all cycles so they are always visible
      const commentableCycles = data;
      if (commentableCycles.length > 0) {
        const results = await Promise.all(
          commentableCycles.map(c => api.get<CycleComment[]>(`/cycles/${c.id}/comments`).catch((): CycleComment[] => []))
        );
        const nextComments: Record<number, CycleComment[]> = {};
        const autoExpand = new Set<number>();
        commentableCycles.forEach((c, i) => {
          nextComments[c.id] = results[i];
          if (results[i].length > 0) autoExpand.add(c.id);
        });
        setComments(prev => ({ ...prev, ...nextComments }));
        setExpandedComments(prev => new Set([...prev, ...autoExpand]));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (checklistMenuOpen === null) return;
    const close = () => setChecklistMenuOpen(null);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [checklistMenuOpen]);

  async function handleAction(cycleId: number, action: string, body?: object) {
    setActionError(null);
    try {
      await api.put(`/cycles/${cycleId}/${action}`, body);
      const pending = (commentInput[cycleId] ?? '').trim();
      if (pending) {
        await api.post(`/cycles/${cycleId}/comments`, { body: pending });
        setCommentInput(prev => ({ ...prev, [cycleId]: '' }));
      }
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Action failed');
    }
  }


  async function loadComments(cycleId: number) {
    try {
      const data = await api.get<CycleComment[]>(`/cycles/${cycleId}/comments`);
      setComments(prev => ({ ...prev, [cycleId]: data }));
    } catch {}
  }

  function toggleComments(cycleId: number) {
    setExpandedComments(prev => {
      const next = new Set(prev);
      if (next.has(cycleId)) {
        next.delete(cycleId);
      } else {
        next.add(cycleId);
        loadComments(cycleId);
      }
      return next;
    });
  }

  async function handlePostComment(cycleId: number) {
    const body = (commentInput[cycleId] ?? '').trim();
    if (!body) return;
    setPostingComment(cycleId);
    try {
      await api.post(`/cycles/${cycleId}/comments`, { body });
      setCommentInput(prev => ({ ...prev, [cycleId]: '' }));
      await loadComments(cycleId);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to post comment');
    } finally {
      setPostingComment(null);
    }
  }

  async function handleDelete() {
    if (!deletingCycle) return;
    setDeleting(true);
    setActionError(null);
    try {
      await api.delete(`/cycles/${deletingCycle.id}`);
      await load();
      setDeletingCycle(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  async function handleChecklistDownload(c: Cycle) {
    setChecklistMenuOpen(null);
    const headers: Record<string, string> = {};
    const uid = getCurrentUserId();
    if (uid) headers['X-User-Id'] = uid;
    const res = await fetch(`/api/cycles/${c.id}/checklist`, { headers });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = c.checklist_original_name ?? displayFileName(c.checklist_file ?? '');
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleChecklistUpload(cycleId: number, file: File) {
    setUploadingCycleId(cycleId);
    setActionError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      await api.upload(`/cycles/${cycleId}/checklist`, formData);
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
        description: form.description.trim() || undefined,
      });
      setShowModal(false);
      setForm({ name: '', year: String(new Date().getFullYear()), description: '' });
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

  const availableYears = [...new Set(cycles.map(c => c.year))].sort((a, b) => b - a);
  const effectiveYear = (role === 'Validator' || role === 'Senior Validator')
    ? (selectedYear ?? availableYears[0] ?? null)
    : null;
  const visibleCycles = effectiveYear !== null
    ? cycles.filter(c => c.year === effectiveYear)
    : cycles;

  return (
    <div>
      <div className="topbar" style={{ marginBottom: 16 }}>
        <div className="left">
          <strong style={{ fontSize: 18 }}>Validation Cycles</strong>
          <span className="chip">{visibleCycles.length} total</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {(role === 'Validator' || role === 'Senior Validator') && availableYears.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>
                Validation Year
              </span>
              <div style={{
                display: 'flex', alignItems: 'center', position: 'relative',
                background: 'var(--panel)', border: '1px solid var(--line)',
                borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow-md)', overflow: 'hidden',
              }}>
                <div style={{ background: 'var(--accent-dark)', padding: '8px 12px', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                  </svg>
                </div>
                <select
                  value={effectiveYear ?? ''}
                  onChange={e => setSelectedYear(Number(e.target.value))}
                  style={{ border: 'none', outline: 'none', background: 'transparent', fontWeight: 700, fontSize: 14, color: 'var(--text)', padding: '8px 32px 8px 12px', cursor: 'pointer', appearance: 'none', minWidth: 70 }}
                >
                  {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
                <div style={{ pointerEvents: 'none', position: 'absolute', right: 10, color: 'var(--muted)' }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                </div>
              </div>
            </div>
          )}
          {role === 'Admin' && (
            <button className="btn primary" onClick={() => setShowModal(true)}>+ New Cycle</button>
          )}
        </div>
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
            {visibleCycles.length === 0 && (
              <tr><td colSpan={5} className="small" style={{ textAlign: 'center', padding: 32 }}>No cycles found.</td></tr>
            )}
            {visibleCycles.map(c => (
              <React.Fragment key={c.id}>
                <tr>
                  <td>
                    <strong>{c.name}</strong>
                    {c.description && (
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, lineHeight: 1.4 }}>{c.description}</div>
                    )}
                  </td>
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
                      {/* Validator: submit draft for approval + comments */}
                      {c.status === 'draft' && role === 'Validator' && (
                        <>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <input
                              type="text"
                              value={commentInput[c.id] ?? ''}
                              onChange={e => setCommentInput(prev => ({ ...prev, [c.id]: e.target.value }))}
                              placeholder="Note to Senior Validator…"
                              style={{ fontSize: 12, padding: '4px 8px', width: '100%' }}
                            />
                            <button
                              className="btn primary"
                              onClick={() => handleAction(c.id, 'submit')}
                              disabled={!c.checklist_file}
                              title={!c.checklist_file ? 'Upload a checklist file before submitting' : undefined}
                            >
                              Submit for Approval
                            </button>
                          </div>
                          <button className="btn" onClick={() => toggleComments(c.id)}>
                            {expandedComments.has(c.id) ? 'Hide Comments' : 'Comments'}
                          </button>
                        </>
                      )}

                      {/* Senior Validator: approve or reject pending cycles */}
                      {c.status === 'pending_approval' && role === 'Senior Validator' && (
                        <>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <input
                              type="text"
                              value={commentInput[c.id] ?? ''}
                              onChange={e => setCommentInput(prev => ({ ...prev, [c.id]: e.target.value }))}
                              placeholder="Note to Validator…"
                              style={{ fontSize: 12, padding: '4px 8px', width: '100%' }}
                            />
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button className="btn primary" onClick={() => handleAction(c.id, 'approve')}>
                                Approve
                              </button>
                              <button className="btn danger" onClick={() => handleAction(c.id, 'reject')}>
                                Reject
                              </button>
                            </div>
                          </div>
                          {c.checklist_file && (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                              <button
                                className="btn"
                                onClick={() => handleChecklistDownload(c)}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                                </svg>
                                Checklist
                              </button>
                              <span style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                title={c.checklist_original_name ?? displayFileName(c.checklist_file)}>
                                {c.checklist_original_name ?? displayFileName(c.checklist_file)}
                              </span>
                            </div>
                          )}
                          <button className="btn" onClick={() => toggleComments(c.id)}>
                            {expandedComments.has(c.id) ? 'Hide Comments' : 'Comments'}
                          </button>
                        </>
                      )}

                      {/* Validator on pending_approval: checklist download + comments */}
                      {c.status === 'pending_approval' && role === 'Validator' && (
                        <>
                          {c.checklist_file && (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                              <button
                                className="btn"
                                onClick={() => handleChecklistDownload(c)}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                                </svg>
                                Checklist
                              </button>
                              <span style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                title={c.checklist_original_name ?? displayFileName(c.checklist_file)}>
                                {c.checklist_original_name ?? displayFileName(c.checklist_file)}
                              </span>
                            </div>
                          )}
                          <button className="btn" onClick={() => toggleComments(c.id)}>
                            {expandedComments.has(c.id) ? 'Hide Comments' : 'Comments'}
                          </button>
                        </>
                      )}

                      {/* Validator: distribute an approved cycle */}
                      {c.status === 'published' && role === 'Validator' && (
                        <>
                          <button className="btn primary" onClick={() => handleAction(c.id, 'distribute')}>
                            Distribute
                          </button>
                          {c.checklist_file && (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                              <button
                                className="btn"
                                onClick={() => handleChecklistDownload(c)}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                                </svg>
                                Checklist
                              </button>
                              <span style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                title={c.checklist_original_name ?? displayFileName(c.checklist_file)}>
                                {c.checklist_original_name ?? displayFileName(c.checklist_file)}
                              </span>
                            </div>
                          )}
                        </>
                      )}

                      {/* Validator: close a distributed cycle */}
                      {c.status === 'distributed' && role === 'Validator' && (
                        <button className="btn danger" onClick={() => handleAction(c.id, 'close')}>Close</button>
                      )}

                      {c.status === 'closed' && (
                        <button className="btn" onClick={() => navigate('/reports')}>Reports →</button>
                      )}

                      {/* Comments toggle — visible on any cycle that has comments */}
                      {(c.status === 'distributed' || c.status === 'closed') && (comments[c.id] ?? []).length > 0 && (
                        <button className="btn" onClick={() => toggleComments(c.id)}>
                          {expandedComments.has(c.id) ? 'Hide Comments' : `Comments (${(comments[c.id] ?? []).length})`}
                        </button>
                      )}

                      {/* Admin: delete draft or published cycle */}
                      {role === 'Admin' && (c.status === 'draft' || c.status === 'published') && (
                        <button className="btn danger" onClick={() => { setActionError(null); setDeletingCycle(c); }}>Delete</button>
                      )}

                      {/* Validator: checklist button on draft cycles */}
                      {role === 'Validator' && c.status === 'draft' && (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                          <input
                            type="file"
                            accept=".xlsx,.xls,.pdf,.doc,.docx"
                            style={{ display: 'none' }}
                            ref={el => { checklistFileRefs.current[c.id] = el; }}
                            disabled={uploadingCycleId === c.id}
                            onChange={e => {
                              const file = e.target.files?.[0];
                              if (file) handleChecklistUpload(c.id, file);
                              e.target.value = '';
                              setChecklistMenuOpen(null);
                            }}
                          />
                          <div style={{ position: 'relative' }}>
                            <button
                              className="btn"
                              disabled={uploadingCycleId === c.id}
                              onClick={() => {
                                if (!c.checklist_file) {
                                  checklistFileRefs.current[c.id]?.click();
                                } else {
                                  setChecklistMenuOpen(prev => prev === c.id ? null : c.id);
                                }
                              }}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                              </svg>
                              {uploadingCycleId === c.id ? 'Uploading…' : 'Checklist'}
                              {c.checklist_file && (
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                              )}
                            </button>
                            {checklistMenuOpen === c.id && (
                              <div
                                onMouseDown={e => e.stopPropagation()}
                                style={{
                                  position: 'absolute', top: '100%', left: 0, zIndex: 50,
                                  marginTop: 4, minWidth: 140,
                                  background: 'var(--panel)', border: '1px solid var(--line)',
                                  borderRadius: 6, boxShadow: 'var(--shadow-md)',
                                  overflow: 'hidden',
                                }}
                              >
                                <button
                                  onClick={() => handleChecklistDownload(c)}
                                  style={{
                                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                                    padding: '8px 12px', fontSize: 13, color: 'var(--text)',
                                    background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
                                  }}
                                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--hover-bg)')}
                                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                >
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                                  </svg>
                                  View
                                </button>
                                <button
                                  onClick={() => { setChecklistMenuOpen(null); checklistFileRefs.current[c.id]?.click(); }}
                                  style={{
                                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                                    padding: '8px 12px', fontSize: 13, color: 'var(--text)',
                                    background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
                                    borderTop: '1px solid var(--line)',
                                  }}
                                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--hover-bg)')}
                                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                >
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                                  </svg>
                                  Replace
                                </button>
                              </div>
                            )}
                          </div>
                          {c.checklist_file && (
                            <span style={{ fontSize: 11, color: 'var(--muted)', opacity: 0.6, fontStyle: 'italic', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              title={c.checklist_original_name ?? displayFileName(c.checklist_file)}>
                              {c.checklist_original_name ?? displayFileName(c.checklist_file)}
                            </span>
                          )}
                        </div>
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

                {/* Inline comment thread — on published cycles only Admin/Validator/Senior Validator can see comments */}
                {expandedComments.has(c.id) && !(c.status === 'published' && role === 'Responder') && (
                  <tr>
                    <td colSpan={5} style={{ padding: '12px 16px 16px', background: 'var(--panel-alt, rgba(0,0,0,.02))', borderBottom: '1px solid var(--line)' }}>
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>
                          Comments
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                        {(comments[c.id] ?? []).length === 0 && (
                          <div style={{ fontSize: 13, color: 'var(--muted)', fontStyle: 'italic' }}>No comments yet.</div>
                        )}
                        {(comments[c.id] ?? []).map(cm => (
                          <div key={cm.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                            <div style={{
                              width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                              background: cm.user_role === 'Senior Validator' ? 'var(--accent-dark)' : 'var(--accent)',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              color: 'white', fontSize: 11, fontWeight: 700,
                            }}>
                              {cm.user_name.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase()}
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 3 }}>
                                <span style={{ fontSize: 13, fontWeight: 600 }}>{cm.user_name}</span>
                                <span style={{ fontSize: 11, color: 'var(--muted)' }}>{cm.user_role}</span>
                                <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>
                                  {new Date(cm.created_at).toLocaleString()}
                                </span>
                              </div>
                              <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>
                                {cm.body}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                      {(role === 'Validator' || role === 'Senior Validator') && (c.status === 'draft' || c.status === 'pending_approval' || (c.status === 'published' && role === 'Senior Validator')) && (
                        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                          <textarea
                            value={commentInput[c.id] ?? ''}
                            onChange={e => setCommentInput(prev => ({ ...prev, [c.id]: e.target.value }))}
                            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handlePostComment(c.id); }}
                            rows={2}
                            placeholder="Write a comment… (Ctrl+Enter to send)"
                            style={{ flex: 1, resize: 'vertical', fontSize: 13 }}
                          />
                          <button
                            className="btn primary"
                            onClick={() => handlePostComment(c.id)}
                            disabled={postingComment === c.id || !(commentInput[c.id] ?? '').trim()}
                            style={{ alignSelf: 'flex-end' }}
                          >
                            {postingComment === c.id ? 'Posting…' : 'Post'}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Delete Confirmation Modal */}
      {deletingCycle !== null && (
        <div className="modal-backdrop" onClick={() => setDeletingCycle(null)}>
          <div className="modal" style={{ padding: 24, minWidth: 380 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 12px', color: 'var(--danger)' }}>Delete Cycle</h2>
            <p style={{ fontSize: 14, marginBottom: 16, lineHeight: 1.6 }}>
              Are you sure you want to permanently delete <strong>"{deletingCycle.name}"</strong>?
              This action cannot be undone.
            </p>
            {actionError && (
              <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 8 }}>{actionError}</div>
            )}
            <div className="actions">
              <button className="btn danger" onClick={handleDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete Cycle'}
              </button>
              <button className="btn" onClick={() => { setDeletingCycle(null); setActionError(null); }}>Cancel</button>
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
              <div className="field">
                <label>Description <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(optional)</span></label>
                <textarea
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  rows={3}
                  style={{ width: '100%', resize: 'vertical' }}
                  placeholder="Brief description of this cycle's scope or objectives…"
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
