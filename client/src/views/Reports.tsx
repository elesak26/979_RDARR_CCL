import { useState, useEffect, useCallback } from 'react';
import { api, getCurrentUserId } from '../api/client';
import type { Cycle, User } from '../types';
import { useBuNames } from '../hooks/useBuNames';
import AdminAnalytics from './AdminAnalytics';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  RadarChart, PolarGrid, PolarAngleAxis, Radar,
} from 'recharts';

interface CycleSummary {
  cycle_id: number;
  counts: {
    total_questions: number;
    total_submitted: number;
    total_validated: number;
    total_closed: number;
    total_respondents: number;
  };
  scores_by_bcbs_principle: BcbsPrincipleRow[];
  scores_by_thematic_area: ThematicAreaRow[];
  scores_by_bu: BURow[];
  validation_vs_compliance: ValidationRow[];
}

interface ThematicAreaRow {
  thematic_area: string;
  avg_compliance_score: number | null;
  avg_validation_score: number | null;
  response_count: number;
}

interface BcbsPrincipleRow {
  bcbs_principle_name: string | null;
  avg_compliance_score: number | null;
  avg_validation_score: number | null;
  response_count: number;
}

interface BURow {
  bu_code: string;
  avg_compliance_score: number | null;
  avg_validation_score: number | null;
  response_count: number;
  submitted_count: number;
}

interface ValidationRow {
  question_id: number;
  item_number: number;
  thematic_area: string;
  avg_compliance_score: number | null;
  validation_score: number | null;
  validation_status: string;
}

interface AuditEntry {
  id: number;
  created_at: string;
  action: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  entity_type: string | null;
  entity_id: number | null;
  cycle_id: number | null;
  cycle_name: string | null;
  details: Record<string, unknown> | null;
}

const ENTITY_TYPES = ['All', 'cycle', 'response', 'validation', 'attachment', 'user'] as const;
const ACTOR_ROLES = ['All', 'Admin', 'Validator', 'Senior Validator', 'Respondent'] as const;

const SCORE_LABELS: Record<number, string> = {
  1: 'Non-compliant',
  2: 'Partially compliant',
  3: 'Largely compliant',
  4: 'Fully compliant',
};

function scoreColor(n: number): string {
  if (n <= 1.5) return '#ff0000';
  if (n <= 2.5) return '#ffc000';
  if (n <= 3.5) return '#81b848';
  return '#538135';
}

function completionColor(pct: number): string {
  if (pct >= 100) return '#28a745';
  if (pct >= 75) return '#007b85';
  if (pct >= 50) return '#ffc107';
  return '#dc3545';
}

// SVG donut ring
function CompletionRing({ pct, label, sublabel }: { pct: number; label: string; sublabel: string }) {
  const r = 38;
  const circ = 2 * Math.PI * r;
  const dash = Math.min(pct / 100, 1) * circ;
  const color = completionColor(pct);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <svg width={96} height={96} viewBox="0 0 96 96">
        <circle cx={48} cy={48} r={r} fill="none" stroke="var(--line)" strokeWidth={9} />
        <circle
          cx={48} cy={48} r={r} fill="none"
          stroke={color} strokeWidth={9}
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          transform="rotate(-90 48 48)"
          style={{ transition: 'stroke-dasharray .6s ease' }}
        />
        <text x={48} y={44} textAnchor="middle" fontSize={17} fontWeight={700} fill={color}>{Math.round(pct)}%</text>
        <text x={48} y={60} textAnchor="middle" fontSize={10} fill="var(--muted)">complete</text>
      </svg>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{sublabel}</div>
      </div>
    </div>
  );
}


// Inline horizontal score bar (scale 1–4)
function ScoreBar({ value }: { value: number | null }) {
  if (value === null || value === undefined) {
    return <span style={{ color: 'var(--muted)', fontSize: 13 }}>—</span>;
  }
  const pct = ((value - 1) / 3) * 100;
  const col = scoreColor(value);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 140 }}>
      <div style={{ flex: 1, height: 7, background: 'var(--line)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`,
          background: col, borderRadius: 4,
          transition: 'width .4s ease',
        }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color: col, minWidth: 30, textAlign: 'right' }}>
        {Number(value).toFixed(2)}
      </span>
    </div>
  );
}

// Score legend shown once
function ScoreLegend() {
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
      {([1, 2, 3, 4] as const).map(s => (
        <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div style={{ width: 10, height: 10, borderRadius: 2, background: scoreColor(s), flexShrink: 0 }} />
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            <strong style={{ color: scoreColor(s) }}>{s}</strong> — {SCORE_LABELS[s]}
          </span>
        </div>
      ))}
    </div>
  );
}

interface Props {
  currentUser?: User | null;
  embedded?: boolean;
  viewerMode?: boolean;
  activeCycleId?: number | null;
  onCycleChange?: (id: number) => void;
}

