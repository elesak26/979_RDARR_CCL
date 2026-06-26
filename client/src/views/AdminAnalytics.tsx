import { useState, useEffect, useCallback, Fragment } from 'react';
import { api } from '../api/client';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
  PieChart, Pie, Cell, BarChart,
} from 'recharts';

// ── Types ────────────────────────────────────────────────────────────────────

interface PerformanceTrend {
  id: number; name: string; year: number;
  distributed_at: string | null; closed_at: string | null;
  avg_val_score: number | null; avg_comp_score: number | null;
  closed_validations: number; submitted_responses: number;
  cycle_duration_days: number | null; bu_count: number;
}

interface BUProductivity {
  bu_code: string; total_assigned: number; submitted: number;
  submission_pct: number; avg_score: number | null;
}

interface MonthlyActivity {
  month: string; submitted_count: number; avg_score: number | null;
}

interface ScoreDistribution { score: number; count: number; }
interface CycleStatus { status: string; count: number; }

interface UserActivity {
  role: string; user_count: number; total_logins: number; active_users: number;
}

interface Forecasting {
  next_cycle_est_val: number; next_cycle_est_comp: number;
  r_squared_val: number; r_squared_comp: number; data_points: number;
}

interface Analytics {
  performance_trends: PerformanceTrend[];
  bu_productivity: BUProductivity[];
  monthly_activity: MonthlyActivity[];
  score_distribution: ScoreDistribution[];
  cycle_status: CycleStatus[];
  user_activity: UserActivity[];
  forecasting: Forecasting;
}

// ── Palette & helpers ────────────────────────────────────────────────────────

const SCORE_COLORS: Record<number, string> = { 1: '#dc3545', 2: '#ffc107', 3: '#81b848', 4: '#538135' };
const SCORE_LABELS: Record<number, string> = {
  1: 'Non-compliant', 2: 'Partially compliant', 3: 'Largely compliant', 4: 'Fully compliant',
};

const STATUS_COLORS: Record<string, string> = {
  draft: '#adb5bd', pending_approval: '#7c3aed', published: '#0d6efd',
  distributed: '#007b85', closed: '#28a745',
};

const ROLE_COLORS: Record<string, string> = {
  Admin: '#dc3545', 'Senior Validator': '#7c3aed', Validator: '#007b85',
  Responder: '#ffc107', Viewer: '#6c757d',
};

function scoreColor(n: number): string {
  if (n <= 1.5) return SCORE_COLORS[1];
  if (n <= 2.5) return SCORE_COLORS[2];
  if (n <= 3.5) return SCORE_COLORS[3];
  return SCORE_COLORS[4];
}

function shortName(name: string): string {
  return name.length > 18 ? name.slice(0, 16) + '…' : name;
}

function fmt(v: number | null | undefined, decimals = 2): string {
  if (v === null || v === undefined) return '—';
  return Number(v).toFixed(decimals);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Shared panel wrapper ─────────────────────────────────────────────────────

function Panel({ title, icon, children, action }: {
  title: string; icon: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div style={{
      background: 'var(--panel)', border: '1px solid var(--line)',
      borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow)', overflow: 'hidden', marginBottom: 20,
    }}>
      <div style={{
        padding: '12px 20px', borderBottom: '1px solid var(--line)',
        background: 'var(--panel2)', display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{ fontSize: 15 }}>{icon}</span>
        <strong style={{ fontSize: 13, flex: 1 }}>{title}</strong>
        {action}
      </div>
      <div style={{ padding: '16px 20px' }}>{children}</div>
    </div>
  );
}

// ── KPI card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color }: { label: string; value: React.ReactNode; sub?: string; color?: string }) {
  return (
    <div style={{
      flex: '1 1 160px', padding: '16px 20px',
      background: 'var(--panel)', border: '1px solid var(--line)',
      borderTop: `3px solid ${color ?? 'var(--accent)'}`,
      borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--muted)', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 700, color: color ?? 'var(--text)', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ── Custom tooltip ────────────────────────────────────────────────────────────

const ChartTooltip = ({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string; payload?: { fullName?: string } }[]; label?: string }) => {
  if (!active || !payload?.length) return null;
  const displayLabel = payload[0]?.payload?.fullName ?? label;
  return (
    <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 14px', fontSize: 12, boxShadow: 'var(--shadow-md)' }}>
      {displayLabel && <div style={{ fontWeight: 700, marginBottom: 6 }}>{displayLabel}</div>}
      {payload.map(p => (
        <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color, display: 'inline-block', flexShrink: 0 }} />
          <span style={{ color: 'var(--muted)' }}>{p.name}:</span>
          <span style={{ fontWeight: 700 }}>{typeof p.value === 'number' ? (Number.isInteger(p.value) ? p.value : p.value.toFixed(2)) : p.value}</span>
        </div>
      ))}
    </div>
  );
};

