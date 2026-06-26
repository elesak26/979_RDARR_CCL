import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, getCurrentUserId } from '../api/client';
import type { User, Cycle, CycleComment, Response, Validation } from '../types';
import WorkflowBadge from '../components/common/WorkflowBadge';
import Reports from './Reports';
import { displayFileName } from '../utils/displayFileName';

interface Props {
  currentUser: User | null;
}

interface KpiCardProps {
  label: React.ReactNode;
  value: React.ReactNode;
  onClick?: () => void;
  style?: React.CSSProperties;
}

function KpiCard({ label, value, onClick, style }: KpiCardProps) {
  const isClickable = !!onClick;
  return (
    <div
      className={`card${isClickable ? ' clickable' : ''}`}
      onClick={onClick}
      style={style}
      title={isClickable ? 'Click to view' : undefined}
    >
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {isClickable && (
        <div className="small" style={{ color: 'var(--muted)', marginTop: 4, fontSize: 11 }}>Click to view</div>
      )}
    </div>
  );
}

export default function Dashboard({ currentUser }: Props) {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [responses, setResponses] = useState<Response[]>([]);
  const [validations, setValidations] = useState<Validation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cycleComments, setCycleComments] = useState<Record<number, CycleComment[]>>({});
  const [selectedCycleId, setSelectedCycleId] = useState<number | null>(null);
  const [viewerCycleId, setViewerCycleId] = useState<number | null>(null);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const allCycles = await api.get<Cycle[]>('/cycles');
      setCycles(allCycles);

      // Load comments for pending_approval cycles (Validator needs to see SV feedback)
      const pendingCycles = allCycles.filter(c => c.status === 'pending_approval');
      if (pendingCycles.length > 0) {
        const commentArrays = await Promise.all(
          pendingCycles.map(c =>
            api.get<CycleComment[]>(`/cycles/${c.id}/comments`).catch((): CycleComment[] => [])
          )
        );
        const commentMap: Record<number, CycleComment[]> = {};
        pendingCycles.forEach((c, i) => { commentMap[c.id] = commentArrays[i]; });
        setCycleComments(commentMap);
      } else {
        setCycleComments({});
      }

      const distributedCycles = allCycles.filter(c => c.status === 'distributed');

      if (distributedCycles.length > 0) {
        const unitCodes = currentUser?.unit_codes?.length ? currentUser.unit_codes : currentUser?.primary_unit_code ? [currentUser.primary_unit_code] : [];
        const [valArrays, respArrays] = await Promise.all([
          Promise.all(
            distributedCycles.map(c =>
              api.get<Validation[]>(`/cycles/${c.id}/validations`).catch((): Validation[] => [])
            )
          ),
          unitCodes.length > 0
            ? Promise.all(
                distributedCycles.flatMap(c =>
                  unitCodes.map(buCode =>
                    api.get<Response[]>(`/cycles/${c.id}/responses?bu_code=${encodeURIComponent(buCode)}`).catch((): Response[] => [])
                  )
                )
              )
            : Promise.resolve<Response[][]>([]),
        ]);
        setValidations(valArrays.flat());
        setResponses(respArrays.flat());
      } else {
        setValidations([]);
        setResponses([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [currentUser?.primary_unit_code, currentUser?.unit_codes]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="small">Loading dashboard…</div>;
  if (error) return (
    <div style={{ color: 'var(--danger)', padding: 16 }}>
      Error: {error} <button className="btn" onClick={load} style={{ marginLeft: 8 }}>Retry</button>
    </div>
  );

  const activeCycles = cycles.filter(c => c.status === 'distributed');
  const hasActiveCycles = activeCycles.length > 0;
  const role = currentUser?.role;

  const filteredValidations = selectedCycleId !== null
    ? validations.filter(v => v.cycle_id === selectedCycleId)
    : validations;

  const pendingCount = hasActiveCycles ? filteredValidations.filter(v => v.status === 'pending').length : 0;
  const inReviewCount = hasActiveCycles ? filteredValidations.filter(v => v.status === 'in_review').length : 0;
  const rejectedCount = hasActiveCycles ? filteredValidations.filter(v => v.status === 'rejected').length : 0;
  const pendingApprovalCount = hasActiveCycles ? filteredValidations.filter(v => v.status === 'pending_approval').length : 0;
  const closedValCount = hasActiveCycles ? filteredValidations.filter(v => v.status === 'closed').length : 0;

  const cycleQS = selectedCycleId !== null ? `&cycle_id=${selectedCycleId}` : '';

  const ActionBadge = () => (
    <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: '#fff', background: 'var(--danger)', padding: '1px 6px', borderRadius: 999 }}>
      ACTION REQUIRED
    </span>
  );

  const CycleSelector = () => {
    if (!hasActiveCycles) return null;

    if (activeCycles.length === 1) {
      return (
        <div style={{ marginBottom: 14, padding: '10px 14px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--radius2)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="small" style={{ fontWeight: 600 }}>Active Cycle:</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="small"><strong>{activeCycles[0].name}</strong> · {activeCycles[0].year}</span>
            <WorkflowBadge status={activeCycles[0].status} size="sm" />
          </span>
        </div>
      );
    }

    return (
      <div style={{ marginBottom: 14, padding: '10px 14px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--radius2)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="small" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>Active Cycle:</span>
        <select
          value={selectedCycleId ?? ''}
          onChange={e => setSelectedCycleId(e.target.value === '' ? null : Number(e.target.value))}
          style={{ fontWeight: 500, minWidth: 220 }}
        >
          <option value="">All ({activeCycles.length})</option>
          {activeCycles.map(c => (
            <option key={c.id} value={c.id}>{c.name} · {c.year}</option>
          ))}
        </select>
      </div>
    );
  };

  // ── Viewer layout — fully separate, returns early ──────────────────────────
  if (role === 'Viewer') {
    const CYCLE_META: Record<string, { label: string; accent: string; bg: string; clickable: boolean; hint?: string }> = {
      distributed:      { label: 'Active',           accent: 'var(--accent)', bg: 'var(--accent-light)',  clickable: true  },
      closed:           { label: 'Completed',         accent: 'var(--ok)',     bg: 'rgba(40,167,69,.08)', clickable: true  },
      published:        { label: 'Approved',          accent: 'var(--accent)', bg: 'var(--panel2)',        clickable: false },
      pending_approval: { label: 'Pending Approval',  accent: '#7c3aed',       bg: 'rgba(124,58,237,.06)', clickable: true  },
      draft:            { label: 'Draft',             accent: 'var(--muted)',  bg: 'var(--panel2)',        clickable: false },
    };

    // Sort chronologically: newest year first, then by id descending within same year
    const activeCyclesOnly = cycles.filter(c => c.status === 'distributed' || c.status === 'closed');
    const sortedCycles = [...activeCyclesOnly].sort((a, b) => b.year - a.year || b.id - a.id);
    const availableYears = [...new Set(sortedCycles.map(c => c.year))].sort((a, b) => b - a);
    const effectiveYear = selectedYear ?? availableYears[0] ?? null;
    const visibleCycles = effectiveYear !== null ? sortedCycles.filter(c => c.year === effectiveYear) : sortedCycles;

    function CycleCard({ c }: { c: Cycle }) {
      const meta = CYCLE_META[c.status] ?? { label: c.status, accent: 'var(--muted)', bg: 'var(--panel2)', clickable: false };
      const isSelected = viewerCycleId === c.id;
      return (
        <div
          onClick={meta.clickable ? () => setViewerCycleId(c.id) : undefined}
          style={{
            background: isSelected ? meta.bg : 'var(--panel)',
            border: `1px solid ${isSelected ? meta.accent : 'var(--line)'}`,
            borderLeft: `4px solid ${meta.accent}`,
            borderRadius: 'var(--radius2)',
            boxShadow: isSelected ? 'var(--shadow-md)' : 'var(--shadow)',
            padding: '14px 16px',
            cursor: meta.clickable ? 'pointer' : 'default',
            transition: 'box-shadow .15s, border-color .15s, background .15s',
            display: 'flex', flexDirection: 'column', gap: 6,
          }}
          onMouseEnter={e => { if (meta.clickable && !isSelected) (e.currentTarget as HTMLDivElement).style.boxShadow = 'var(--shadow-md)'; }}
          onMouseLeave={e => { if (meta.clickable && !isSelected) (e.currentTarget as HTMLDivElement).style.boxShadow = 'var(--shadow)'; }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{c.name}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
              background: `${meta.accent === 'var(--muted)' ? 'var(--chip)' : meta.accent}18`,
              color: meta.accent,
            }}>
              {meta.label}
            </span>
            {meta.clickable && (
              <span style={{ fontSize: 11, color: meta.accent, fontWeight: 600 }}>
                {isSelected ? '▾ Viewing' : 'View report →'}
              </span>
            )}
            {!meta.clickable && (
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{meta.hint ?? 'No report yet'}</span>
            )}
          </div>
        </div>
      );
    }

    return (
      <div>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
          <strong style={{ fontSize: 22 }}>Dashboard</strong>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
            {availableYears.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: 'var(--muted)',
                }}>
                  Validation Year
                </span>
                <div style={{
                  display: 'flex', alignItems: 'center', position: 'relative',
                  background: 'var(--panel)', border: '1px solid var(--line)',
                  borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow-md)',
                  overflow: 'hidden',
                }}>
                  <div style={{
                    background: 'var(--accent-dark)', padding: '10px 14px',
                    display: 'flex', alignItems: 'center', flexShrink: 0,
                  }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                    </svg>
                  </div>
                  <select
                    value={effectiveYear ?? ''}
                    onChange={e => { setSelectedYear(Number(e.target.value)); setViewerCycleId(null); }}
                    style={{
                      border: 'none', outline: 'none', background: 'transparent',
                      fontWeight: 700, fontSize: 15, color: 'var(--text)',
                      padding: '10px 36px 10px 14px', cursor: 'pointer',
                      appearance: 'none', minWidth: 80,
                    }}
                  >
                    {availableYears.map(y => (
                      <option key={y} value={y}>{y}</option>
                    ))}
                  </select>
                  <div style={{ pointerEvents: 'none', position: 'absolute', right: 12, color: 'var(--muted)' }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                  </div>
                </div>
              </div>
            )}
            {/* Reference document — shown only when a cycle with a checklist is selected */}
            {(() => {
              const selectedCycle = viewerCycleId ? sortedCycles.find(c => c.id === viewerCycleId) : null;
              if (!selectedCycle?.checklist_file) return null;
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                    color: 'var(--muted)',
                  }}>
                    Reference Document
                  </span>
                  <button
                    onClick={() => {
                      const userId = getCurrentUserId();
                      const headers: Record<string, string> = {};
                      if (userId) headers['X-User-Id'] = userId;
                      fetch(`/api/cycles/${viewerCycleId}/checklist`, { headers })
                        .then(r => r.blob())
                        .then(blob => {
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = selectedCycle.checklist_original_name ?? displayFileName(selectedCycle.checklist_file);
                          a.click();
                          URL.revokeObjectURL(url);
                        });
                    }}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 0,
                      background: 'var(--panel)', border: '1px solid var(--line)',
                      borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow-md)',
                      overflow: 'hidden', cursor: 'pointer', padding: 0,
                    }}
                  >
                    <div style={{
                      background: '#217346', padding: '10px 14px',
                      display: 'flex', alignItems: 'center', flexShrink: 0,
                    }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                      </svg>
                    </div>
                    <span style={{
                      fontWeight: 700, fontSize: 13, color: 'var(--text)',
                      padding: '10px 14px', whiteSpace: 'nowrap',
                    }}>
                      Compliance Checklist
                    </span>
                    <div style={{ padding: '10px 12px 10px 0', color: 'var(--muted)', display: 'flex', alignItems: 'center' }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                    </div>
                  </button>
                </div>
              );
            })()}
          </div>
        </div>

        {/* Cycles for selected year */}
        {activeCyclesOnly.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--muted)' }}>No active or completed cycles at this time.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 20 }}>
            {visibleCycles.map(c => <CycleCard key={c.id} c={c} />)}
            {visibleCycles.length === 0 && (
              <div style={{ gridColumn: '1/-1', padding: '20px 0', color: 'var(--muted)', fontSize: 13 }}>
                No cycles for {effectiveYear}.
              </div>
            )}
          </div>
        )}

        {/* Inline report */}
        {viewerCycleId && (
          <Reports currentUser={currentUser} embedded viewerMode activeCycleId={viewerCycleId} onCycleChange={setViewerCycleId} />
        )}
        {!viewerCycleId && activeCyclesOnly.length > 0 && (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
            Select an Active or Completed cycle above to view its report.
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="topbar" style={{ marginBottom: 16 }}>
        <div className="left">
          <strong style={{ fontSize: 18 }}>Dashboard</strong>
          {activeCycles.length > 1 && <span className="chip">{activeCycles.length} active cycles</span>}
        </div>
        {activeCycles.length === 1 && (
          <span className="small">Active cycle: <strong>{activeCycles[0].name}</strong> ({activeCycles[0].year})</span>
        )}
      </div>

      {/* ADMIN */}
      {role === 'Admin' && (
        <>
          <div className="kpi">
            <KpiCard
              label="Total Cycles"
              value={cycles.length}
              onClick={cycles.length > 0 ? () => navigate('/cycles') : undefined}
            />
            <KpiCard
              label="Active Cycles"
              value={<span style={{ color: hasActiveCycles ? 'var(--accent)' : 'var(--muted)' }}>{activeCycles.length}</span>}
              onClick={activeCycles.length > 0 ? () => navigate('/cycles') : undefined}
            />
            {(() => {
              const n = cycles.filter(c => c.status === 'closed').length;
              return (
                <KpiCard
                  label="Closed Cycles"
                  value={<span style={{ color: 'var(--ok)' }}>{n}</span>}
                  onClick={n > 0 ? () => navigate('/cycles') : undefined}
                />
              );
            })()}
            <KpiCard
              label="Total Validations (active)"
              value={hasActiveCycles ? new Set(validations.map(v => `${v.cycle_id}:${v.question_id}`)).size : 0}
            />
            <KpiCard
              label="Closed Validations"
              value={(() => {
                if (!hasActiveCycles) return 0;
                // A question is closed only when every BU assigned to it has status='closed'
                const byQuestion = new Map<string, { total: number; closed: number }>();
                for (const v of validations) {
                  const key = `${v.cycle_id}:${v.question_id}`;
                  const entry = byQuestion.get(key) ?? { total: 0, closed: 0 };
                  entry.total++;
                  if (v.status === 'closed') entry.closed++;
                  byQuestion.set(key, entry);
                }
                return [...byQuestion.values()].filter(e => e.total === e.closed).length;
              })()}
            />
          </div>

          <div className="panel" style={{ marginTop: 18 }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>All Cycles</strong>
              <Link to="/cycles"><button className="btn primary">Validation Cycles →</button></Link>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th><th>Year</th><th>Status</th><th>Created</th>
                </tr>
              </thead>
              <tbody>
                {cycles.length === 0 && (
                  <tr><td colSpan={4} className="small" style={{ textAlign: 'center', padding: 24 }}>No cycles yet</td></tr>
                )}
                {cycles.map(c => (
                  <tr key={c.id}>
                    <td><strong>{c.name}</strong></td>
                    <td>{c.year}</td>
                    <td><WorkflowBadge status={c.status} size="sm" /></td>
                    <td className="small">{new Date(c.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* VALIDATOR */}
      {role === 'Validator' && (
        <>
          {/* Pending approval cycles with Senior Validator comments */}
          {cycles.filter(c => c.status === 'pending_approval').map(c => {
            const comments = cycleComments[c.id] ?? [];
            const svComments = comments.filter(cm => cm.user_role === 'Senior Validator');
            return (
              <div key={c.id} style={{ marginBottom: 16, padding: '14px 16px', background: 'rgba(124,58,237,.06)', border: '1px solid rgba(124,58,237,.25)', borderLeft: '4px solid #7c3aed', borderRadius: 'var(--radius2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: svComments.length ? 12 : 0 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>"{c.name}" is pending approval</span>
                  <Link to="/cycles" style={{ marginLeft: 'auto', fontSize: 12, color: '#7c3aed', textDecoration: 'none', fontWeight: 600 }}>View in Cycles →</Link>
                </div>
                {svComments.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#7c3aed', marginBottom: 2 }}>
                      Senior Validator comments
                    </div>
                    {svComments.map(cm => (
                      <div key={cm.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: 'white', borderRadius: 6, padding: '8px 12px' }}>
                        <div style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, background: '#7c3aed', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 11, fontWeight: 700 }}>
                          {cm.user_name.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase()}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 2 }}>
                            <span style={{ fontSize: 12, fontWeight: 600 }}>{cm.user_name}</span>
                            <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>{new Date(cm.created_at).toLocaleString()}</span>
                          </div>
                          <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{cm.body}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {svComments.length === 0 && (
                  <div style={{ fontSize: 13, color: 'var(--muted)', fontStyle: 'italic' }}>No comments from Senior Validator yet.</div>
                )}
              </div>
            );
          })}
          <CycleSelector />
          <div className="kpi">
            <KpiCard
              label="Pending (waiting BUs)"
              value={pendingCount}
              onClick={pendingCount > 0 ? () => navigate(`/validation?status=pending${cycleQS}`) : undefined}
            />
            <KpiCard
              label={<span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>In Review <ActionBadge /></span>}
              value={<span style={{ color: 'var(--warn)' }}>{inReviewCount}</span>}
              onClick={inReviewCount > 0 ? () => navigate(`/validation?status=in_review${cycleQS}`) : undefined}
              style={{ borderTop: '3px solid var(--warn)', background: 'rgba(255,193,7,.06)' }}
            />
            <KpiCard
              label={<span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>Rejected by SV {rejectedCount > 0 && <ActionBadge />}</span>}
              value={<span style={{ color: rejectedCount > 0 ? 'var(--danger)' : 'var(--muted)' }}>{rejectedCount}</span>}
              onClick={rejectedCount > 0 ? () => navigate(`/validation?status=rejected${cycleQS}`) : undefined}
              style={rejectedCount > 0 ? { borderTop: '3px solid var(--danger)', background: 'rgba(220,53,69,.06)' } : undefined}
            />
            <KpiCard
              label="Pending Approval"
              value={<span style={{ color: '#7c3aed' }}>{pendingApprovalCount}</span>}
              onClick={pendingApprovalCount > 0 ? () => navigate(`/validation?status=pending_approval${cycleQS}`) : undefined}
            />
            <KpiCard
              label="Closed"
              value={<span style={{ color: 'var(--ok)' }}>{closedValCount}</span>}
              onClick={closedValCount > 0 ? () => navigate(`/validation?status=closed${cycleQS}`) : undefined}
            />
          </div>
          <div style={{ marginTop: 16 }}>
            <Link to={`/validation${selectedCycleId !== null ? `?cycle_id=${selectedCycleId}` : ''}`}>
              <button className="btn primary">Validation Actions →</button>
            </Link>
          </div>
        </>
      )}

      {/* SENIOR VALIDATOR */}
      {role === 'Senior Validator' && (
        <>
          <CycleSelector />
          <div className="kpi">
            <KpiCard
              label="In Review"
              value={<span style={{ color: 'var(--warn)' }}>{inReviewCount}</span>}
            />
            <KpiCard
              label={<span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>Pending Approval <ActionBadge /></span>}
              value={<span style={{ color: '#7c3aed' }}>{pendingApprovalCount}</span>}
              onClick={pendingApprovalCount > 0
                ? () => navigate(`/validation-overview${selectedCycleId !== null ? `?cycle=${selectedCycleId}` : ''}`)
                : undefined}
              style={{ borderTop: '3px solid #7c3aed', background: 'rgba(124,58,237,.06)' }}
            />
            <KpiCard
              label="Closed"
              value={<span style={{ color: 'var(--ok)' }}>{closedValCount}</span>}
              onClick={closedValCount > 0
                ? () => navigate(`/validation-overview${selectedCycleId !== null ? `?cycle=${selectedCycleId}` : ''}`)
                : undefined}
            />
          </div>
          <div style={{ marginTop: 16 }}>
            <Link to={`/validation-overview${selectedCycleId !== null ? `?cycle=${selectedCycleId}` : ''}`}>
              <button className="btn primary">Validation Overview →</button>
            </Link>
          </div>
        </>
      )}

      {/* RESPONDER */}
      {role === 'Responder' && (
        <>
          {(() => {
            // Always scope to a specific cycle — never "All"
            const respCycleId = selectedCycleId ?? activeCycles[0]?.id ?? null;
            const respResponses = respCycleId !== null
              ? responses.filter(r => r.cycle_id === respCycleId)
              : responses;
            const inProgressCount = hasActiveCycles ? respResponses.filter(r => r.status === 'draft' || r.status === 'in_progress' || r.status === 'returned').length : 0;
            const submittedCount = hasActiveCycles ? respResponses.filter(r => r.status === 'submitted').length : 0;
            const assignedCount = hasActiveCycles ? respResponses.length : 0;
            const assignmentsLink = `/assignments${respCycleId ? `?cycle_id=${respCycleId}` : ''}`;

            return (
              <>
                {/* Cycle selector — no "All" option for Responder */}
                {hasActiveCycles && activeCycles.length > 1 && (
                  <div style={{ marginBottom: 14, padding: '10px 14px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--radius2)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span className="small" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>Active Cycle:</span>
                    <select
                      value={respCycleId ?? ''}
                      onChange={e => setSelectedCycleId(Number(e.target.value))}
                      style={{ fontWeight: 500, minWidth: 220 }}
                    >
                      {activeCycles.map(c => (
                        <option key={c.id} value={c.id}>{c.name} · {c.year}</option>
                      ))}
                    </select>
                  </div>
                )}
                {hasActiveCycles && activeCycles.length === 1 && (
                  <div style={{ marginBottom: 14, padding: '10px 14px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--radius2)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span className="small" style={{ fontWeight: 600 }}>Active Cycle:</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span className="small"><strong>{activeCycles[0].name}</strong> · {activeCycles[0].year}</span>
                      <WorkflowBadge status={activeCycles[0].status} size="sm" />
                    </span>
                  </div>
                )}
                <div className="kpi">
                  <KpiCard
                    label="Assigned Questions"
                    value={assignedCount}
                    onClick={assignedCount > 0 ? () => navigate(assignmentsLink) : undefined}
                  />
                  <KpiCard
                    label={<span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>In Progress <ActionBadge /></span>}
                    value={<span style={{ color: 'var(--warn)' }}>{inProgressCount}</span>}
                    onClick={inProgressCount > 0 ? () => navigate(assignmentsLink) : undefined}
                    style={{ borderTop: '3px solid var(--warn)', background: 'rgba(255,193,7,.06)' }}
                  />
                  <KpiCard
                    label="Submitted"
                    value={<span style={{ color: 'var(--ok)' }}>{submittedCount}</span>}
                    onClick={submittedCount > 0 ? () => navigate(assignmentsLink) : undefined}
                  />
                </div>
                <div style={{ marginTop: 16 }}>
                  <Link to={assignmentsLink}><button className="btn primary">My Assignments →</button></Link>
                </div>
              </>
            );
          })()}
        </>
      )}

    </div>
  );
}