export default function Reports({ currentUser, embedded, viewerMode, activeCycleId, onCycleChange }: Props) {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [internalCycleId, setInternalCycleId] = useState<number | null>(null);
  const selectedCycleId = activeCycleId !== undefined ? activeCycleId : internalCycleId;
  const setSelectedCycleId = (id: number) => {
    if (onCycleChange) onCycleChange(id);
    else setInternalCycleId(id);
  };
  const [summary, setSummary] = useState<CycleSummary | null>(null);
  const [thematicBuFilter, setThematicBuFilter] = useState<string>('all');
  const [thematicRows, setThematicRows] = useState<CycleSummary['scores_by_thematic_area'] | null>(null);
  const [loadingCycles, setLoadingCycles] = useState(true);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adminTab, setAdminTab] = useState<'analytics' | 'audit'>('analytics');
  const [selectedYear, setSelectedYear] = useState<number | null>(null);

  // Audit log state (Admin only)
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditCycleId, setAuditCycleId] = useState<string>('');
  const [auditEntityType, setAuditEntityType] = useState<string>('All');
  const [auditActorRole, setAuditActorRole] = useState<string>('All');
  const [auditDateFrom, setAuditDateFrom] = useState<string>('');
  const [auditDateTo, setAuditDateTo] = useState<string>('');

  const loadCycles = useCallback(async () => {
    setLoadingCycles(true);
    setError(null);
    try {
      const all = await api.get<Cycle[]>('/cycles');
      const data = all.filter(c => c.status === 'distributed' || c.status === 'closed');
      setCycles(data);
      const preferred = data.find(c => c.status === 'distributed') ?? data.find(c => c.status === 'closed');
      if (preferred) setInternalCycleId(preferred.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load cycles');
    } finally {
      setLoadingCycles(false);
    }
  }, []);

  useEffect(() => { loadCycles(); }, [loadCycles]);

  const loadSummary = useCallback(async (cycleId: number) => {
    setLoadingSummary(true);
    setSummary(null);
    setThematicRows(null);
    setThematicBuFilter('all');
    setError(null);
    try {
      const data = await api.get<CycleSummary>(`/reporting/cycle/${cycleId}/summary`);
      setSummary(data);
      setThematicRows(data.scores_by_thematic_area);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load report');
    } finally {
      setLoadingSummary(false);
    }
  }, []);

  useEffect(() => {
    if (selectedCycleId !== null) loadSummary(selectedCycleId);
  }, [selectedCycleId, loadSummary]);

  useEffect(() => {
    if (!selectedCycleId) return;
    if (thematicBuFilter === 'all') {
      // reset is handled by loadSummary; nothing to do here
      return;
    }
    let cancelled = false;
    api.get<CycleSummary>(`/reporting/cycle/${selectedCycleId}/summary?bu_code=${encodeURIComponent(thematicBuFilter)}`)
      .then(data => { if (!cancelled) setThematicRows(data.scores_by_thematic_area); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [thematicBuFilter, selectedCycleId]);

  const selectedCycle = cycles.find(c => c.id === selectedCycleId);
  const buName = useBuNames();

  const buildAuditParams = useCallback(() => {
    const params = new URLSearchParams();
    if (auditCycleId) params.set('cycle_id', auditCycleId);
    if (auditEntityType !== 'All') params.set('entity_type', auditEntityType);
    if (auditActorRole !== 'All') params.set('actor_role', auditActorRole);
    if (auditDateFrom) params.set('from', auditDateFrom);
    if (auditDateTo) params.set('to', auditDateTo);
    params.set('limit', '100');
    return params;
  }, [auditCycleId, auditEntityType, auditActorRole, auditDateFrom, auditDateTo]);

  const loadAuditLog = useCallback(async () => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const params = buildAuditParams();
      const data = await api.get<AuditEntry[]>(`/audit-log${params.toString() ? '?' + params.toString() : ''}`);
      setAuditEntries(data);
    } catch (e) {
      setAuditError(e instanceof Error ? e.message : 'Failed to load audit log');
    } finally {
      setAuditLoading(false);
    }
  }, [buildAuditParams]);

  useEffect(() => {
    if (currentUser?.role === 'Admin') loadAuditLog();
  }, [currentUser, loadAuditLog]);

  const handleAuditExportCsv = () => {
    const params = buildAuditParams();
    params.set('format', 'csv');
    const userId = getCurrentUserId();
    if (userId) params.set('_user', userId);
    window.open(`/api/audit-log?${params.toString()}`, '_blank');
  };

  if (loadingCycles) return <div className="small" style={{ padding: 24 }}>Loading reports…</div>;
  if (error && !summary) return (
    <div style={{ color: 'var(--danger)', padding: 16 }}>
      Error: {error} <button className="btn" onClick={loadCycles} style={{ marginLeft: 8 }}>Retry</button>
    </div>
  );

  // ── Validator / Senior Validator — Viewer-style layout ──────────────────────
  if (!embedded && (currentUser?.role === 'Validator' || currentUser?.role === 'Senior Validator')) {
    const CYCLE_META: Record<string, { label: string; accent: string; bg: string; clickable: boolean; hint?: string }> = {
      distributed: { label: 'Active',    accent: 'var(--accent)', bg: 'var(--accent-light)',  clickable: true },
      closed:      { label: 'Completed', accent: 'var(--ok)',     bg: 'rgba(40,167,69,.08)', clickable: true },
    };

    const sortedCycles = [...cycles].sort((a, b) => b.year - a.year || b.id - a.id);
    const availableYears = [...new Set(sortedCycles.map(c => c.year))].sort((a, b) => b - a);
    const effectiveYear = selectedYear ?? availableYears[0] ?? null;
    const visibleCycles = effectiveYear !== null ? sortedCycles.filter(c => c.year === effectiveYear) : sortedCycles;

    function CycleCard({ c }: { c: Cycle }) {
      const meta = CYCLE_META[c.status] ?? { label: c.status, accent: 'var(--muted)', bg: 'var(--panel2)', clickable: false };
      const isSelected = internalCycleId === c.id;
      return (
        <div
          onClick={meta.clickable ? () => setInternalCycleId(c.id) : undefined}
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
          <strong style={{ fontSize: 22 }}>Reports</strong>
          {availableYears.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>
                Validation Year
              </span>
              <div style={{
                display: 'flex', alignItems: 'center', position: 'relative',
                background: 'var(--panel)', border: '1px solid var(--line)',
                borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow-md)', overflow: 'hidden',
              }}>
                <div style={{ background: 'var(--accent-dark)', padding: '10px 14px', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                  </svg>
                </div>
                <select
                  value={effectiveYear ?? ''}
                  onChange={e => { setSelectedYear(Number(e.target.value)); setInternalCycleId(null); }}
                  style={{ border: 'none', outline: 'none', background: 'transparent', fontWeight: 700, fontSize: 15, color: 'var(--text)', padding: '10px 36px 10px 14px', cursor: 'pointer', appearance: 'none', minWidth: 80 }}
                >
                  {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
                <div style={{ pointerEvents: 'none', position: 'absolute', right: 12, color: 'var(--muted)' }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Cycle cards */}
        {cycles.length === 0 ? (
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
        {internalCycleId && (
          <Reports currentUser={currentUser} embedded activeCycleId={internalCycleId} onCycleChange={setInternalCycleId} />
        )}
        {!internalCycleId && cycles.length > 0 && (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
            Select a cycle above to view its report.
          </div>
        )}
      </div>
    );
  }

  // ── Derived data ────────────────────────────────────────────────────────────

  const submissionPct = summary
    ? Math.round((summary.counts.total_submitted / Math.max(summary.counts.total_questions, 1)) * 100)
    : 0;

  const validationPct = summary
    ? Math.round((summary.counts.total_closed / Math.max(summary.counts.total_submitted, 1)) * 100)
    : 0;

  const barChartData = (summary?.scores_by_bcbs_principle ?? []).map(row => ({
    name: row.bcbs_principle_name?.trim() ?? '—',
    'BU Assessment': row.avg_compliance_score !== null ? Number(Number(row.avg_compliance_score).toFixed(2)) : 0,
    'Validation': row.avg_validation_score !== null ? Number(Number(row.avg_validation_score).toFixed(2)) : 0,
  }));

  const radarRows = (summary?.scores_by_thematic_area ?? [])
    .filter(r => r.avg_validation_score !== null);
  const radarData = radarRows.map((row, i) => ({
    area: String(i + 1),
    fullArea: row.thematic_area.replace(/^\d+\.\s*/, '').trim(),
    score: Number(Number(row.avg_validation_score).toFixed(2)),
    fullMark: 4,
  }));

  return (
    <div>
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 16, flexWrap: 'wrap' }}>
        <div>
          {!embedded && <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.3px' }}>Reports</div>}
          {selectedCycle && currentUser?.role !== 'Admin' && (
            <div className="small" style={{ marginTop: 2 }}>
              {selectedCycle.name} · {selectedCycle.year} ·{' '}
              <span style={{
                display: 'inline-block', padding: '1px 8px', borderRadius: 999,
                fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px',
                background: selectedCycle.status === 'distributed' ? 'rgba(0,123,133,.12)' : selectedCycle.status === 'closed' ? 'rgba(40,167,69,.12)' : 'var(--chip)',
                color: selectedCycle.status === 'distributed' ? 'var(--accent)' : selectedCycle.status === 'closed' ? 'var(--ok)' : 'var(--muted)',
              }}>
                {selectedCycle.status}
              </span>
            </div>
          )}
        </div>
        {!embedded && currentUser?.role !== 'Admin' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label className="small" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>Cycle</label>
            <select
              value={selectedCycleId ?? ''}
              onChange={e => setSelectedCycleId(Number(e.target.value))}
              style={{ minWidth: 220, fontWeight: 500 }}
            >
              <option value="" disabled>Select a cycle…</option>
              {cycles.map(c => (
                <option key={c.id} value={c.id}>{c.name} ({c.year}) — {c.status}</option>
              ))}
            </select>
          </div>
        )}
        {!embedded && currentUser?.role === 'Admin' && (() => {
          const availableYears = [...new Set(cycles.map(c => c.year))].sort((a, b) => b - a);
          const effectiveYear = selectedYear ?? availableYears[0] ?? null;
          return availableYears.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>
                Validation Year
              </span>
              <div style={{
                display: 'flex', alignItems: 'center', position: 'relative',
                background: 'var(--panel)', border: '1px solid var(--line)',
                borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow-md)', overflow: 'hidden',
              }}>
                <div style={{ background: 'var(--accent-dark)', padding: '10px 14px', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                  </svg>
                </div>
                <select
                  value={effectiveYear ?? ''}
                  onChange={e => setSelectedYear(Number(e.target.value))}
                  style={{ border: 'none', outline: 'none', background: 'transparent', fontWeight: 700, fontSize: 15, color: 'var(--text)', padding: '10px 36px 10px 14px', cursor: 'pointer', appearance: 'none', minWidth: 80 }}
                >
                  {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
                <div style={{ pointerEvents: 'none', position: 'absolute', right: 12, color: 'var(--muted)' }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                </div>
              </div>
            </div>
          ) : null;
        })()}
      </div>

      {!selectedCycleId && (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
          Select a cycle above to view its report.
        </div>
      )}

      {selectedCycleId && loadingSummary && (
        <div className="small" style={{ padding: 24, textAlign: 'center' }}>Loading summary…</div>
      )}

      {error && (
        <div style={{ color: 'var(--danger)', marginBottom: 16, padding: '10px 14px', background: 'rgba(220,53,69,.08)', borderRadius: 6, border: '1px solid var(--danger)', fontSize: 13 }}>
          {error}
        </div>
      )}

      {summary && selectedCycle && (
        <>
          {/* ── Completion overview ── */}
          {currentUser?.role !== 'Admin' && (selectedCycle.status === 'closed' ? (
            <div style={{
              background: 'var(--panel)', border: '1px solid var(--line)',
              borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow)',
              marginBottom: 20, overflow: 'hidden',
            }}>
              <div style={{
                padding: '12px 20px', borderBottom: '1px solid var(--line)',
                background: 'var(--panel2)', display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <span style={{ fontSize: 15 }}>✅</span>
                <strong style={{ fontSize: 13 }}>Cycle Summary</strong>
              </div>
              <div style={{ display: 'flex', gap: 0, flexWrap: 'wrap' }}>
                {[
                  {
                    icon: '📋',
                    label: 'Questions Evaluated',
                    value: summary.counts.total_questions,
                    color: 'var(--ok)',
                  },
                  {
                    icon: '🏢',
                    label: 'Respondents Assigned',
                    value: summary.counts.total_respondents,
                    color: 'var(--accent)',
                  },
                  {
                    icon: '🗓️',
                    label: 'Start Date',
                    value: selectedCycle.distributed_at
                      ? new Date(selectedCycle.distributed_at).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
                      : '—',
                    color: 'var(--text)',
                    isDate: true,
                  },
                  {
                    icon: '🏁',
                    label: 'End Date',
                    value: selectedCycle.closed_at
                      ? new Date(selectedCycle.closed_at).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
                      : '—',
                    color: 'var(--text)',
                    isDate: true,
                  },
                ].map((card, i, arr) => (
                  <div key={card.label} style={{
                    flex: '1 1 180px',
                    padding: '20px 24px',
                    borderRight: i < arr.length - 1 ? '1px solid var(--line)' : undefined,
                    borderTop: `3px solid ${card.color}`,
                  }}>
                    <div style={{ fontSize: 20, marginBottom: 6 }}>{card.icon}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>
                      {card.label}
                    </div>
                    <div style={{ fontSize: card.isDate ? 18 : 32, fontWeight: 700, color: card.color, lineHeight: 1 }}>
                      {card.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{
              background: 'var(--panel)', border: '1px solid var(--line)',
              borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow)',
              marginBottom: 20, padding: '20px 24px',
              display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center',
            }}>
              {/* Rings */}
              <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
                <CompletionRing
                  pct={submissionPct}
                  label="Submission"
                  sublabel={`${summary.counts.total_submitted} / ${summary.counts.total_questions} questions`}
                />
                <CompletionRing
                  pct={validationPct}
                  label="Validation"
                  sublabel={`${summary.counts.total_closed} / ${summary.counts.total_submitted} closed`}
                />
              </div>

              {/* Divider */}
              <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--line)', flexShrink: 0 }} />

              {/* Metric cards */}
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', flex: 1 }}>
                {[
                  { label: 'Total Questions', value: summary.counts.total_questions, color: 'var(--muted)', icon: '📋' },
                  { label: 'Sent for Evaluation', value: summary.counts.total_submitted, color: 'var(--accent)', icon: '📨' },
                  { label: 'In Validation', value: summary.counts.total_validated, color: 'var(--warn)', icon: '🔍' },
                  { label: 'Closed', value: summary.counts.total_closed, color: 'var(--ok)', icon: '✅' },
                ].map(card => (
                  <div key={card.label} style={{
                    flex: '1 1 110px',
                    padding: '14px 16px',
                    background: 'var(--panel2)',
                    border: '1px solid var(--line)',
                    borderTop: `3px solid ${card.color}`,
                    borderRadius: 'var(--radius)',
                  }}>
                    <div style={{ fontSize: 18, marginBottom: 4 }}>{card.icon}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4 }}>
                      {card.label}
                    </div>
                    <div style={{ fontSize: 28, fontWeight: 700, color: card.color, lineHeight: 1 }}>
                      {card.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* ── Score legend ── */}
          {!viewerMode && currentUser?.role !== 'Admin' && (
            <div style={{
              padding: '10px 16px', marginBottom: 20,
              background: 'var(--panel)', border: '1px solid var(--line)',
              borderRadius: 'var(--radius2)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            }}>
              <span className="small" style={{ fontWeight: 600, color: 'var(--muted)', whiteSpace: 'nowrap' }}>Score scale:</span>
              <ScoreLegend />
            </div>
          )}

          {/* ── Respondent Scores by Thematic Area ── */}
          {!viewerMode && currentUser?.role !== 'Admin' && (() => {
            const submittedBus = summary.scores_by_bu.filter(bu => bu.submitted_count > 0);
            const rows = thematicRows ?? summary.scores_by_thematic_area;
            const compValues = rows.map(r => r.avg_compliance_score).filter((v): v is number => v !== null);
            const valValues  = rows.map(r => r.avg_validation_score).filter((v): v is number => v !== null);
            const totalComp = compValues.length > 0 ? compValues.reduce((a, b) => a + b, 0) / compValues.length : null;
            const totalVal  = valValues.length  > 0 ? valValues.reduce((a, b) => a + b, 0)  / valValues.length  : null;
            return (
              <div style={{
                background: 'var(--panel)', border: '1px solid var(--line)',
                borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow)',
                marginBottom: 20, overflow: 'hidden',
              }}>
                {/* Header */}
                <div style={{
                  padding: '12px 20px', borderBottom: '1px solid var(--line)',
                  background: 'var(--panel2)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                }}>
                  <span style={{ fontSize: 15 }}>🗂️</span>
                  <strong style={{ fontSize: 13 }}>Respondent Scores by Thematic Area</strong>
                  <span className="small" style={{ marginLeft: 'auto', color: 'var(--muted)' }}>{rows.length} areas</span>
                </div>
                {/* Respondent filter bar */}
                {submittedBus.length > 0 && (
                  <div style={{
                    padding: '10px 20px', borderBottom: '1px solid var(--line)',
                    background: 'var(--panel)', display: 'flex', alignItems: 'center', gap: 10,
                  }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', whiteSpace: 'nowrap' }}>Respondent</span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        onClick={() => { setThematicBuFilter('all'); setThematicRows(summary.scores_by_thematic_area); }}
                        style={{
                          fontSize: 12, padding: '3px 12px', borderRadius: 20, cursor: 'pointer',
                          border: `1px solid ${thematicBuFilter === 'all' ? 'var(--accent)' : 'var(--line)'}`,
                          background: thematicBuFilter === 'all' ? 'var(--accent)' : 'transparent',
                          color: thematicBuFilter === 'all' ? '#fff' : 'var(--text)',
                          fontWeight: thematicBuFilter === 'all' ? 700 : 400,
                          transition: 'all .15s',
                        }}
                      >
                        All
                      </button>
                      {submittedBus.map(bu => (
                        <button
                          key={bu.bu_code}
                          onClick={() => setThematicBuFilter(bu.bu_code)}
                          style={{
                            fontSize: 12, padding: '3px 12px', borderRadius: 20, cursor: 'pointer',
                            border: `1px solid ${thematicBuFilter === bu.bu_code ? 'var(--accent)' : 'var(--line)'}`,
                            background: thematicBuFilter === bu.bu_code ? 'var(--accent)' : 'transparent',
                            color: thematicBuFilter === bu.bu_code ? '#fff' : 'var(--text)',
                            fontWeight: thematicBuFilter === bu.bu_code ? 700 : 400,
                            transition: 'all .15s',
                          }}
                        >
                          {buName(bu.bu_code)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {/* Table */}
                <table className="table">
                  <thead>
                    <tr>
                      <th>Thematic Area</th>
                      <th style={{ textAlign: 'right', width: 80 }}>Questions</th>
                      <th style={{ width: 220 }}>Avg Compliance</th>
                      <th style={{ width: 220 }}>Avg Validation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && (
                      <tr><td colSpan={4} className="small" style={{ textAlign: 'center', padding: 32 }}>No data yet.</td></tr>
                    )}
                    {rows.map(row => {
                      const compScore = row.avg_compliance_score;
                      const rowBg = compScore !== null ? `${scoreColor(compScore)}08` : undefined;
                      return (
                        <tr key={row.thematic_area} style={{ background: rowBg }}>
                          <td style={{ fontWeight: 500, fontSize: 13 }}>{row.thematic_area.trim()}</td>
                          <td style={{ textAlign: 'right', color: 'var(--muted)', fontSize: 13 }}>{row.response_count}</td>
                          <td><ScoreBar value={row.avg_compliance_score} /></td>
                          <td>
                            {row.avg_validation_score !== null
                              ? <ScoreBar value={row.avg_validation_score} />
                              : <span style={{ color: 'var(--muted)', fontSize: 12, fontStyle: 'italic' }}>Pending</span>
                            }
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {rows.length > 0 && (
                    <tfoot>
                      <tr style={{ borderTop: '2px solid var(--line)', background: 'var(--panel2)' }}>
                        <td style={{ fontWeight: 700, fontSize: 13 }}>Overall Average</td>
                        <td />
                        <td><ScoreBar value={totalComp} /></td>
                        <td>
                          {totalVal !== null
                            ? <ScoreBar value={totalVal} />
                            : <span style={{ color: 'var(--muted)', fontSize: 12, fontStyle: 'italic' }}>Pending</span>
                          }
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            );
          })()}

          {/* ── Charts row ── */}
          <div style={{ display: 'grid', gridTemplateColumns: radarData.length > 2 ? '1fr 1fr' : '1fr', gap: 16, marginBottom: 20 }}>
            {/* Bar chart — BCBS 239 Principle */}
            {barChartData.length > 0 && !(viewerMode && selectedCycle?.status === 'distributed') && currentUser?.role !== 'Admin' && (
              <div style={{
                background: 'var(--panel)', border: '1px solid var(--line)',
                borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow)', overflow: 'hidden',
              }}>
                <div style={{
                  padding: '12px 20px', borderBottom: '1px solid var(--line)',
                  background: 'var(--panel2)', display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <span style={{ fontSize: 15 }}>📊</span>
                  <strong style={{ fontSize: 13 }}>Avg Score by BCBS 239 Principle</strong>
                  <span className="small" style={{ marginLeft: 'auto', color: 'var(--muted)' }}>Scale 1–4</span>
                </div>
                <div style={{ padding: '16px 16px 8px' }}>
                  <ResponsiveContainer width="100%" height={Math.max(260, barChartData.length * 46)}>
                    <BarChart
                      data={barChartData}
                      layout="vertical"
                      margin={{ top: 4, right: 48, left: 8, bottom: 4 }}
                      barGap={4} barCategoryGap="30%"
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={false} />
                      <XAxis
                        type="number"
                        domain={[0, 4]} ticks={[1, 2, 3, 4]}
                        tick={{ fontSize: 11, fill: 'var(--muted)' }}
                        axisLine={{ stroke: 'var(--line)' }} tickLine={false}
                      />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={180}
                        tick={{ fontSize: 12, fill: 'var(--text)', fontWeight: 500 }}
                        axisLine={false} tickLine={false}
                      />
                      <Tooltip
                        contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--shadow-md)' }}
                        labelStyle={{ fontWeight: 700, marginBottom: 4 }}
                        cursor={{ fill: 'var(--hover-bg)' }}
                        formatter={(val: number) => [val.toFixed(2)]}
                      />
                      <Legend
                        layout="vertical"
                        verticalAlign="top"
                        align="right"
                        wrapperStyle={{ fontSize: 13, fontWeight: 600, paddingLeft: 12 }}
                      />
                      <Bar dataKey="BU Assessment" fill="var(--accent)" radius={[0, 4, 4, 0]} />
                      <Bar dataKey="Validation" fill="var(--ok)" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Radar chart — compliance profile */}
            {radarData.length > 2 && currentUser?.role !== 'Admin' && (
              <div style={{
                background: 'var(--panel)', border: '1px solid var(--line)',
                borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow)', overflow: 'hidden',
              }}>
                <div style={{
                  padding: '12px 20px', borderBottom: '1px solid var(--line)',
                  background: 'var(--panel2)', display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <span style={{ fontSize: 15 }}>🕸️</span>
                  <strong style={{ fontSize: 13 }}>Avg Validation Score by Thematic Area</strong>
                </div>
                <div style={{ padding: '16px 8px 0' }}>
                  <ResponsiveContainer width="100%" height={280}>
                    <RadarChart data={radarData} margin={{ top: 20, right: 30, bottom: 20, left: 30 }}>
                      <PolarGrid stroke="var(--line)" />
                      <PolarAngleAxis
                        dataKey="area"
                        tick={{ fontSize: 13, fill: 'var(--text)', fontWeight: 700 }}
                      />
                      <Radar
                        name="Avg Validation"
                        dataKey="score"
                        stroke="var(--accent)"
                        fill="var(--accent)"
                        fillOpacity={0.2}
                        dot={{ r: 3, fill: 'var(--accent)' }}
                      />
                      <Tooltip
                        contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12 }}
                        formatter={(val: number, _name: string, props: { payload?: { fullArea?: string } }) => [
                          val.toFixed(2),
                          props.payload?.fullArea ?? 'Avg Compliance',
                        ]}
                      />
                    </RadarChart>
                  </ResponsiveContainer>
                  {/* Numbered legend */}
                  <div style={{ padding: '8px 16px 14px', borderTop: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {radarData.map(d => (
                      <div key={d.area} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12 }}>
                        <span style={{
                          flexShrink: 0, width: 20, height: 20, borderRadius: '50%',
                          background: 'var(--accent)', color: '#fff',
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 11, fontWeight: 700,
                        }}>{d.area}</span>
                        <span style={{ color: 'var(--text)', lineHeight: 1.4 }}>{d.fullArea}</span>
                        <span style={{ marginLeft: 'auto', flexShrink: 0, fontWeight: 700, color: 'var(--accent)', fontSize: 12 }}>{d.score.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Scores by BU ── */}
          {currentUser?.role !== 'Admin' && <div style={{
            background: 'var(--panel)', border: '1px solid var(--line)',
            borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow)',
            marginBottom: 20, overflow: 'hidden',
          }}>
            <div style={{
              padding: '12px 20px', borderBottom: '1px solid var(--line)',
              background: 'var(--panel2)', display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 15 }}>🏢</span>
              <strong style={{ fontSize: 13 }}>{viewerMode && selectedCycle?.status === 'distributed' ? 'Validation Cycle Progress Overview' : 'Business-RDARR Validation: Assessment Alignment'}</strong>
              <span className="small" style={{ marginLeft: 'auto' }}>{summary.scores_by_bu.length} BUs</span>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 100 }}>BU</th>
                  {selectedCycle?.status === 'closed'
                    ? <th style={{ width: 220 }}>Avg BU Assessment Score</th>
                    : <th style={{ width: 200 }}>Submission Progress</th>
                  }
                  {selectedCycle?.status !== 'closed' && (
                    <th style={{ width: 80, textAlign: 'right' }}>Submitted</th>
                  )}
                  <th style={{ width: 220 }}>{selectedCycle?.status === 'closed' ? 'Avg Validation Score' : 'Avg Compliance'}</th>
                  {selectedCycle?.status !== 'closed' && (
                    <th style={{ width: 100, textAlign: 'center' }}>Status</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {summary.scores_by_bu.length === 0 && (
                  <tr><td colSpan={selectedCycle?.status === 'closed' ? 3 : 5} className="small" style={{ textAlign: 'center', padding: 32 }}>No data yet.</td></tr>
                )}
                {summary.scores_by_bu.map(row => {
                  const pct = row.response_count > 0
                    ? Math.round((row.submitted_count / row.response_count) * 100)
                    : 0;
                  const done = pct === 100 && row.response_count > 0;
                  return (
                    <tr key={row.bu_code}>
                      <td>
                        <span style={{
                          display: 'inline-block', padding: '2px 8px',
                          borderRadius: 4, background: 'var(--chip)',
                          fontFamily: 'monospace', fontSize: 12, fontWeight: 700,
                          border: '1px solid var(--line)', color: 'var(--text)',
                        }}>
                          {buName(row.bu_code)}
                        </span>
                      </td>
                      {selectedCycle?.status === 'closed' ? (
                        <td><ScoreBar value={row.avg_compliance_score} /></td>
                      ) : (
                        <>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ flex: 1, height: 7, background: 'var(--line)', borderRadius: 4, overflow: 'hidden' }}>
                                <div style={{
                                  height: '100%', width: `${pct}%`,
                                  background: completionColor(pct), borderRadius: 4,
                                  transition: 'width .4s ease',
                                }} />
                              </div>
                              <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{pct}%</span>
                            </div>
                          </td>
                          <td style={{ textAlign: 'right', fontSize: 13 }}>
                            <span style={{ color: done ? 'var(--ok)' : 'var(--text)', fontWeight: done ? 700 : 400 }}>
                              {row.submitted_count}
                            </span>
                            <span style={{ color: 'var(--muted)' }}>/{row.response_count}</span>
                          </td>
                        </>
                      )}
                      <td>
                        {selectedCycle?.status === 'closed'
                          ? <ScoreBar value={row.avg_validation_score} />
                          : row.avg_compliance_score !== null
                            ? <ScoreBar value={row.avg_compliance_score} />
                            : <span style={{ color: 'var(--muted)', fontSize: 12, fontStyle: 'italic' }}>
                                {row.submitted_count === 0 ? 'Not started' : 'No score yet'}
                              </span>
                        }
                      </td>
                      {selectedCycle?.status !== 'closed' && (
                        <td style={{ textAlign: 'center' }}>
                          {done ? (
                            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'rgba(40,167,69,.12)', color: 'var(--ok)' }}>
                              ✓ Complete
                            </span>
                          ) : row.submitted_count === 0 ? (
                            <span style={{ fontSize: 11, color: 'var(--muted)' }}>Pending</span>
                          ) : (
                            <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: 'rgba(255,193,7,.12)', color: '#856404' }}>
                              In progress
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>}
        </>
      )}

      {/* ── Admin Analytics + Audit Log ── */}
      {currentUser?.role === 'Admin' && (
        <div style={{ marginTop: 32 }}>
          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '2px solid var(--line)' }}>
            {(['analytics', 'audit'] as const).map(t => (
              <button
                key={t}
                onClick={() => setAdminTab(t)}
                style={{
                  padding: '8px 22px', border: 'none', background: 'none', cursor: 'pointer',
                  fontSize: 13, fontWeight: 600,
                  color: adminTab === t ? 'var(--accent)' : 'var(--muted)',
                  borderBottom: adminTab === t ? '2px solid var(--accent)' : '2px solid transparent',
                  marginBottom: -2,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {t === 'analytics' ? '📊 Analytics' : '📝 Audit Log'}
              </button>
            ))}
          </div>

          {/* Analytics tab */}
          {adminTab === 'analytics' && <AdminAnalytics year={selectedYear ?? ([...new Set(cycles.map(c => c.year))].sort((a, b) => b - a)[0] ?? null)} />}

          {/* Audit Log tab */}
          {adminTab === 'audit' && (
          <div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '14px 20px', marginBottom: 16,
            background: 'var(--panel)', border: '1px solid var(--line)',
            borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow)',
          }}>
            <span style={{ fontSize: 15 }}>📝</span>
            <strong style={{ fontSize: 14 }}>Audit Log</strong>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', marginBottom: 14 }}>
            {cycles.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span className="small" style={{ color: 'var(--muted)' }}>Cycle</span>
                <select value={auditCycleId} onChange={e => setAuditCycleId(e.target.value)} style={{ minWidth: 160 }}>
                  <option value="">All cycles</option>
                  {cycles.map(c => <option key={c.id} value={String(c.id)}>{c.name} ({c.year})</option>)}
                </select>
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span className="small" style={{ color: 'var(--muted)' }}>Entity Type</span>
              <select value={auditEntityType} onChange={e => setAuditEntityType(e.target.value)} style={{ minWidth: 140 }}>
                {ENTITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span className="small" style={{ color: 'var(--muted)' }}>Actor Role</span>
              <select value={auditActorRole} onChange={e => setAuditActorRole(e.target.value)} style={{ minWidth: 150 }}>
                {ACTOR_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span className="small" style={{ color: 'var(--muted)' }}>From</span>
              <input type="date" value={auditDateFrom} onChange={e => setAuditDateFrom(e.target.value)} style={{ minWidth: 130 }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span className="small" style={{ color: 'var(--muted)' }}>To</span>
              <input type="date" value={auditDateTo} onChange={e => setAuditDateTo(e.target.value)} style={{ minWidth: 130 }} />
            </div>
            <button className="btn" onClick={loadAuditLog} disabled={auditLoading} style={{ alignSelf: 'flex-end' }}>
              {auditLoading ? 'Loading…' : 'Apply'}
            </button>
            <button className="btn" onClick={handleAuditExportCsv} style={{ alignSelf: 'flex-end' }}>Export CSV</button>
          </div>

          {auditError && (
            <div style={{ color: 'var(--danger)', marginBottom: 12, padding: '8px 12px', background: 'rgba(220,53,69,.08)', borderRadius: 6, border: '1px solid var(--danger)' }}>
              {auditError}
            </div>
          )}

          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow)', overflow: 'hidden' }}>
            <table className="table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>Timestamp</th><th>Action</th><th>Actor</th><th>Role</th><th>Entity Type</th><th>Cycle</th><th>Details</th>
                </tr>
              </thead>
              <tbody>
                {auditLoading && <tr><td colSpan={7} className="small" style={{ textAlign: 'center', padding: 24 }}>Loading…</td></tr>}
                {!auditLoading && auditEntries.length === 0 && <tr><td colSpan={7} className="small" style={{ textAlign: 'center', padding: 24 }}>No audit entries found.</td></tr>}
                {!auditLoading && auditEntries.map(entry => {
                  const detailsStr = entry.details ? JSON.stringify(entry.details) : '';
                  const detailsTrunc = detailsStr.length > 80 ? detailsStr.substring(0, 80) + '…' : detailsStr;
                  return (
                    <tr key={entry.id}>
                      <td style={{ whiteSpace: 'nowrap', color: 'var(--muted)' }}>{entry.created_at ? new Date(entry.created_at).toLocaleString() : '—'}</td>
                      <td><strong>{entry.action}</strong></td>
                      <td>{entry.actor_name ?? entry.actor_id ?? '—'}</td>
                      <td>{entry.actor_role ?? '—'}</td>
                      <td>{entry.entity_type ?? '—'}</td>
                      <td>{entry.cycle_name ?? (entry.cycle_id ? String(entry.cycle_id) : '—')}</td>
                      <td style={{ fontFamily: 'monospace', color: 'var(--muted)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={detailsStr}>{detailsTrunc}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </div>
          )}
        </div>
      )}
    </div>
  );
}