// ── Drill-down table ──────────────────────────────────────────────────────────

function DrillDownTable({ trends }: { trends: PerformanceTrend[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);

  if (trends.length === 0) return <div style={{ color: 'var(--muted)', fontSize: 13, fontStyle: 'italic' }}>No closed cycles yet.</div>;

  return (
    <table className="table" style={{ fontSize: 12 }}>
      <thead>
        <tr>
          <th>Cycle</th><th>Year</th><th>BUs</th><th>Submitted</th>
          <th>Validations Closed</th><th>Avg BU Score</th><th>Avg Val Score</th><th>Duration (days)</th><th>Dates</th>
        </tr>
      </thead>
      <tbody>
        {trends.map(t => (
          <Fragment key={t.id}>
            <tr
              style={{ cursor: 'pointer', background: expanded === t.id ? 'var(--hover-bg)' : undefined }}
              onClick={() => setExpanded(expanded === t.id ? null : t.id)}
            >
              <td>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 10, color: 'var(--muted)' }}>{expanded === t.id ? '▾' : '▸'}</span>
                  <strong>{t.name}</strong>
                </span>
              </td>
              <td>{t.year}</td>
              <td>{t.bu_count}</td>
              <td>{t.submitted_responses}</td>
              <td>
                <span style={{ fontWeight: 700, color: t.closed_validations > 0 ? 'var(--ok)' : 'var(--muted)' }}>
                  {t.closed_validations}
                </span>
              </td>
              <td>
                {t.avg_comp_score !== null
                  ? <span style={{ fontWeight: 700, color: scoreColor(t.avg_comp_score) }}>{fmt(t.avg_comp_score)}</span>
                  : <span style={{ color: 'var(--muted)' }}>—</span>}
              </td>
              <td>
                {t.avg_val_score !== null
                  ? <span style={{ fontWeight: 700, color: scoreColor(t.avg_val_score) }}>{fmt(t.avg_val_score)}</span>
                  : <span style={{ color: 'var(--muted)' }}>—</span>}
              </td>
              <td style={{ color: 'var(--muted)' }}>{t.cycle_duration_days !== null ? `${t.cycle_duration_days}d` : '—'}</td>
              <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{fmtDate(t.distributed_at)} → {fmtDate(t.closed_at)}</td>
            </tr>
            {expanded === t.id && (
              <tr>
                <td colSpan={9} style={{ background: 'var(--panel2)', padding: '12px 20px' }}>
                  <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>Cycle ID</div>
                      <div style={{ fontFamily: 'monospace', fontSize: 12 }}>#{t.id}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>Distributed</div>
                      <div style={{ fontSize: 12 }}>{fmtDate(t.distributed_at)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>Closed</div>
                      <div style={{ fontSize: 12 }}>{fmtDate(t.closed_at)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>Score gap (val − BU)</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: t.avg_val_score !== null && t.avg_comp_score !== null ? (t.avg_val_score - t.avg_comp_score >= 0 ? 'var(--ok)' : 'var(--danger)') : 'var(--muted)' }}>
                        {t.avg_val_score !== null && t.avg_comp_score !== null ? fmt(t.avg_val_score - t.avg_comp_score) : '—'}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>Submission rate</div>
                      <div style={{ fontSize: 12, fontWeight: 700 }}>
                        {t.submitted_responses} / {t.closed_validations > 0 ? t.closed_validations : '?'}
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AdminAnalytics({ year }: { year: number | null }) {
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = year ? `?year=${year}` : '';
      const d = await api.get<Analytics>(`/reporting/admin/analytics${params}`);
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="small" style={{ padding: 24, textAlign: 'center' }}>Loading analytics…</div>;
  if (error) return (
    <div style={{ color: 'var(--danger)', padding: 16 }}>
      {error} <button className="btn" onClick={load} style={{ marginLeft: 8 }}>Retry</button>
    </div>
  );
  if (!data) return null;

  const { performance_trends, bu_productivity, score_distribution, cycle_status, user_activity, forecasting } = data;

  // KPI derivations
  const closedCycles   = performance_trends.length;
  const totalBUs       = new Set(bu_productivity.map(b => b.bu_code)).size;
  const allValScores   = performance_trends.filter(t => t.avg_val_score !== null).map(t => t.avg_val_score as number);
  const avgValScore    = allValScores.length ? (allValScores.reduce((a, b) => a + b, 0) / allValScores.length) : null;
  const avgSubRate     = bu_productivity.length
    ? bu_productivity.reduce((a, b) => a + b.submission_pct, 0) / bu_productivity.length
    : null;

  interface TrendChartRow {
    name: string;
    fullName: string;
    'BU Assessment': number | null;
    'Validation': number | null;
    'Duration (days)': number | null;
    'Est. Validation'?: number;
    'Est. BU Assessment'?: number;
  }

  const trendChartData: TrendChartRow[] = [
    ...performance_trends.map(t => ({
      name: shortName(t.name),
      fullName: t.name,
      'BU Assessment': t.avg_comp_score,
      'Validation': t.avg_val_score,
      'Duration (days)': t.cycle_duration_days,
    })),
    ...(forecasting.data_points >= 2 ? [{
      name: 'Next (est.)',
      fullName: 'Next cycle (estimated)',
      'BU Assessment': null as number | null,
      'Validation': null as number | null,
      'Duration (days)': null as number | null,
      'Est. Validation': forecasting.next_cycle_est_val,
      'Est. BU Assessment': forecasting.next_cycle_est_comp,
    }] : []),
  ];

  return (
    <div>
      {/* ── KPI Row ── */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <KpiCard label="Closed Cycles"        value={closedCycles}                      color="var(--ok)"    sub="all time" />
        <KpiCard label="Active BUs"           value={totalBUs}                          color="var(--accent)" sub="across closed cycles" />
        <KpiCard label="Avg Validation Score" value={avgValScore !== null ? fmt(avgValScore) : '—'} color={avgValScore !== null ? scoreColor(avgValScore) : 'var(--muted)'} sub="across all closed cycles" />
        <KpiCard label="Avg Submission Rate"  value={avgSubRate  !== null ? `${fmt(avgSubRate, 1)}%` : '—'} color="#007b85" sub="across closed cycles" />
      </div>

      {/* ── Performance Trends + Forecasting ── */}
      <Panel title="Performance Trends & Forecasting" icon="📈" action={
        forecasting.data_points >= 2 ? (
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            Based on {forecasting.data_points} cycles · R² val={forecasting.r_squared_val} comp={forecasting.r_squared_comp}
          </span>
        ) : undefined
      }>
        {trendChartData.length === 0 ? (
          <div style={{ color: 'var(--muted)', fontSize: 13, fontStyle: 'italic' }}>No closed cycles yet.</div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={trendChartData} margin={{ top: 8, right: 60, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} />
              <YAxis yAxisId="score" domain={[0, 4]} ticks={[1,2,3,4]} tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={false} label={{ value: 'Score (1–4)', angle: -90, position: 'insideLeft', fontSize: 10, fill: 'var(--muted)', dy: 40 }} />
              <YAxis yAxisId="days"  orientation="right" tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={false} label={{ value: 'Days', angle: 90, position: 'insideRight', fontSize: 10, fill: 'var(--muted)', dy: -20 }} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
              <Bar yAxisId="score" dataKey="BU Assessment" fill="var(--accent)" radius={[4,4,0,0]} barSize={28} />
              <Bar yAxisId="score" dataKey="Validation"    fill="var(--ok)"     radius={[4,4,0,0]} barSize={28} />
              <Line yAxisId="days"  dataKey="Duration (days)"   stroke="#ffc107" strokeWidth={2} dot={{ r: 4 }} type="monotone" />
              <Line yAxisId="score" dataKey="Est. Validation"    stroke="var(--ok)"     strokeWidth={2} strokeDasharray="6 3" dot={{ r: 5, fill: 'var(--ok)' }}     type="monotone" />
              <Line yAxisId="score" dataKey="Est. BU Assessment" stroke="var(--accent)" strokeWidth={2} strokeDasharray="6 3" dot={{ r: 5, fill: 'var(--accent)' }} type="monotone" />
            </ComposedChart>
          </ResponsiveContainer>
        )}
        {forecasting.data_points >= 2 && (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 14, padding: '10px 14px', background: 'var(--panel2)', borderRadius: 'var(--radius)', border: '1px solid var(--line)' }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--muted)', marginBottom: 3 }}>Est. Next Val Score</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: scoreColor(forecasting.next_cycle_est_val) }}>{fmt(forecasting.next_cycle_est_val)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--muted)', marginBottom: 3 }}>Est. Next BU Score</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: scoreColor(forecasting.next_cycle_est_comp) }}>{fmt(forecasting.next_cycle_est_comp)}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
                Forecast based on linear trend of {forecasting.data_points} closed cycles.<br />
                R² val={forecasting.r_squared_val} · R² comp={forecasting.r_squared_comp}<br />
                <span style={{ fontStyle: 'italic' }}>{(() => { const r2 = Math.min(forecasting.r_squared_val, forecasting.r_squared_comp); return r2 > 0.7 ? 'High confidence' : r2 > 0.4 ? 'Moderate confidence' : 'Low confidence — more cycles needed'; })()}</span>
              </div>
            </div>
          </div>
        )}
        {forecasting.data_points < 2 && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>Forecasting requires at least 2 closed cycles.</div>
        )}
      </Panel>

      {/* ── Monthly Submissions ── */}
      {/* ── Pie charts row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
        {/* Score distribution */}
        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow)', overflow: 'hidden' }}>
          <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 15 }}>🎯</span>
            <strong style={{ fontSize: 13 }}>Validation Score Distribution</strong>
          </div>
          <div style={{ padding: '16px 20px' }}>
            {score_distribution.length === 0 ? (
              <div style={{ color: 'var(--muted)', fontSize: 13, fontStyle: 'italic' }}>No closed validations yet.</div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={score_distribution}
                      dataKey="count"
                      nameKey="score"
                      cx="50%" cy="50%"
                      outerRadius={80}
                    >
                      {score_distribution.map(d => (
                        <Cell key={d.score} fill={SCORE_COLORS[d.score] ?? '#adb5bd'} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value, name) => [value, `Score ${name}: ${SCORE_LABELS[Number(name)] ?? ''}`]} />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
                  {score_distribution.map(d => (
                    <div key={d.score} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: SCORE_COLORS[d.score], flexShrink: 0 }} />
                      <span style={{ color: 'var(--muted)' }}><strong style={{ color: SCORE_COLORS[d.score] }}>{d.score}</strong> — {SCORE_LABELS[d.score]} ({d.count})</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Cycle status */}
        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow)', overflow: 'hidden' }}>
          <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 15 }}>🔄</span>
            <strong style={{ fontSize: 13 }}>Cycle Status Distribution</strong>
          </div>
          <div style={{ padding: '16px 20px' }}>
            {cycle_status.length === 0 ? (
              <div style={{ color: 'var(--muted)', fontSize: 13, fontStyle: 'italic' }}>No cycles yet.</div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={cycle_status}
                      dataKey="count"
                      nameKey="status"
                      cx="50%" cy="50%"
                      outerRadius={80}
                    >
                      {cycle_status.map(d => (
                        <Cell key={d.status} fill={STATUS_COLORS[d.status] ?? '#adb5bd'} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
                  {cycle_status.map(d => (
                    <div key={d.status} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: STATUS_COLORS[d.status] ?? '#adb5bd', flexShrink: 0 }} />
                      <span style={{ color: 'var(--muted)' }}>{d.status} ({d.count})</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── User Activity ── */}
      <Panel title="User Activity & Usage" icon="👥">
        {user_activity.length === 0 ? (
          <div style={{ color: 'var(--muted)', fontSize: 13, fontStyle: 'italic' }}>No user data.</div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={user_activity} margin={{ top: 8, right: 20, left: 0, bottom: 8 }} barGap={4} barCategoryGap="35%">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis dataKey="role" tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--muted)' }} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="user_count"   name="Total Users"    radius={[4,4,0,0]}>
                  {user_activity.map(d => <Cell key={d.role} fill={ROLE_COLORS[d.role] ?? '#adb5bd'} />)}
                </Bar>
                <Bar dataKey="active_users" name="Users Logged In" fill="var(--ok)"     radius={[4,4,0,0]} />
                <Bar dataKey="total_logins" name="Total Logins"    fill="var(--accent)" radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
            <div style={{ marginTop: 16 }}>
              <table className="table" style={{ fontSize: 12 }}>
                <thead>
                  <tr><th>Role</th><th style={{ textAlign: 'right' }}>Users</th><th style={{ textAlign: 'right' }}>Logged In</th><th style={{ textAlign: 'right' }}>Total Logins</th><th style={{ textAlign: 'right' }}>Login Rate</th></tr>
                </thead>
                <tbody>
                  {user_activity.map(u => (
                    <tr key={u.role}>
                      <td>
                        <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: `${ROLE_COLORS[u.role] ?? '#adb5bd'}18`, color: ROLE_COLORS[u.role] ?? 'var(--muted)', border: `1px solid ${ROLE_COLORS[u.role] ?? 'var(--line)'}40` }}>
                          {u.role}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>{u.user_count}</td>
                      <td style={{ textAlign: 'right', color: u.active_users > 0 ? 'var(--ok)' : 'var(--muted)' }}>{u.active_users}</td>
                      <td style={{ textAlign: 'right' }}>{u.total_logins}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: u.user_count > 0 && u.active_users / u.user_count >= 0.8 ? 'var(--ok)' : 'var(--muted)' }}>
                        {u.user_count > 0 ? `${((u.active_users / u.user_count) * 100).toFixed(0)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>

      {/* ── Drill-down table ── */}
      <Panel title="Cycle Drill-Down" icon="🔍" action={<span style={{ fontSize: 11, color: 'var(--muted)' }}>Click a row to expand</span>}>
        <DrillDownTable trends={performance_trends} />
      </Panel>
    </div>
  );
}
