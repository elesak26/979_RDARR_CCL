import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api/client';
import type { User, Cycle, Response, Attachment } from '../types';
import WorkflowBadge from '../components/common/WorkflowBadge';

interface Props {
  currentUser: User;
}

const SCORE_LABELS: Record<number, string> = {
  1: 'Non-compliant',
  2: 'Partially compliant',
  3: 'Largely compliant',
  4: 'Fully compliant',
};

function scoreTooltip(r: Response, s: number): string {
  const desc = r[`score_${s}_desc` as keyof Response] as string | null | undefined;
  return desc ? `${SCORE_LABELS[s]}: ${desc}` : SCORE_LABELS[s];
}

function scoreColor(s: number) {
  if (s === 1) return '#ff0000';
  if (s === 2) return '#ffc000';
  if (s === 3) return '#81b848';
  return '#538135';
}

interface ItemDraft {
  score: number | null;
  comments: string;
}

export default function MyAssignments({ currentUser }: Props) {
  const [responses, setResponses] = useState<Response[]>([]);
  const [activeCycles, setActiveCycles] = useState<Cycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [drafts, setDrafts] = useState<Record<number, ItemDraft>>({});
  const [expanded, setExpanded] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<Record<number, Attachment[]>>({});
  const [uploading, setUploading] = useState<Record<number, boolean>>({});
  const fileRefs = useRef<Record<number, HTMLInputElement | null>>({});

  const [savingId, setSavingId] = useState<number | null>(null);
  const [resubmittingId, setResubmittingId] = useState<number | null>(null);
  const [submitAllBusy, setSubmitAllBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Track which cycle IDs were submitted successfully this session
  const [submittedCycles, setSubmittedCycles] = useState<Set<number>>(new Set());
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'submitted'>('all');
  // Which cycle the user is currently working on
  const [selectedCycleId, setSelectedCycleId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cycles = await api.get<Cycle[]>('/cycles');
      const distributed = cycles.filter(c => c.status === 'distributed');
      setActiveCycles(distributed);

      if (distributed.length === 0 || !currentUser.primary_unit_code) {
        setResponses([]);
        setLoading(false);
        return;
      }

      // Default to first cycle if none selected yet
      setSelectedCycleId(prev => prev ?? distributed[0].id);

      const buCode = currentUser.primary_unit_code;
      const perCycle = await Promise.all(
        distributed.map(c =>
          api.get<Response[]>(`/cycles/${c.id}/responses?bu_code=${encodeURIComponent(buCode)}`).catch((): Response[] => [])
        )
      );
      const allResponses = perCycle.flat();
      setResponses(allResponses);

      const init: Record<number, ItemDraft> = {};
      for (const r of allResponses) {
        init[r.id] = { score: r.compliance_score, comments: r.comments ?? '' };
      }
      setDrafts(init);

      // Attachments are loaded lazily when a row is expanded — not upfront
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [currentUser.primary_unit_code]);

  useEffect(() => { load(); }, [load]);

  function setDraft(responseId: number, patch: Partial<ItemDraft>) {
    setDrafts(prev => ({ ...prev, [responseId]: { ...prev[responseId], ...patch } }));
  }

  async function saveDraft(r: Response) {
    const d = drafts[r.id];
    setSavingId(r.id);
    try {
      await api.put(`/cycles/${r.cycle_id}/responses/${r.id}`, {
        compliance_score: d?.score ?? null,
        comments: d?.comments ?? null,
      });
      const updated = await api.get<Response[]>(
        `/cycles/${r.cycle_id}/responses?bu_code=${encodeURIComponent(currentUser.primary_unit_code!)}`
      );
      setResponses(prev => {
        const others = prev.filter(x => x.cycle_id !== r.cycle_id);
        return [...others, ...updated];
      });
    } finally {
      setSavingId(null);
    }
  }

  async function handleResubmit(r: Response) {
    const d = drafts[r.id];
    setResubmittingId(r.id);
    setSubmitError(null);
    try {
      await api.put(`/cycles/${r.cycle_id}/responses/${r.id}`, {
        compliance_score: d?.score ?? null,
        comments: d?.comments ?? null,
      });
      await api.put(`/cycles/${r.cycle_id}/responses/${r.id}/submit`);
      await load();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Re-submit failed');
    } finally {
      setResubmittingId(null);
    }
  }

  async function handleUpload(r: Response, file: File) {
    setUploading(prev => ({ ...prev, [r.id]: true }));
    try {
      const fd = new FormData();
      fd.append('file', file);
      const att = await api.upload<Attachment>(`/cycles/${r.cycle_id}/responses/${r.id}/attachments`, fd);
      setAttachments(prev => ({ ...prev, [r.id]: [...(prev[r.id] ?? []), att] }));
    } finally {
      setUploading(prev => ({ ...prev, [r.id]: false }));
      if (fileRefs.current[r.id]) fileRefs.current[r.id]!.value = '';
    }
  }

  async function handleDeleteAttachment(responseId: number, cycleId: number, attachId: number) {
    await api.delete(`/cycles/${cycleId}/responses/${responseId}/attachments/${attachId}`);
    setAttachments(prev => ({ ...prev, [responseId]: (prev[responseId] ?? []).filter(a => a.id !== attachId) }));
  }

  async function handleSubmitCycle() {
    if (!selectedCycleId) return;
    setSubmitAllBusy(true);
    setSubmitError(null);
    try {
      const pending = responses.filter(
        r => r.cycle_id === selectedCycleId && (r.status === 'draft' || r.status === 'in_progress' || r.status === 'returned')
      );
      for (const r of pending) {
        const d = drafts[r.id];
        await api.put(`/cycles/${r.cycle_id}/responses/${r.id}`, {
          compliance_score: d?.score ?? null,
          comments: d?.comments ?? null,
        });
        await api.put(`/cycles/${r.cycle_id}/responses/${r.id}/submit`);
      }
      setSubmittedCycles(prev => new Set([...prev, selectedCycleId]));
      await load();

      // Auto-advance to next unfinished cycle
      const nextUnfinished = activeCycles.find(c => {
        if (c.id === selectedCycleId) return false;
        const cycleResponses = responses.filter(r => r.cycle_id === c.id);
        return cycleResponses.some(r => r.status === 'draft' || r.status === 'in_progress');
      });
      if (nextUnfinished) {
        setSelectedCycleId(nextUnfinished.id);
        setStatusFilter('all');
      }
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Submit failed');
    } finally {
      setSubmitAllBusy(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) return <div className="small" style={{ padding: 24 }}>Loading assignments…</div>;
  if (error) return (
    <div style={{ color: 'var(--danger)', padding: 16 }}>
      Error: {error} <button className="btn" onClick={load} style={{ marginLeft: 8 }}>Retry</button>
    </div>
  );

  if (activeCycles.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
        <strong>No active cycle</strong>
        <div className="small" style={{ marginTop: 8 }}>There is no distributed cycle at the moment.</div>
      </div>
    );
  }

  if (!currentUser.primary_unit_code) {
    return (
      <div style={{ padding: 32, textAlign: 'center' }}>
        <strong>No unit assigned</strong>
        <div className="small" style={{ marginTop: 8 }}>Your account has no primary unit code. Contact an admin.</div>
      </div>
    );
  }

  const multiCycle = activeCycles.length > 1;
  const activeCycleId = selectedCycleId ?? activeCycles[0].id;
  const selectedCycle = activeCycles.find(c => c.id === activeCycleId) ?? activeCycles[0];

  // All responses, scoped to the currently selected cycle
  const cycleResponses = responses.filter(r => r.cycle_id === activeCycleId);
  const draftResponses = cycleResponses.filter(r => r.status === 'draft' || r.status === 'in_progress' || r.status === 'returned');
  const submittedResponses = cycleResponses.filter(r => r.status === 'submitted');
  const allScored = draftResponses.every(r => (drafts[r.id]?.score ?? null) !== null);
  const allSubmitted = draftResponses.length === 0 && cycleResponses.length > 0;
  const justSubmitted = submittedCycles.has(activeCycleId) && allSubmitted;

  // Status filter pool — within the selected cycle
  const visibleResponses = statusFilter === 'pending'
    ? draftResponses
    : statusFilter === 'submitted'
    ? submittedResponses
    : cycleResponses;

  // Per-cycle completion summary (used by cycle tabs)
  function cycleCompletion(cycleId: number) {
    const rs = responses.filter(r => r.cycle_id === cycleId);
    const submitted = rs.filter(r => r.status === 'submitted').length;
    return { total: rs.length, submitted, done: rs.length > 0 && submitted === rs.length };
  }

  function renderCycleSection(cycle: Cycle, pool: Response[]) {
    const sectionResponses = pool.filter(r => r.cycle_id === cycle.id);
    if (sectionResponses.length === 0) return null;

    const areas = Array.from(new Set(sectionResponses.map(r => r.thematic_area ?? 'General')));

    return (
      <div key={cycle.id}>
        {areas.map(area => {
          const areaResponses = sectionResponses.filter(r => (r.thematic_area ?? 'General') === area);
          return (
            <div key={`${cycle.id}-${area}`} className="panel" style={{ marginBottom: 16 }}>
              <div style={{
                padding: '10px 16px', borderBottom: '1px solid var(--line)',
                background: 'var(--panel2)', display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <strong style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                  {area}
                </strong>
                <span className="chip" style={{ fontSize: 11 }}>
                  {areaResponses.filter(r => (drafts[r.id]?.score ?? null) !== null || r.status === 'submitted').length}/{areaResponses.length} scored
                </span>
              </div>

              {areaResponses.map((r, idx) => {
                const d = drafts[r.id] ?? { score: null, comments: '' };
                const isSubmitted = r.status === 'submitted';
                const isEditable = r.status === 'draft' || r.status === 'in_progress' || r.status === 'returned';
                const isOpen = expanded === r.id;
                const atts = attachments[r.id] ?? [];
                const isUploadingNow = uploading[r.id] ?? false;
                const isSaving = savingId === r.id;

                return (
                  <div key={r.id} style={{ borderBottom: idx < areaResponses.length - 1 ? '1px solid var(--line)' : undefined }}>
                    <div
                      onClick={() => {
                        const opening = !isOpen;
                        setExpanded(opening ? r.id : null);
                        if (opening && attachments[r.id] === undefined) {
                          api.get<Attachment[]>(`/cycles/${r.cycle_id}/responses/${r.id}/attachments`)
                            .then(atts => setAttachments(prev => ({ ...prev, [r.id]: atts })))
                            .catch(() => setAttachments(prev => ({ ...prev, [r.id]: [] })));
                        }
                      }}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '48px 1fr auto auto auto',
                        alignItems: 'center',
                        gap: 12,
                        padding: '12px 16px',
                        cursor: 'pointer',
                        background: isOpen ? 'var(--hover-bg)' : undefined,
                        transition: 'background .12s',
                      }}
                    >
                      <div style={{ fontWeight: 700, color: 'var(--muted)', fontSize: 13 }}>#{r.item_number ?? '—'}</div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                        {r.material_risk && (
                          <span style={{
                            alignSelf: 'flex-start', fontSize: 10, fontWeight: 700,
                            padding: '1px 8px', borderRadius: 999,
                            background: 'rgba(0,123,133,0.12)', color: 'var(--accent)',
                            border: '1px solid var(--accent)', whiteSpace: 'nowrap',
                          }}>
                            {r.material_risk}
                          </span>
                        )}
                        <div style={{
                          fontSize: 13, lineHeight: 1.4,
                          display: '-webkit-box',
                          WebkitLineClamp: isOpen ? undefined : 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: isOpen ? 'visible' : 'hidden',
                        }}>
                          {r.requirement ?? '—'}
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 4 }}>
                        {([1, 2, 3, 4] as const).map(s => {
                          const sel = d.score === s;
                          const col = scoreColor(s);
                          return (
                            <button
                              key={s}
                              onClick={e => { e.stopPropagation(); if (isEditable) setDraft(r.id, { score: s }); }}
                              disabled={!isEditable}
                              title={scoreTooltip(r, s)}
                              style={{
                                width: 30, height: 30, borderRadius: 6,
                                border: sel ? `2px solid ${col}` : '1px solid var(--line)',
                                background: sel ? `${col}22` : 'var(--panel2)',
                                color: sel ? col : 'var(--muted)',
                                fontWeight: 700, fontSize: 13,
                                cursor: isEditable ? 'pointer' : 'default',
                                transition: 'all .12s', flexShrink: 0,
                              }}
                            >
                              {s}
                            </button>
                          );
                        })}
                      </div>

                      <div
                        onClick={e => {
                          e.stopPropagation();
                          const opening = isOpen ? false : true;
                          setExpanded(opening ? r.id : null);
                          if (opening && attachments[r.id] === undefined) {
                            api.get<Attachment[]>(`/cycles/${r.cycle_id}/responses/${r.id}/attachments`)
                              .then(atts => setAttachments(prev => ({ ...prev, [r.id]: atts })))
                              .catch(() => setAttachments(prev => ({ ...prev, [r.id]: [] })));
                          }
                        }}
                        title="Attachments"
                        style={{
                          fontSize: 11, padding: '2px 8px', borderRadius: 999,
                          border: '1px solid var(--line)',
                          background: atts.length > 0 ? 'var(--accent-light)' : 'var(--chip)',
                          color: atts.length > 0 ? 'var(--accent-dark)' : 'var(--muted)',
                          whiteSpace: 'nowrap', cursor: 'pointer',
                        }}
                      >
                        {atts.length > 0 ? `${atts.length} file${atts.length > 1 ? 's' : ''}` : 'No files'}
                      </div>

                      <WorkflowBadge status={r.status} size="sm" />
                    </div>

                    {isOpen && (
                      <div style={{ padding: '16px 20px 20px', borderTop: '1px solid var(--line)', background: 'var(--panel2)' }}>
                        {r.return_comment && (
                          <div style={{
                            marginBottom: 14, padding: '10px 14px',
                            background: 'rgba(255,193,7,0.12)', border: '1px solid var(--warn)',
                            borderRadius: 6, color: '#856404', fontSize: 13,
                          }}>
                            <strong>Returned for revision:</strong> {r.return_comment}
                          </div>
                        )}

                        {r.expectations && (
                          <div style={{
                            marginBottom: 16, padding: '12px 16px',
                            background: 'var(--panel)', border: '1px solid var(--accent)',
                            borderLeft: '4px solid var(--accent)', borderRadius: 6,
                          }}>
                            <div style={{ fontWeight: 600, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--accent)', marginBottom: 6 }}>
                              Expectations
                            </div>
                            <div style={{ fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-line', color: 'var(--text)' }}>
                              {r.expectations}
                            </div>
                          </div>
                        )}

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                          <div>
                            <div className="small" style={{ fontWeight: 600, marginBottom: 10 }}>Compliance Score</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 }}>
                              {([1, 2, 3, 4] as const).map(s => {
                                const sel = d.score === s;
                                const col = scoreColor(s);
                                return (
                                  <button
                                    key={s}
                                    onClick={() => isEditable && setDraft(r.id, { score: s })}
                                    disabled={!isEditable}
                                    title={scoreTooltip(r, s)}
                                    style={{
                                      padding: '12px 6px', borderRadius: 6,
                                      border: sel ? `2px solid ${col}` : '2px solid var(--line)',
                                      background: sel ? `${col}18` : 'var(--panel)',
                                      color: sel ? col : 'var(--muted)',
                                      fontWeight: 700, fontSize: 20,
                                      cursor: isEditable ? 'pointer' : 'default',
                                      transition: 'all .12s',
                                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                                    }}
                                  >
                                    <span>{s}</span>
                                    <span style={{ fontSize: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', opacity: 0.8 }}>
                                      {SCORE_LABELS[s]}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                            {d.score !== null && (
                              <div style={{
                                padding: '8px 12px',
                                background: `${scoreColor(d.score)}10`,
                                border: `1px solid ${scoreColor(d.score)}`,
                                borderRadius: 6, fontSize: 13, lineHeight: 1.5,
                              }}>
                                <strong style={{ color: scoreColor(d.score) }}>Score {d.score}:</strong>{' '}
                                {SCORE_LABELS[d.score]}
                              </div>
                            )}
                          </div>

                          <div>
                            <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Comment</div>
                            {!isEditable ? (
                              <div style={{
                                padding: '10px 12px', background: 'var(--panel)',
                                border: '1px solid var(--line)', borderRadius: 6,
                                fontSize: 13, lineHeight: 1.6, minHeight: 72,
                                color: d.comments ? 'var(--text)' : 'var(--muted)', marginBottom: 14,
                              }}>
                                {d.comments || 'No comment.'}
                              </div>
                            ) : (
                              <textarea
                                value={d.comments}
                                onChange={e => setDraft(r.id, { comments: e.target.value })}
                                placeholder="Add a comment, describe your evidence or rationale…"
                                rows={4}
                                style={{
                                  width: '100%', padding: '8px 12px',
                                  border: '1px solid var(--line)', borderRadius: 6,
                                  background: 'var(--input-bg)', color: 'var(--text)',
                                  fontSize: 13, lineHeight: 1.5, resize: 'vertical',
                                  fontFamily: 'inherit', marginBottom: 14,
                                }}
                              />
                            )}

                            <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Evidence Files</div>
                            {atts.length > 0 && (
                              <div style={{ marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                                {atts.map(a => (
                                  <div key={a.id} style={{
                                    display: 'flex', alignItems: 'center', gap: 8,
                                    padding: '6px 10px', background: 'var(--panel)',
                                    border: '1px solid var(--line)', borderRadius: 6, fontSize: 12,
                                  }}>
                                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {a.file_name}
                                    </span>
                                    <a
                                      href={`/api/cycles/${r.cycle_id}/responses/${r.id}/attachments/${a.id}/download`}
                                      target="_blank"
                                      rel="noreferrer"
                                      style={{ color: 'var(--accent)', fontSize: 11, whiteSpace: 'nowrap' }}
                                      onClick={e => e.stopPropagation()}
                                    >
                                      Download
                                    </a>
                                    {!isSubmitted && (
                                      <button
                                        onClick={e => { e.stopPropagation(); handleDeleteAttachment(r.id, r.cycle_id, a.id); }}
                                        style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: '0 4px', fontSize: 14 }}
                                        title="Remove file"
                                      >
                                        ×
                                      </button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                            {isEditable && (
                              <div>
                                <input
                                  ref={el => { fileRefs.current[r.id] = el; }}
                                  type="file"
                                  id={`file-${r.id}`}
                                  style={{ display: 'none' }}
                                  onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(r, f); }}
                                />
                                <button
                                  className="btn"
                                  onClick={e => { e.stopPropagation(); fileRefs.current[r.id]?.click(); }}
                                  disabled={isUploadingNow}
                                  style={{ fontSize: 12, padding: '5px 12px' }}
                                >
                                  {isUploadingNow ? 'Uploading…' : '+ Attach File'}
                                </button>
                              </div>
                            )}
                          </div>
                        </div>

                        {isEditable && (
                          <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                            <button
                              className="btn"
                              onClick={e => { e.stopPropagation(); saveDraft(r); }}
                              disabled={isSaving || resubmittingId === r.id}
                              style={{ fontSize: 12 }}
                            >
                              {isSaving ? 'Saving…' : 'Save Draft'}
                            </button>
                            {r.status === 'returned' && (
                              <button
                                className="btn primary"
                                onClick={e => { e.stopPropagation(); handleResubmit(r); }}
                                disabled={resubmittingId === r.id || (drafts[r.id]?.score ?? null) === null}
                                title={(drafts[r.id]?.score ?? null) === null ? 'Set a score first' : 'Re-submit this item for validation'}
                                style={{ fontSize: 12 }}
                              >
                                {resubmittingId === r.id ? 'Submitting…' : 'Re-submit'}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div>
      {/* Topbar */}
      <div className="topbar" style={{ marginBottom: 16 }}>
        <div className="left">
          <strong style={{ fontSize: 18 }}>Self-Assessment</strong>
          <span className="chip">{currentUser.primary_unit_code}</span>
          {!multiCycle && (
            <span className="chip">{selectedCycle.name} · {selectedCycle.year}</span>
          )}
          <span className="chip" style={{ background: 'var(--accent-light)', color: 'var(--accent-dark)', borderColor: 'var(--accent)' }}>
            {cycleResponses.length} CCL items
          </span>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="small">
            <span style={{ color: 'var(--warn)', fontWeight: 600 }}>{draftResponses.length}</span> pending ·{' '}
            <span style={{ color: 'var(--ok)', fontWeight: 600 }}>{submittedResponses.length}</span> submitted
          </span>
          {!allSubmitted && (
            <button
              className="btn primary"
              onClick={handleSubmitCycle}
              disabled={submitAllBusy || !allScored || draftResponses.length === 0}
              title={
                !allScored
                  ? 'Score all CCL items before submitting'
                  : draftResponses.length === 0
                  ? 'All items are already submitted'
                  : `Submit ${selectedCycle.name} to RDARR for validation`
              }
              style={{ fontWeight: 600 }}
            >
              {submitAllBusy ? 'Submitting…' : 'Submit Self-Assessment to RDARR Validation Unit'}
            </button>
          )}
        </div>
      </div>

      {/* Cycle picker — shown only when 2+ active cycles */}
      {multiCycle && (
        <div style={{
          marginBottom: 16,
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius2)',
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '8px 14px',
            borderBottom: '1px solid var(--line)',
            background: 'var(--panel2)',
            fontSize: 11, fontWeight: 600, color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '.4px',
          }}>
            Select Validation Cycle
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 0 }}>
            {activeCycles.map((c, idx) => {
              const { total, submitted, done } = cycleCompletion(c.id);
              const isSelected = c.id === activeCycleId;
              return (
                <button
                  key={c.id}
                  onClick={() => { setSelectedCycleId(c.id); setStatusFilter('all'); setExpanded(null); }}
                  style={{
                    flex: '1 1 200px',
                    padding: '12px 16px',
                    border: 'none',
                    borderRight: idx < activeCycles.length - 1 ? '1px solid var(--line)' : 'none',
                    borderBottom: isSelected ? `3px solid var(--accent)` : '3px solid transparent',
                    background: isSelected ? 'var(--accent-light)' : 'var(--panel)',
                    color: isSelected ? 'var(--accent-dark)' : 'var(--text)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background .12s',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <strong style={{ fontSize: 13 }}>{c.name}</strong>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>{c.year}</span>
                    {done && (
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: '1px 6px',
                        borderRadius: 999, background: 'rgba(40,167,69,.15)',
                        color: 'var(--ok)', letterSpacing: '.3px',
                      }}>
                        ✓ DONE
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {/* Mini progress bar */}
                    <div style={{ flex: 1, height: 4, background: 'var(--line)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%',
                        width: `${total > 0 ? (submitted / total) * 100 : 0}%`,
                        background: done ? 'var(--ok)' : 'var(--accent)',
                        borderRadius: 2,
                        transition: 'width .3s ease',
                      }} />
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                      {submitted}/{total} submitted
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Progress bar for selected cycle */}
      {!allSubmitted && (
        <div style={{ marginBottom: 16, padding: '10px 16px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span className="small" style={{ fontWeight: 600 }}>
              Completion Progress{multiCycle ? ` — ${selectedCycle.name}` : ''}
            </span>
            <span className="small">
              {draftResponses.filter(r => (drafts[r.id]?.score ?? null) !== null).length + submittedResponses.length}
              /{cycleResponses.length} scored
            </span>
          </div>
          <div style={{ height: 8, background: 'var(--panel2)', borderRadius: 4, border: '1px solid var(--line)', overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              background: allScored ? 'var(--ok)' : 'var(--accent)',
              borderRadius: 4,
              width: `${((draftResponses.filter(r => (drafts[r.id]?.score ?? null) !== null).length + submittedResponses.length) / Math.max(cycleResponses.length, 1)) * 100}%`,
              transition: 'width .3s ease',
            }} />
          </div>
          {!allScored && (
            <div className="small" style={{ marginTop: 6, color: 'var(--muted)' }}>
              Score all {draftResponses.length} pending item{draftResponses.length !== 1 ? 's' : ''} to unlock the Submit button.
            </div>
          )}
        </div>
      )}

      {/* Status filter tabs */}
      {cycleResponses.length > 0 && (
        <div className="tabs" style={{ marginBottom: 16 }}>
          {([
            { key: 'all', label: `All (${cycleResponses.length})` },
            { key: 'pending', label: `Pending (${draftResponses.length})` },
            { key: 'submitted', label: `Submitted (${submittedResponses.length})` },
          ] as const).map(tab => (
            <button
              key={tab.key}
              className={statusFilter === tab.key ? 'active' : ''}
              onClick={() => setStatusFilter(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {submitError && (
        <div style={{ marginBottom: 12, padding: '10px 14px', background: 'rgba(220,53,69,.08)', border: '1px solid var(--danger)', borderRadius: 6, color: 'var(--danger)', fontSize: 13 }}>
          {submitError}
        </div>
      )}

      {justSubmitted && (
        <div style={{ marginBottom: 12, padding: '10px 14px', background: 'rgba(40,167,69,.08)', border: '1px solid var(--ok)', borderRadius: 6, color: 'var(--ok)', fontSize: 13 }}>
          <strong>{selectedCycle.name}</strong> submitted. The RDARR Validation Unit will now review your responses.
        </div>
      )}

      {cycleResponses.length === 0 && (
        <div style={{ padding: 32, textAlign: 'center' }}>
          <div className="small">No CCL items assigned to your unit for this cycle.</div>
        </div>
      )}

      {visibleResponses.length === 0 && cycleResponses.length > 0 && (
        <div style={{ padding: 32, textAlign: 'center' }}>
          <div className="small">No {statusFilter === 'pending' ? 'pending' : 'submitted'} items.</div>
        </div>
      )}

      {renderCycleSection(selectedCycle, visibleResponses)}

      {/* Sticky footer submit bar */}
      {!allSubmitted && draftResponses.length > 0 && (
        <div style={{
          position: 'sticky', bottom: 0,
          padding: '12px 16px',
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          boxShadow: 'var(--shadow-md)',
          marginTop: 8,
        }}>
          <div className="small">
            {allScored
              ? `All items scored — ready to submit ${multiCycle ? selectedCycle.name : 'your self-assessment'} to RDARR.`
              : `${draftResponses.filter(r => (drafts[r.id]?.score ?? null) === null).length} item${draftResponses.filter(r => (drafts[r.id]?.score ?? null) === null).length !== 1 ? 's' : ''} still need a score.`}
          </div>
          <button
            className="btn primary"
            onClick={handleSubmitCycle}
            disabled={submitAllBusy || !allScored}
            style={{ fontWeight: 600 }}
          >
            {submitAllBusy ? 'Submitting…' : 'Submit Self-Assessment to RDARR Validation Unit'}
          </button>
        </div>
      )}
    </div>
  );
}
