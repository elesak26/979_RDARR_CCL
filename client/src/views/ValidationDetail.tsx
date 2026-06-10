import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { api, getCurrentUserId } from '../api/client';
import type { Validation, Response, Cycle, User, Attachment } from '../types';
import WorkflowBadge from '../components/common/WorkflowBadge';

const SCORE_LABELS: Record<number, string> = {
  1: 'Non-compliant',
  2: 'Partially compliant',
  3: 'Largely compliant',
  4: 'Fully compliant',
};

function scoreColor(score: number): string {
  if (score === 1) return '#ff0000';
  if (score === 2) return '#ffc000';
  if (score === 3) return '#81b848';
  return '#538135';
}

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
  const valFileRef = useRef<HTMLInputElement | null>(null);

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

  async function handleSubmitForApproval() {
    if (!validation || !cycle) return;
    setSubmitting(true);
    setSaveError(null);
    try {
      // Save first
      await api.put(`/cycles/${cycle.id}/validations/${validation.id}`, {
        validation_score: valScore,
        justification,
        additional_controls: additionalControls,
      });
      await api.put(`/cycles/${cycle.id}/validations/${validation.id}/close`);
      await load();
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
      await load();
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
      await load();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Reject failed');
    } finally {
      setRejecting(false);
    }
  }

  async function handleValAttachUpload(file: File) {
    if (!validation || !cycle) return;
    setUploadingValAttach(true);
    setSaveError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const headers: Record<string, string> = {};
      const userId = getCurrentUserId();
      if (userId) headers['X-User-Id'] = userId;
      const res = await fetch(`/api/cycles/${cycle.id}/validations/${validation.id}/attachments`, { method: 'POST', body: formData, headers });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const saved = await res.json();
      setValAttachments(prev => [...prev, saved]);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Upload failed');
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

  // Editing is allowed for Validators when status is in_review or rejected
  const canEdit = isValidator && (isInReview || isRejected);
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
          <div style={{ fontSize: 13 }}>{validation.thematic_area ?? '—'}</div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>Requirement</div>
          <div style={{ fontSize: 14, lineHeight: 1.6 }}>{validation.requirement ?? '—'}</div>
        </div>
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
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: r.material_risk ? 6 : 10 }}>
                <strong style={{ fontSize: 13 }}>{r.bu_code}</strong>
                {r.compliance_score !== null ? (
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
                      <a
                        key={a.id}
                        href={`/api/cycles/${r.cycle_id}/responses/${r.id}/attachments/${a.id}/download`}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '4px 8px', borderRadius: 4,
                          background: 'var(--panel2)', border: '1px solid var(--line)',
                          fontSize: 12, color: 'var(--accent)',
                          textDecoration: 'none', overflow: 'hidden',
                        }}
                      >
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {a.file_name}
                        </span>
                        <span style={{ flexShrink: 0, fontSize: 11, opacity: 0.7 }}>↓</span>
                      </a>
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
          {!canEdit ? (
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
                <span style={{ fontSize: 14, color: scoreColor(validation.validation_score), fontWeight: 600 }}>
                  {SCORE_LABELS[validation.validation_score]}
                </span>
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
          {!canEdit ? (
            <div style={{
              padding: '10px 12px', background: 'var(--panel2)',
              border: '1px solid var(--line)', borderRadius: 6,
              fontSize: 13, lineHeight: 1.6, minHeight: 60,
              color: justification ? 'var(--text)' : 'var(--muted)',
            }}>
              {justification || 'No justification provided.'}
            </div>
          ) : (
            <textarea
              value={justification}
              onChange={e => setJustification(e.target.value)}
              placeholder="Explain the rationale for your validation score…"
              rows={4}
              style={{
                width: '100%', padding: '10px 12px',
                border: '1px solid var(--line)', borderRadius: 6,
                background: 'var(--input-bg)', color: 'var(--text)',
                fontSize: 13, lineHeight: 1.6, resize: 'vertical',
                fontFamily: 'inherit',
              }}
            />
          )}
        </div>

        {/* Additional Controls */}
        <div style={{ marginBottom: 20 }}>
          <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Additional Controls</div>
          {!canEdit ? (
            <div style={{
              padding: '10px 12px', background: 'var(--panel2)',
              border: '1px solid var(--line)', borderRadius: 6,
              fontSize: 13, lineHeight: 1.6, minHeight: 40,
              color: additionalControls ? 'var(--text)' : 'var(--muted)',
            }}>
              {additionalControls || 'None specified.'}
            </div>
          ) : (
            <textarea
              value={additionalControls}
              onChange={e => setAdditionalControls(e.target.value)}
              placeholder="Note any additional controls or action items required…"
              rows={3}
              style={{
                width: '100%', padding: '10px 12px',
                border: '1px solid var(--line)', borderRadius: 6,
                background: 'var(--input-bg)', color: 'var(--text)',
                fontSize: 13, lineHeight: 1.6, resize: 'vertical',
                fontFamily: 'inherit',
              }}
            />
          )}
        </div>

        {/* Validator Attachments */}
        <div style={{ marginBottom: 20 }}>
          <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Supporting Evidence</div>
          {valAttachments.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
              {valAttachments.map(a => (
                <div key={a.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 10px', borderRadius: 6,
                  background: 'var(--panel2)', border: '1px solid var(--line)',
                }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                  </svg>
                  <a
                    href={`/api/cycles/${cycle?.id}/validations/${validation.id}/attachments/${a.id}/download`}
                    target="_blank" rel="noreferrer"
                    style={{ flex: 1, fontSize: 13, color: 'var(--accent)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {a.file_name}
                  </a>
                  {a.uploaded_by && (
                    <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{a.uploaded_by}</span>
                  )}
                  {canEdit && (
                    <button
                      onClick={() => handleValAttachDelete(a.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', padding: '0 2px', fontSize: 14, lineHeight: 1, flexShrink: 0 }}
                      title="Remove"
                    >×</button>
                  )}
                </div>
              ))}
            </div>
          )}
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
                className="btn"
                onClick={() => valFileRef.current?.click()}
                disabled={uploadingValAttach}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                {uploadingValAttach ? 'Uploading…' : 'Attach File'}
              </button>
            </>
          )}
          {!canEdit && valAttachments.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--muted)', fontStyle: 'italic' }}>No supporting files attached.</div>
          )}
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
              onChange={e => setRejectionComment(e.target.value)}
              placeholder="Provide a reason for rejection (required when rejecting)…"
              rows={3}
              style={{
                width: '100%', padding: '10px 12px',
                border: '1px solid var(--line)', borderRadius: 6,
                background: 'var(--input-bg)', color: 'var(--text)',
                fontSize: 13, lineHeight: 1.6, resize: 'vertical',
                fontFamily: 'inherit',
                marginBottom: 12,
              }}
            />
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
                onChange={e => setReturnComment(e.target.value)}
                rows={3}
                style={{ width: '100%', resize: 'vertical' }}
                placeholder="Explain what needs to be revised…"
                autoFocus
              />
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
