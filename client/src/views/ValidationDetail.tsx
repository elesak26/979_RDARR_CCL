import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Validation, Response, Cycle, User, Attachment } from '../types';
import WorkflowBadge from '../components/common/WorkflowBadge';
import { displayFileName } from '../utils/displayFileName';
import { useBuNames } from '../hooks/useBuNames';
import { SCORE_LABELS, scoreColor } from '../utils/scores';

export default function ValidationDetail() {
  const { validationId } = useParams<{ validationId: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  const [validation, setValidation] = useState<Validation | null>(null);
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [valScore, setValScore] = useState<number | null>(null);
  const [justification, setJustification] = useState('');
  const [additionalControls, setAdditionalControls] = useState('');
  const [rejectionComment, setRejectionComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [returningResponseId, setReturningResponseId] = useState<number | null>(null);
  const [returnComment, setReturnComment] = useState('');
  const [returning, setReturning] = useState(false);
  const [attachments, setAttachments] = useState<Record<number, Attachment[]>>({});
  const [valAttachments, setValAttachments] = useState<Attachment[]>([]);
  const [uploadingValAttach, setUploadingValAttach] = useState(false);
  const [uploadValWarning, setUploadValWarning] = useState<string | null>(null);
  const valFileRef = useRef<HTMLInputElement | null>(null);
  const [detailResponse, setDetailResponse] = useState<Response | null>(null);
  const buName = useBuNames();

  // cycleId can come from navigation state (from ValidationQueue) or we find it
  const stateData = location.state as { cycleId?: number } | null;

  const findCycleForValidation = useCallback(async (): Promise<number | null> => {
    if (stateData?.cycleId) return stateData.cycleId;
    // Fallback: scan cycles
    const cycles = await api.get<Cycle[]>('/cycles');
    const active = cycles.filter(c => c.status === 'distributed' || c.status === 'closed');
    for (const c of active) {
      try {
        const vals = await api.get<Validation[]>(`/cycles/${c.id}/validations`);
        if (vals.some(v => String(v.id) === validationId)) return c.id;
      } catch { /* skip */ }
    }
    return null;
  }, [stateData?.cycleId, validationId]);

  const load = useCallback(async () => {
    if (!validationId) return;
    setLoading(true);
    setError(null);
    try {
      const [cycleId, me] = await Promise.all([
        findCycleForValidation(),
        api.get<User>('/users/me'),
      ]);
      setCurrentUser(me);
      if (!cycleId) {
        setError('Could not locate the cycle for this validation.');
        return;
      }
      const [val, cycleData] = await Promise.all([
        api.get<Validation>(`/cycles/${cycleId}/validations/${validationId}`),
        api.get<Cycle>(`/cycles/${cycleId}`),
      ]);
      setValidation(val);
      setCycle(cycleData);
      setValScore(val.validation_score);
      setJustification(val.justification ?? '');
      setAdditionalControls(val.additional_controls ?? '');

      // Fetch attachments for every BU response
      const buResponses = val.bu_responses ?? val.responses ?? [];
      const attMap: Record<number, Attachment[]> = {};
      await Promise.all(buResponses.map(async (r: Response) => {
        try {
          attMap[r.id] = await api.get<Attachment[]>(`/cycles/${cycleId}/responses/${r.id}/attachments`);
        } catch {
          attMap[r.id] = [];
        }
      }));
      setAttachments(attMap);

      // Fetch validation-level attachments
      try {
        const va = await api.get<Attachment[]>(`/cycles/${cycleId}/validations/${validationId}/attachments`);
        setValAttachments(va);
      } catch {
        setValAttachments([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [validationId, findCycleForValidation]);

  useEffect(() => { load(); }, [load]);

  async function handleSave() {
    if (!validation || !cycle) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      await api.put(`/cycles/${cycle.id}/validations/${validation.id}`, {
        validation_score: valScore,
        justification,
        additional_controls: additionalControls,
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  // After completing an action, navigate to the next item in the queue that needs the same role's attention.
  async function navigateToNext(actionableStatuses: string[]) {
    if (!cycle || !validation) { navigate('/validation'); return; }
    try {
      const all = await api.get<Validation[]>(`/cycles/${cycle.id}/validations`);
      // Same sort order as ValidationQueue: status priority then item_number then bu_code
      const order: Record<string, number> = { rejected: 0, in_review: 1, returned: 2, pending_approval: 3, pending: 4, closed: 5 };
      const queue = all
        .filter(v => actionableStatuses.includes(v.status) && v.id !== validation.id)
        .sort((a, b) => {
          const sd = (order[a.status] ?? 99) - (order[b.status] ?? 99);
          if (sd !== 0) return sd;
          const id = (a.item_number ?? 0) - (b.item_number ?? 0);
          if (id !== 0) return id;
          return (a.bu_code ?? '').localeCompare(b.bu_code ?? '');
        });
      if (queue.length > 0) {
        navigate(`/validation/${queue[0].id}`, { state: { cycleId: cycle.id } });
      } else {
        navigate('/validation');
      }
    } catch {
      navigate('/validation');
    }
  }

  async function handleSubmitForApproval() {
    if (!validation || !cycle) return;
    setSubmitting(true);
    setSaveError(null);
    try {
      await api.put(`/cycles/${cycle.id}/validations/${validation.id}`, {
        validation_score: valScore,
        justification,
        additional_controls: additionalControls,
      });
      await api.put(`/cycles/${cycle.id}/validations/${validation.id}/close`);
      await navigateToNext(['in_review', 'rejected']);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Submit for approval failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleApprove() {
    if (!validation || !cycle) return;
    setApproving(true);
    setSaveError(null);
    try {
      await api.put(`/cycles/${cycle.id}/validations/${validation.id}/approve`);
      await navigateToNext(['pending_approval']);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Approve failed');
    } finally {
      setApproving(false);
    }
  }

  async function handleReject() {
    if (!validation || !cycle) return;
    if (!rejectionComment.trim()) {
      setSaveError('Please provide a rejection comment.');
      return;
    }
    setRejecting(true);
    setSaveError(null);
    try {
      await api.put(`/cycles/${cycle.id}/validations/${validation.id}/reject`, {
        rejection_comment: rejectionComment,
      });
      setRejectionComment('');
      await navigateToNext(['pending_approval']);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Reject failed');
    } finally {
      setRejecting(false);
    }
  }

  async function handleValAttachUpload(file: File) {
    if (!validation || !cycle) return;
    setUploadingValAttach(true);
    setUploadValWarning(null);
    setSaveError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const saved = await api.upload<Attachment>(`/cycles/${cycle.id}/validations/${validation.id}/attachments`, formData);
      setValAttachments(prev => [...prev, saved]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Upload failed';
      setUploadValWarning(msg);
    } finally {
      setUploadingValAttach(false);
    }
  }

  async function handleValAttachDelete(attachId: number) {
    if (!validation || !cycle) return;
    try {
      await api.delete(`/cycles/${cycle.id}/validations/${validation.id}/attachments/${attachId}`);
      setValAttachments(prev => prev.filter(a => a.id !== attachId));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  async function handleReturn() {
    if (!validation || !cycle || returningResponseId === null) return;
    setReturning(true);
    setSaveError(null);
    try {
      await api.put(`/cycles/${cycle.id}/responses/${returningResponseId}/return`, {
        return_comment: returnComment.trim() || null,
      });
      setReturningResponseId(null);
      setReturnComment('');
      await load();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Return failed');
    } finally {
      setReturning(false);
    }
  }

  function scoreDesc(v: typeof validation, score: number | null): string | null {
    if (!v || score === null) return null;
    if (score === 1) return v.score_1_desc ?? null;
    if (score === 2) return v.score_2_desc ?? null;
    if (score === 3) return v.score_3_desc ?? null;
    if (score === 4) return v.score_4_desc ?? null;
    return null;
  }

  if (loading) return <div className="small" style={{ padding: 24 }}>Loading validation…</div>;
  if (error) return (
    <div style={{ color: 'var(--danger)', padding: 16 }}>
      Error: {error}
      <button className="btn" onClick={() => navigate('/validation')} style={{ marginLeft: 12 }}>Back</button>
    </div>
  );
  if (!validation) return null;

  const responses = (validation.bu_responses ?? validation.responses ?? []) as Response[];
  const isClosed = validation.status === 'closed';
  const isPendingApproval = validation.status === 'pending_approval';
  const isInReview = validation.status === 'in_review';
  const isReturned = validation.status === 'returned';
  const isRejected = validation.status === 'rejected';
  const isSeniorValidator = currentUser?.role === 'Senior Validator';
  const isValidator = currentUser?.role === 'Validator';

  // Justification and Additional Controls are Validator-only
  const canEditFields = isValidator && (isInReview || isRejected);
  // Attachments and other actions still available to Senior Validators on pending_approval
  const canEdit = canEditFields || (isSeniorValidator && isPendingApproval);
  // Score can only be changed by Validators — Senior Validators see it read-only
  const canEditScore = isValidator && (isInReview || isRejected);
  const hasReturnedResponses = responses.some(r => r.status === 'returned');

  // Section title based on status
  let sectionTitle = 'Validator Assessment';
  if (isPendingApproval) sectionTitle = 'Awaiting Senior Validator Approval';
  else if (isClosed) sectionTitle = 'Validator Assessment (Closed)';
  else if (isReturned) sectionTitle = 'Validator Assessment (Awaiting Responder)';
  else if (isRejected) sectionTitle = 'Validator Assessment (Rejected — Revise and Re-submit)';

  return (
    <div>
      {/* Header */}
      <div className="topbar" style={{ marginBottom: 16 }}>
        <div className="left">
          <button className="btn" onClick={() => navigate('/validation')} style={{ fontSize: 12, padding: '4px 10px' }}>← Back</button>
          <strong style={{ fontSize: 16 }}>Validation — Item #{validation.item_number}</strong>
          {validation.bu_code && (
            <span style={{
              fontSize: 12, fontWeight: 700, padding: '3px 8px', borderRadius: 4,
              background: 'var(--accent)18', color: 'var(--accent)', border: '1px solid var(--accent)44',
            }}>
              {buName(validation.bu_code)}
            </span>
          )}
          <WorkflowBadge status={validation.status} />
        </div>
        {cycle && <span className="small">{cycle.name} · {cycle.year}</span>}
      </div>

      {/* Notice banners */}
      {isValidator && isPendingApproval && (
        <div style={{
          padding: '10px 16px', marginBottom: 16,
          background: 'rgba(124,58,237,0.08)',
          border: '1px solid #7c3aed',
          borderRadius: 6, fontSize: 13, color: '#7c3aed',
          fontWeight: 500,
        }}>
          Submitted for approval — awaiting Senior Validator review.
        </div>
      )}

      {isReturned && (
        <div style={{
          padding: '10px 16px', marginBottom: 16,
          background: 'rgba(220,53,69,0.08)',
          border: '1px solid #dc3545',
          borderRadius: 6, fontSize: 13, color: '#dc3545',
          fontWeight: 500,
        }}>
          One or more responses have been returned to the Responder — awaiting re-submission before this item can continue.
        </div>
      )}

      {isRejected && validation.senior_rejection_comment && (
        <div style={{
          padding: '10px 16px', marginBottom: 16,
          background: 'rgba(166,28,46,0.08)',
          border: '1px solid #a61c2e',
          borderRadius: 6, fontSize: 13, color: '#a61c2e',
          fontWeight: 500,
        }}>
          <strong>Rejected by Senior Validator:</strong> {validation.senior_rejection_comment}
        </div>
      )}

      {isInReview && validation.senior_rejection_comment && (
        <div style={{
          padding: '10px 16px', marginBottom: 16,
          background: 'rgba(220,38,38,0.08)',
          border: '1px solid var(--danger)',
          borderRadius: 6, fontSize: 13, color: 'var(--danger)',
          fontWeight: 500,
        }}>
          Rejected by Senior Validator: {validation.senior_rejection_comment}
        </div>
      )}

      {/* Question panel */}
      <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 15 }}>Question Details</h3>
        <div style={{ marginBottom: 12 }}>
          <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>Thematic Area</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{validation.thematic_area ?? '—'}</div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>Requirement</div>
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>{validation.requirement ?? '—'}</div>
        </div>
        {(isValidator || isSeniorValidator) && validation.expectations && (
          <div style={{ marginBottom: 0 }}>
            <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>Expectation</div>
            <div style={{
              fontSize: 13, lineHeight: 1.6,
              padding: '10px 12px', borderRadius: 6,
              background: 'var(--accent)0a', border: '1px solid var(--accent)30',
            }}>
              {validation.expectations}
            </div>
          </div>
        )}
      </div>

      {/* BU Responses */}
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15, color: 'var(--text)' }}>BU Responses ({responses.length})</h3>
        {responses.length === 0 && (
          <div className="small" style={{ padding: 12 }}>No responses available yet.</div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {responses.map(r => (
            <div
              key={r.id}
              className="panel"
              style={{ padding: 16 }}
            >
              {/* Card header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: r.material_risk ? 6 : 10, gap: 10 }}>
                <strong style={{ fontSize: 13 }}>{buName(r.bu_code)}</strong>
                {r.compliance_score !== null ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 32, height: 32, borderRadius: '50%',
                      fontWeight: 700, fontSize: 16,
                      background: scoreColor(r.compliance_score),
                      color: '#fff',
                    }}
                      title={SCORE_LABELS[r.compliance_score]}
                    >
                      {r.compliance_score}
                    </span>
                    {(isValidator || isSeniorValidator) && (() => {
                      const desc = scoreDesc(validation, r.compliance_score);
                      return desc ? (
                        <span style={{ fontSize: 11, color: scoreColor(r.compliance_score), fontWeight: 600, maxWidth: 120, lineHeight: 1.3, textAlign: 'right' }}>
                          {desc}
                        </span>
                      ) : null;
                    })()}
                  </div>
                ) : (
                  <span className="small">No score</span>
                )}
              </div>

              {/* Material risk badge */}
              {r.material_risk && (
                <div style={{ marginBottom: 8 }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                    background: 'rgba(0,123,133,0.12)', color: 'var(--accent)',
                    border: '1px solid var(--accent)',
                  }}>
                    {r.material_risk}
                  </span>
                </div>
              )}

              {/* Status */}
              <div style={{ marginBottom: 8 }}>
                <WorkflowBadge status={r.status} size="sm" />
              </div>

              {/* Return comment */}
              {r.return_comment && (
                <div style={{
                  marginBottom: 8, padding: '6px 8px',
                  background: 'rgba(220,53,69,0.07)', border: '1px solid #dc3545',
                  borderRadius: 4, fontSize: 12, color: '#dc3545',
                }}>
                  <strong>Return note:</strong> {r.return_comment}
                </div>
              )}

              {/* Comments */}
              {r.comments ? (
                <div style={{
                  fontSize: 13, lineHeight: 1.5, color: 'var(--text)',
                  maxHeight: 120, overflowY: 'auto',
                  padding: '6px 8px', background: 'var(--panel2)',
                  border: '1px solid var(--line)', borderRadius: 4,
                  marginBottom: 8,
                }}>
                  {r.comments}
                </div>
              ) : (
                <div className="small" style={{ marginBottom: 8, fontStyle: 'italic' }}>No comments.</div>
              )}

              {/* Attachments */}
              {(attachments[r.id] ?? []).length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>Evidence Files</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {(attachments[r.id] ?? []).map(a => (
                      <div key={a.id} style={{
                        display: 'flex', alignItems: 'flex-start', gap: 6,
                        padding: '6px 8px', borderRadius: 4,
                        background: 'var(--panel2)', border: '1px solid var(--line)',
                      }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                        </svg>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <a
                            href={`/api/cycles/${r.cycle_id}/responses/${r.id}/attachments/${a.id}/download`}
                            target="_blank" rel="noreferrer"
                            style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}
                          >
                            {displayFileName(a.file_name)}
                          </a>
                          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                            {a.uploaded_by && <span>{a.uploaded_by}</span>}
                            {a.uploaded_by && a.uploaded_at && <span> · </span>}
                            {a.uploaded_at && <span>{new Date(a.uploaded_at).toLocaleString()}</span>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Timestamp */}
              {r.submitted_at && (
                <div className="small">
                  Submitted {new Date(r.submitted_at).toLocaleDateString()}
                </div>
              )}

              {/* Return to Respondent button — Validator only, submitted responses, validation in_review */}
              {isValidator && (isInReview || isRejected) && r.status === 'submitted' && (
                <button
                  className="btn danger"
                  style={{ marginTop: 10, fontSize: 12, padding: '4px 10px', width: '100%' }}
                  onClick={() => { setReturningResponseId(r.id); setReturnComment(''); }}
                >
                  Return to Respondent
                </button>
              )}

              {/* More Details — Senior Validator only */}
              {isSeniorValidator && (
                <button
                  className="btn"
                  style={{ marginTop: 10, fontSize: 12, padding: '4px 10px', width: '100%' }}
                  onClick={() => setDetailResponse(r)}
                >
                  More Details
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Validator Assessment */}
      <div className="panel" style={{ padding: 20 }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 15 }}>
          {sectionTitle}
        </h3>

        {/* Validation score picker / display */}
        <div style={{ marginBottom: 20 }}>
          <div className="small" style={{ fontWeight: 600, marginBottom: 10 }}>Validation Score</div>
          {!canEditScore ? (
            validation.validation_score !== null ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 44, height: 44, borderRadius: '50%',
                  fontWeight: 700, fontSize: 22,
                  background: scoreColor(validation.validation_score),
                  color: '#fff',
                }}>
                  {validation.validation_score}
                </span>
                <div>
                  <div style={{ fontSize: 14, color: scoreColor(validation.validation_score), fontWeight: 600 }}>
                    {SCORE_LABELS[validation.validation_score]}
                  </div>
                  {isSeniorValidator && (() => {
                    const desc = scoreDesc(validation, validation.validation_score);
                    return desc ? (
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, lineHeight: 1.4 }}>{desc}</div>
                    ) : null;
                  })()}
                </div>
              </div>
            ) : <span className="small">Not scored</span>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, maxWidth: 400 }}>
              {([1, 2, 3, 4] as const).map(s => {
                const selected = valScore === s;
                const col = scoreColor(s);
                return (
                  <button
                    key={s}
                    onClick={() => setValScore(s)}
                    style={{
                      padding: '14px 8px',
                      borderRadius: 6,
                      border: selected ? `2px solid ${col}` : '2px solid var(--line)',
                      background: selected ? `${col}18` : 'var(--panel2)',
                      color: selected ? col : 'var(--muted)',
                      fontWeight: 700,
                      fontSize: 22,
                      cursor: 'pointer',
                      transition: 'all .15s',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 4,
                    }}
                    title={SCORE_LABELS[s]}
                  >
                    <span>{s}</span>
                    <span style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', opacity: 0.8 }}>
                      {SCORE_LABELS[s]}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Justification */}
        <div style={{ marginBottom: 16 }}>
          <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Justification</div>
          {!canEditFields ? (
            <div style={{
              padding: '10px 12px', background: 'var(--panel2)',
              border: '1px solid var(--line)', borderRadius: 6,
              fontSize: 13, lineHeight: 1.6, minHeight: 60,
              color: justification ? 'var(--text)' : 'var(--muted)',
            }}>
              {justification || 'No justification provided.'}
            </div>
          ) : (
            <>
              <textarea
                value={justification}
                onChange={e => { if (e.target.value.length <= 1500) setJustification(e.target.value); }}
                placeholder="Explain the rationale for your validation score…"
                rows={4}
                style={{
                  width: '100%', padding: '10px 12px',
                  border: '1px solid ' + (justification.length >= 1500 ? 'var(--danger)' : 'var(--line)'), borderRadius: 6,
                  background: 'var(--input-bg)', color: 'var(--text)',
                  fontSize: 13, lineHeight: 1.6, resize: 'vertical',
                  fontFamily: 'inherit',
                }}
              />
              {justification.length >= 1500 && (
                <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 4 }}>Maximum row limit has been reached</div>
              )}
            </>
          )}
        </div>

        {/* Additional Controls */}
        <div style={{ marginBottom: 20 }}>
          <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Additional Controls</div>
          {!canEditFields ? (
            <div style={{
              padding: '10px 12px', background: 'var(--panel2)',
              border: '1px solid var(--line)', borderRadius: 6,
              fontSize: 13, lineHeight: 1.6, minHeight: 40,
              color: additionalControls ? 'var(--text)' : 'var(--muted)',
            }}>
              {additionalControls || 'None specified.'}
            </div>
          ) : (
            <>
              <textarea
                value={additionalControls}
                onChange={e => { if (e.target.value.length <= 1500) setAdditionalControls(e.target.value); }}
                placeholder="Note any additional controls or action items required…"
                rows={3}
                style={{
                  width: '100%', padding: '10px 12px',
                  border: '1px solid ' + (additionalControls.length >= 1500 ? 'var(--danger)' : 'var(--line)'), borderRadius: 6,
                  background: 'var(--input-bg)', color: 'var(--text)',
                  fontSize: 13, lineHeight: 1.6, resize: 'vertical',
                  fontFamily: 'inherit',
                }}
              />
              {additionalControls.length >= 1500 && (
                <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 4 }}>Maximum row limit has been reached</div>
              )}
            </>
          )}
        </div>

        {/* Validator Attachments */}
        <div style={{ marginBottom: 20 }}>
          <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Supporting Evidence</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {valAttachments.map(a => (
              <div key={a.id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 10px', borderRadius: 6,
                background: 'var(--panel2)', border: '1px solid var(--line)',
              }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                </svg>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <a
                    href={`/api/cycles/${cycle?.id}/validations/${validation.id}/attachments/${a.id}/download`}
                    target="_blank" rel="noreferrer"
                    style={{ fontSize: 13, color: 'var(--accent)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}
                  >
                    {displayFileName(a.file_name)}
                  </a>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                    {a.uploaded_by && <span>{a.uploaded_by}</span>}
                    {a.uploaded_by && a.uploaded_at && <span> · </span>}
                    {a.uploaded_at && <span>{new Date(a.uploaded_at).toLocaleString()}</span>}
                  </div>
                </div>
                {canEdit && (
                  <button
                    onClick={() => handleValAttachDelete(a.id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', padding: '0 2px', fontSize: 14, lineHeight: 1, flexShrink: 0 }}
                    title="Remove"
                  >×</button>
                )}
              </div>
            ))}
            {canEdit && (
              <>
                <input
                  type="file"
                  ref={valFileRef}
                  style={{ display: 'none' }}
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (file) handleValAttachUpload(file);
                    e.target.value = '';
                  }}
                />
                <button
                  onClick={() => valFileRef.current?.click()}
                  disabled={uploadingValAttach}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '6px 10px', fontSize: 13,
                    border: '1px dashed var(--line)', borderRadius: 6,
                    background: 'transparent', color: uploadingValAttach ? 'var(--muted)' : 'var(--accent)',
                    cursor: uploadingValAttach ? 'default' : 'pointer', width: '100%', textAlign: 'left',
                  }}
                >
                  {uploadingValAttach
                    ? <><span style={{ fontSize: 13 }}>⏳</span> Uploading…</>
                    : <><span style={{ fontSize: 16, lineHeight: 1 }}>+</span> Attach another file…</>}
                </button>
                {uploadValWarning && (
                  <div style={{
                    marginTop: 6, padding: '6px 10px', fontSize: 12,
                    borderRadius: 6, border: '1px solid #f59e0b',
                    background: '#fffbeb', color: '#92400e',
                    display: 'flex', alignItems: 'flex-start', gap: 6,
                  }}>
                    <span style={{ flexShrink: 0 }}>⚠️</span>
                    <span>{uploadValWarning}</span>
                  </div>
                )}
              </>
            )}
            {!canEdit && valAttachments.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--muted)', fontStyle: 'italic' }}>No supporting files attached.</div>
            )}
          </div>
        </div>

        {isClosed && validation.validated_at && (
          <div className="small" style={{ marginBottom: 12 }}>
            Validated on {new Date(validation.validated_at).toLocaleString()}
            {validation.validated_by && ` by ${validation.validated_by}`}
          </div>
        )}

        {/* Senior Validator approval section */}
        {isSeniorValidator && isPendingApproval && (
          <div style={{
            marginTop: 20, paddingTop: 20,
            borderTop: '1px solid var(--line)',
          }}>
            <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Rejection Comment</div>
            <textarea
              value={rejectionComment}
              onChange={e => { if (e.target.value.length <= 1500) setRejectionComment(e.target.value); }}
              placeholder="Provide a reason for rejection (required when rejecting)…"
              rows={3}
              style={{
                width: '100%', padding: '10px 12px',
                border: '1px solid ' + (rejectionComment.length >= 1500 ? 'var(--danger)' : 'var(--line)'), borderRadius: 6,
                background: 'var(--input-bg)', color: 'var(--text)',
                fontSize: 13, lineHeight: 1.6, resize: 'vertical',
                fontFamily: 'inherit',
                marginBottom: rejectionComment.length >= 1500 ? 4 : 12,
              }}
            />
            {rejectionComment.length >= 1500 && (
              <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 12 }}>Maximum row limit has been reached</div>
            )}
          </div>
        )}

        {saveError && (
          <div style={{ color: 'var(--danger)', marginBottom: 12, fontSize: 13 }}>{saveError}</div>
        )}
        {saveSuccess && (
          <div style={{ color: 'var(--ok)', marginBottom: 12, fontSize: 13 }}>Saved successfully.</div>
        )}

        {/* Validator actions (in_review or rejected) */}
        {isValidator && (isInReview || isRejected) && (
          <div className="actions">
            <button
              className="btn primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              className="btn danger"
              onClick={handleSubmitForApproval}
              disabled={submitting || valScore === null || hasReturnedResponses}
              title={valScore === null ? 'Set a score first' : hasReturnedResponses ? 'One or more responses have been returned to the Responder' : ''}
            >
              {submitting ? 'Submitting…' : 'Submit for Approval'}
            </button>
          </div>
        )}

        {/* Senior Validator actions (pending_approval only) */}
        {isSeniorValidator && isPendingApproval && (
          <div className="actions">
            <button
              className="btn primary"
              onClick={handleApprove}
              disabled={approving || rejecting}
            >
              {approving ? 'Approving…' : 'Approve'}
            </button>
            <button
              className="btn danger"
              onClick={handleReject}
              disabled={approving || rejecting}
            >
              {rejecting ? 'Rejecting…' : 'Reject'}
            </button>
          </div>
        )}
      </div>

      {/* More Details modal — Senior Validator */}
      {detailResponse !== null && (() => {
        const r = detailResponse;
        const rAttachments = attachments[r.id] ?? [];
        return (
          <div className="modal-backdrop" onClick={() => setDetailResponse(null)}>
            <div
              className="modal"
              style={{ padding: 0, minWidth: 520, maxWidth: 680, width: '90vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
              onClick={e => e.stopPropagation()}
            >
              {/* Modal header */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '16px 20px', borderBottom: '1px solid var(--line)',
                flexShrink: 0,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <strong style={{ fontSize: 15 }}>{buName(r.bu_code)}</strong>
                  {r.material_risk && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                      background: 'rgba(0,123,133,0.12)', color: 'var(--accent)',
                      border: '1px solid var(--accent)',
                    }}>
                      {r.material_risk}
                    </span>
                  )}
                  <WorkflowBadge status={r.status} size="sm" />
                </div>
                <button
                  onClick={() => setDetailResponse(null)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--muted)', lineHeight: 1, padding: '0 4px' }}
                  title="Close"
                >×</button>
              </div>

              {/* Modal body — scrollable */}
              <div style={{ overflowY: 'auto', padding: '20px', flex: 1 }}>

                {/* Score */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
                  {r.compliance_score !== null ? (
                    <>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 48, height: 48, borderRadius: '50%',
                        fontWeight: 700, fontSize: 24,
                        background: scoreColor(r.compliance_score), color: '#fff',
                        flexShrink: 0,
                      }}>
                        {r.compliance_score}
                      </span>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: scoreColor(r.compliance_score) }}>
                          {SCORE_LABELS[r.compliance_score]}
                        </div>
                        <div className="small" style={{ color: 'var(--muted)' }}>Self-assessment score</div>
                      </div>
                    </>
                  ) : (
                    <span className="small" style={{ color: 'var(--muted)' }}>No score provided</span>
                  )}
                </div>

                {/* Return comment */}
                {r.return_comment && (
                  <div style={{
                    marginBottom: 16, padding: '10px 12px',
                    background: 'rgba(220,53,69,0.07)', border: '1px solid #dc3545',
                    borderRadius: 6, fontSize: 13, color: '#dc3545',
                  }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Return note</div>
                    {r.return_comment}
                  </div>
                )}

                {/* Comments */}
                <div style={{ marginBottom: 16 }}>
                  <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Assessment Comments</div>
                  {r.comments ? (
                    <div style={{
                      padding: '10px 12px', background: 'var(--panel2)',
                      border: '1px solid var(--line)', borderRadius: 6,
                      fontSize: 13, lineHeight: 1.7, color: 'var(--text)',
                      whiteSpace: 'pre-wrap',
                    }}>
                      {r.comments}
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: 'var(--muted)', fontStyle: 'italic' }}>No comments provided.</div>
                  )}
                </div>

                {/* Attachments */}
                <div style={{ marginBottom: 16 }}>
                  <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>
                    Evidence Files {rAttachments.length > 0 ? `(${rAttachments.length})` : ''}
                  </div>
                  {rAttachments.length === 0 ? (
                    <div style={{ fontSize: 13, color: 'var(--muted)', fontStyle: 'italic' }}>No files attached.</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {rAttachments.map(a => (
                        <div key={a.id} style={{
                          display: 'flex', alignItems: 'flex-start', gap: 8,
                          padding: '8px 10px', borderRadius: 6,
                          background: 'var(--panel2)', border: '1px solid var(--line)',
                        }}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                          </svg>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <a
                              href={`/api/cycles/${r.cycle_id}/responses/${r.id}/attachments/${a.id}/download`}
                              target="_blank" rel="noreferrer"
                              style={{ fontSize: 13, color: 'var(--accent)', textDecoration: 'none', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            >
                              {displayFileName(a.file_name)}
                            </a>
                            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                              {[a.uploaded_by, a.uploaded_at ? new Date(a.uploaded_at).toLocaleString() : null].filter(Boolean).join(' · ')}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Timestamps */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                  {r.submitted_at && (
                    <div>
                      <div className="small" style={{ fontWeight: 600, marginBottom: 2 }}>Submitted</div>
                      <div style={{ fontSize: 13 }}>{new Date(r.submitted_at).toLocaleString()}</div>
                    </div>
                  )}
                  {r.returned_at && (
                    <div>
                      <div className="small" style={{ fontWeight: 600, marginBottom: 2 }}>Returned at</div>
                      <div style={{ fontSize: 13 }}>{new Date(r.returned_at).toLocaleString()}</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Modal footer */}
              <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', flexShrink: 0, display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn" onClick={() => setDetailResponse(null)}>Close</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Return to Respondent modal */}
      {returningResponseId !== null && (
        <div className="modal-backdrop" onClick={() => setReturningResponseId(null)}>
          <div className="modal" style={{ padding: 24, minWidth: 400 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 12px' }}>Return to Respondent</h2>
            <p className="small" style={{ marginBottom: 12, color: 'var(--muted)' }}>
              The response will be returned to the Respondent for revision. They will need to re-submit before this item can be validated.
            </p>
            <div className="field">
              <label>Comment (optional)</label>
              <textarea
                value={returnComment}
                onChange={e => { if (e.target.value.length <= 1500) setReturnComment(e.target.value); }}
                rows={3}
                style={{
                  width: '100%', resize: 'vertical',
                  border: '1px solid ' + (returnComment.length >= 1500 ? 'var(--danger)' : 'var(--line)'),
                }}
                placeholder="Explain what needs to be revised…"
                autoFocus
              />
              {returnComment.length >= 1500 && (
                <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 4 }}>Maximum row limit has been reached</div>
              )}
            </div>
            {saveError && (
              <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 8 }}>{saveError}</div>
            )}
            <div className="actions" style={{ marginTop: 12 }}>
              <button className="btn danger" onClick={handleReturn} disabled={returning}>
                {returning ? 'Returning…' : 'Confirm Return'}
              </button>
              <button className="btn" onClick={() => setReturningResponseId(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
