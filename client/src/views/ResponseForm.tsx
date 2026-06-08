import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { User, Response, Question, Cycle } from '../types';
import WorkflowBadge from '../components/common/WorkflowBadge';

interface Props {
  currentUser: User;
}

type ScoreKey = 'score_1_desc' | 'score_2_desc' | 'score_3_desc' | 'score_4_desc';

const SCORE_LABELS: Record<number, string> = {
  1: 'Non-compliant',
  2: 'Partially compliant',
  3: 'Largely compliant',
  4: 'Fully compliant',
};

function getScoreDesc(question: Question, score: number): string | null {
  const key = `score_${score}_desc` as ScoreKey;
  return question[key] ?? null;
}

function scoreColor(score: number): string {
  if (score === 1) return '#ff0000';
  if (score === 2) return '#ffc000';
  if (score === 3) return '#81b848';
  return '#538135';
}

export default function ResponseForm({ currentUser }: Props) {
  const { responseId } = useParams<{ responseId: string }>();
  const navigate = useNavigate();

  const [response, setResponse] = useState<Response | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [score, setScore] = useState<number | null>(null);
  const [comments, setComments] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const load = useCallback(async () => {
    if (!responseId) return;
    setLoading(true);
    setError(null);
    try {
      // We need to find the response. First get all distributed cycles, then search.
      const cycles = await api.get<Cycle[]>('/cycles');
      const distributedCycles = cycles.filter(c => c.status === 'distributed' || c.status === 'closed');

      let foundResponse: Response | null = null;
      let foundCycle: Cycle | null = null;

      for (const c of distributedCycles) {
        try {
          const buCode = currentUser.primary_unit_code;
          const path = buCode
            ? `/cycles/${c.id}/responses?bu_code=${encodeURIComponent(buCode)}`
            : `/cycles/${c.id}/responses`;
          const resps = await api.get<Response[]>(path);
          const match = resps.find(r => String(r.id) === responseId);
          if (match) {
            foundResponse = match;
            foundCycle = c;
            break;
          }
        } catch {
          // skip cycle
        }
      }

      if (!foundResponse || !foundCycle) {
        setError('Response not found or not accessible.');
        return;
      }

      setResponse(foundResponse);
      setCycle(foundCycle);
      setScore(foundResponse.compliance_score);
      setComments(foundResponse.comments ?? '');

      // Load question
      const q = await api.get<Question>(`/questions/${foundResponse.question_id}`);
      setQuestion(q);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [responseId, currentUser.primary_unit_code]);

  useEffect(() => { load(); }, [load]);

  async function handleSaveDraft() {
    if (!response || !cycle) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      await api.put(`/cycles/${cycle.id}/responses/${response.id}`, {
        compliance_score: score,
        comments,
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit() {
    if (!response || !cycle || score === null) return;
    // Save first then submit
    setSubmitting(true);
    setSaveError(null);
    try {
      await api.put(`/cycles/${cycle.id}/responses/${response.id}`, { compliance_score: score, comments });
      await api.put(`/cycles/${cycle.id}/responses/${response.id}/submit`);
      await load();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Submit failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="small" style={{ padding: 24 }}>Loading response…</div>;
  if (error) return (
    <div style={{ color: 'var(--danger)', padding: 16 }}>
      Error: {error}
      <button className="btn" onClick={() => navigate('/assignments')} style={{ marginLeft: 12 }}>Back</button>
    </div>
  );
  if (!response || !question || !cycle) return null;

  const isSubmitted = response.status === 'submitted';
  const isEditable = response.status === 'draft' || response.status === 'in_progress';

  return (
    <div>
      {/* Header */}
      <div className="topbar" style={{ marginBottom: 16 }}>
        <div className="left">
          <button className="btn" onClick={() => navigate('/assignments')} style={{ fontSize: 12, padding: '4px 10px' }}>← Back</button>
          <strong style={{ fontSize: 16 }}>Item #{question.item_number} — {question.thematic_area}</strong>
          <WorkflowBadge status={response.status} />
        </div>
      </div>

      {/* Return comment warning */}
      {response.return_comment && (
        <div style={{
          marginBottom: 16, padding: '12px 16px',
          background: 'rgba(255,193,7,0.12)', border: '1px solid var(--warn)',
          borderRadius: 6, color: '#856404',
        }}>
          <strong>Returned for revision:</strong> {response.return_comment}
          {response.returned_at && (
            <span className="small" style={{ marginLeft: 8 }}>
              ({new Date(response.returned_at).toLocaleDateString()})
            </span>
          )}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
        {/* Left — read-only question info */}
        <div className="panel" style={{ padding: 20 }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15, color: 'var(--text)' }}>Question Details</h3>

          <div style={{ marginBottom: 14 }}>
            <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>Requirement</div>
            <div style={{ fontSize: 14, lineHeight: 1.6 }}>{question.requirement}</div>
          </div>

          {question.bcbs_principle_number && (
            <div style={{ marginBottom: 14 }}>
              <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>BCBS Principle</div>
              <div style={{ fontSize: 13 }}>
                #{question.bcbs_principle_number}{question.bcbs_principle_name ? ` — ${question.bcbs_principle_name}` : ''}
              </div>
            </div>
          )}

          {question.ecb_reference && (
            <div style={{ marginBottom: 14 }}>
              <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>ECB RDARR Reference</div>
              <div style={{ fontSize: 13 }}>{question.ecb_reference}</div>
            </div>
          )}

          {question.expectations && (
            <div style={{ marginBottom: 14 }}>
              <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>Expectations</div>
              <div style={{
                fontSize: 13, lineHeight: 1.6, maxHeight: 200, overflowY: 'auto',
                padding: '8px 10px', background: 'var(--panel2)',
                border: '1px solid var(--line)', borderRadius: 4,
              }}>
                {question.expectations}
              </div>
            </div>
          )}

          {question.respondents_hint && (
            <div style={{ marginBottom: 14 }}>
              <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>Respondents Hint</div>
              <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--muted)' }}>{question.respondents_hint}</div>
            </div>
          )}

          {question.supportive_material && (
            <div style={{ marginBottom: 14 }}>
              <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>Supportive Material</div>
              <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--muted)' }}>{question.supportive_material}</div>
            </div>
          )}
        </div>

        {/* Right — score + comments */}
        <div className="panel" style={{ padding: 20 }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15 }}>
            {isSubmitted ? 'Your Response (Submitted)' : 'Your Response'}
          </h3>


          {/* Score picker */}
          <div style={{ marginBottom: 20 }}>
            <div className="small" style={{ fontWeight: 600, marginBottom: 10 }}>Compliance Score</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              {([1, 2, 3, 4] as const).map(s => {
                const selected = score === s;
                const col = scoreColor(s);
                return (
                  <button
                    key={s}
                    onClick={() => isEditable && setScore(s)}
                    disabled={!isEditable}
                    style={{
                      padding: '14px 8px',
                      borderRadius: 6,
                      border: selected ? `2px solid ${col}` : '2px solid var(--line)',
                      background: selected ? `${col}18` : 'var(--panel2)',
                      color: selected ? col : 'var(--muted)',
                      fontWeight: 700,
                      fontSize: 22,
                      cursor: isEditable ? 'pointer' : 'default',
                      transition: 'all .15s',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 4,
                    }}
                    title={`${SCORE_LABELS[s]}${getScoreDesc(question, s) ? ': ' + getScoreDesc(question, s) : ''}`}
                  >
                    <span>{s}</span>
                    <span style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', opacity: 0.8 }}>
                      {SCORE_LABELS[s]}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Score description */}
            {score !== null && (
              <div style={{
                marginTop: 10, padding: '8px 12px',
                background: `${scoreColor(score)}10`,
                border: `1px solid ${scoreColor(score)}`,
                borderRadius: 6, fontSize: 13, lineHeight: 1.6,
                color: 'var(--text)',
              }}>
                <strong style={{ color: scoreColor(score) }}>Score {score}:</strong>{' '}
                {getScoreDesc(question, score) ?? SCORE_LABELS[score]}
              </div>
            )}
          </div>

          {/* Comments */}
          <div style={{ marginBottom: 20 }}>
            <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Comments</div>
            {!isEditable ? (
              <div style={{
                padding: '10px 12px', background: 'var(--panel2)',
                border: '1px solid var(--line)', borderRadius: 6,
                fontSize: 13, lineHeight: 1.6, minHeight: 80,
                color: comments ? 'var(--text)' : 'var(--muted)',
              }}>
                {comments || 'No comments provided.'}
              </div>
            ) : (
              <textarea
                value={comments}
                onChange={e => setComments(e.target.value)}
                placeholder="Describe your compliance level, evidence, and any relevant notes…"
                rows={5}
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

          {/* Submission info */}
          {isSubmitted && response.submitted_at && (
            <div style={{ marginBottom: 16, fontSize: 12, color: 'var(--muted)' }}>
              Submitted on {new Date(response.submitted_at).toLocaleString()}
              {response.responder_name && ` by ${response.responder_name}`}
            </div>
          )}

          {/* Error */}
          {saveError && (
            <div style={{ color: 'var(--danger)', marginBottom: 12, fontSize: 13 }}>{saveError}</div>
          )}
          {saveSuccess && (
            <div style={{ color: 'var(--ok)', marginBottom: 12, fontSize: 13 }}>Saved successfully.</div>
          )}

          {/* Actions */}
          {isEditable && (
            <div className="actions">
              <button
                className="btn primary"
                onClick={handleSubmit}
                disabled={submitting || score === null}
                title={score === null ? 'Select a score first' : ''}
              >
                {submitting ? 'Submitting…' : 'Submit Response'}
              </button>
              <button
                className="btn"
                onClick={handleSaveDraft}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save Draft'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
