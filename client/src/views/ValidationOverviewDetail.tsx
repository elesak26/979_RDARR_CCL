import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Cycle } from '../types';
import { scoreColor, SCORE_LABELS } from '../utils/scores';
import WorkflowBadge from '../components/common/WorkflowBadge';

interface OverviewRow {
  validation_id: number;
  question_id: number;
  bu_code: string;
  material_risk: string | null;
  status: string;
  validation_score: number | null;
  item_number: number;
  thematic_area: string;
  requirement: string;
  bcbs_principle_name: string | null;
  self_score: number | null;
  weight: number;
  bu_name: string | null;
  consolidated_score: number | null;
}

function ScoreBadge({ score, size = 'normal' }: { score: number | null; size?: 'normal' | 'large' }) {
  if (score === null) return <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>;
  const rounded = Math.round(score);
  const color = scoreColor(rounded);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: `${color}18`, border: `1px solid ${color}55`,
      borderRadius: 6, padding: size === 'large' ? '5px 12px' : '2px 8px',
      fontSize: size === 'large' ? 15 : 12,
      fontWeight: 700, color,
    }}>
      {score.toFixed(2)} — {SCORE_LABELS[rounded] ?? ''}
    </span>
  );
}

function parseRow(r: OverviewRow): OverviewRow {
  return {
    ...r,
    self_score: r.self_score != null ? parseFloat(String(r.self_score)) : null,
    weight: parseFloat(String(r.weight)),
    consolidated_score: r.consolidated_score != null ? parseFloat(String(r.consolidated_score)) : null,
  };
}

export default function ValidationOverviewDetail() {
  const { cycleId, questionId } = useParams<{ cycleId: string; questionId: string }>();
  const navigate = useNavigate();

  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!cycleId || !questionId) return;
    setLoading(true);
    setError(null);
    try {
      const [data, cycleData] = await Promise.all([
        api.get<OverviewRow[]>(`/cycles/${cycleId}/validation-overview`),
        api.get<Cycle>(`/cycles/${cycleId}`),
      ]);
      const filtered = data.filter(r => String(r.question_id) === questionId).map(parseRow);
      if (filtered.length === 0) {
        setError('This item was not found in the selected cycle. It may have been rejected and returned to the Validator.');
      }
      setRows(filtered);
      setCycle(cycleData);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [cycleId, questionId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="small" style={{ padding: 24 }}>Loading…</div>;
  if (error) return (
    <div style={{ padding: 24 }}>
      <div style={{ color: 'var(--danger)', marginBottom: 12 }}>{error}</div>
      <button className="btn" onClick={() => navigate(`/validation-overview?cycle=${cycleId}`)}>← Back</button>
    </div>
  );

  const item = rows[0];
  if (!item) return null;

  const consolidatedScore = item.consolidated_score;
  const isFullyApproved = rows.length > 0 && rows.every(r => r.status === 'closed');

  const totalWeight = rows.reduce((s, r) => s + r.weight, 0);
  const consolidatedSelfScore = rows.some(r => r.self_score !== null) && totalWeight > 0
    ? rows.reduce((s, r) => s + (r.self_score ?? 0) * r.weight, 0) / totalWeight
    : null;

  return (
    <div style={{ maxWidth: 920, margin: '0 auto' }}>
      {/* Breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 13, color: 'var(--muted)' }}>
        <button
          className="btn"
          style={{ fontSize: 12, padding: '3px 10px' }}
          onClick={() => navigate(`/validation-overview?cycle=${cycleId}`)}
        >
          ← Validation Overview
        </button>
        {cycle && <span>{cycle.name} ({cycle.year})</span>}
      </div>

      {/* Item header */}
      <div className="panel" style={{ marginBottom: 16, padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{
                fontSize: 13, fontWeight: 700,
                background: 'var(--accent)18', color: 'var(--accent)',
                padding: '3px 10px', borderRadius: 5,
              }}>
                Item #{item.item_number}
              </span>
              <span className="small" style={{ color: 'var(--muted)' }}>{item.thematic_area}</span>
              {item.bcbs_principle_name && (
                <span className="small" style={{ color: 'var(--muted)' }}>· BCBS: {item.bcbs_principle_name}</span>
              )}
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--text)' }}>{item.requirement}</div>
          </div>
        </div>
      </div>

      {/* Per-BU table */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Respondent Assessment & Validation Scores</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Respondent</th>
              <th style={{ width: 150, textAlign: 'center' }}>Self Assessment</th>
              <th style={{ width: 170, textAlign: 'center' }}>Validation Score</th>
              <th style={{ width: 80, textAlign: 'center' }}>Weight</th>
              <th style={{ width: 130, textAlign: 'center' }}>Status</th>
              <th style={{ width: 90, textAlign: 'center' }}>Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={`${row.bu_code}-${row.material_risk ?? ''}`}>
                <td>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{
                      fontSize: 12, fontWeight: 700,
                      padding: '3px 8px', borderRadius: 4,
                      background: 'var(--accent)18', color: 'var(--accent)',
                      border: '1px solid var(--accent)44',
                      alignSelf: 'flex-start',
                    }}>
                      {row.bu_name ?? row.bu_code}
                    </span>
                    {row.material_risk && (
                      <span style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
                        {row.material_risk}
                      </span>
                    )}
                  </div>
                </td>
                <td style={{ textAlign: 'center' }}>
                  {row.self_score !== null ? (
                    <span style={{ color: scoreColor(Math.round(row.self_score)), fontWeight: 700 }}>
                      {row.self_score.toFixed(2)}
                    </span>
                  ) : <span style={{ color: 'var(--muted)' }}>—</span>}
                </td>
                <td style={{ textAlign: 'center' }}>
                  {row.validation_score !== null ? (
                    <span style={{ color: scoreColor(row.validation_score), fontWeight: 700 }}>
                      {row.validation_score} — {SCORE_LABELS[row.validation_score]}
                    </span>
                  ) : <span style={{ color: 'var(--muted)' }}>—</span>}
                </td>
                <td style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                  {(row.weight * 100).toFixed(1)}%
                </td>
                <td style={{ textAlign: 'center' }}>
                  <WorkflowBadge status={row.status} size="sm" />
                </td>
                <td style={{ textAlign: 'center' }}>
                  <button
                    className="btn"
                    style={{ fontSize: 12, padding: '3px 10px' }}
                    onClick={() => navigate(`/validation/${row.validation_id}`, { state: { cycleId: Number(cycleId) } })}
                  >
                    Details
                  </button>
                </td>
              </tr>
            ))}

            {/* Consolidated score row */}
            <tr style={{ borderTop: '2px solid var(--line)', background: 'var(--accent)06' }}>
              <td style={{ fontWeight: 700, fontSize: 13 }}>
                Consolidated Score (weighted average)
              </td>
              <td style={{ textAlign: 'center' }}>
                <ScoreBadge score={consolidatedSelfScore} size="large" />
              </td>
              <td style={{ textAlign: 'center' }}>
                <ScoreBadge score={consolidatedScore} size="large" />
              </td>
              <td style={{ textAlign: 'center', fontWeight: 700, fontSize: 13 }}>
                100%
              </td>
              <td />
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      {isFullyApproved && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end',
          padding: '10px 16px', background: '#2f9e4412', border: '1px solid #2f9e4455',
          borderRadius: 8, fontSize: 13, fontWeight: 600, color: '#2f9e44',
        }}>
          ✓ The scores for this item have been approved by Senior Validator.
        </div>
      )}
    </div>
  );
}
