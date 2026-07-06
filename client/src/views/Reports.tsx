import { useState, useEffect, useCallback, useRef } from 'react';
import { api, getCurrentUserId } from '../api/client';
import type { Cycle, User } from '../types';
import { useBuNames } from '../hooks/useBuNames';
import { displayFileName } from '../utils/displayFileName';
import AdminAnalytics from './AdminAnalytics';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  RadarChart, PolarGrid, PolarAngleAxis, Radar, Cell, ReferenceLine,
} from 'recharts';

async function exportToPdf(el: HTMLElement, filename: string) {
  const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);

  // Resolve CSS custom properties so html2canvas (which runs outside the cascade) sees real values
  const style = getComputedStyle(document.documentElement);
  const varMap: Record<string, string> = {};
  const CSS_VARS = [
    '--text', '--muted', '--panel', '--panel2', '--line', '--accent', '--accent-dark',
    '--accent-light', '--ok', '--warn', '--danger', '--chip', '--hover-bg',
    '--shadow', '--shadow-md', '--radius', '--radius2',
  ];
  CSS_VARS.forEach(v => { varMap[v] = style.getPropertyValue(v).trim(); });

  // Walk the subtree and replace var() references with computed values in inline styles & SVG attrs
  function patchNode(node: Element) {
    // Inline styles
    const inlineStyle = (node as HTMLElement).style;
    if (inlineStyle) {
      Array.from(inlineStyle).forEach(prop => {
        const val = inlineStyle.getPropertyValue(prop);
        if (val.includes('var(')) {
          const resolved = val.replace(/var\((--[\w-]+)\)/g, (_, v) => varMap[v] ?? getComputedStyle(node).getPropertyValue(v).trim());
          inlineStyle.setProperty(prop, resolved);
        }
      });
    }
    // SVG presentation attributes
    ['fill', 'stroke', 'color'].forEach(attr => {
      const val = node.getAttribute(attr);
      if (val && val.includes('var(')) {
        const resolved = val.replace(/var\((--[\w-]+)\)/g, (_, v) => varMap[v] ?? getComputedStyle(node).getPropertyValue(v).trim());
        node.setAttribute(attr, resolved);
      }
    });
    Array.from(node.children).forEach(patchNode);
  }

  // Clone so we don't mutate live DOM
  const clone = el.cloneNode(true) as HTMLElement;
  clone.style.cssText = `
    position: fixed; top: 0; left: 0;
    width: ${el.offsetWidth}px;
    background: #ffffff; color: #111;
    padding: 24px; box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    z-index: -9999; pointer-events: none;
  `;

  // Apply computed styles from the live root so CSS vars resolve inside clone too
  document.documentElement.style.setProperty('--text', varMap['--text'] || '#111');
  document.documentElement.style.setProperty('--muted', varMap['--muted'] || '#666');
  document.documentElement.style.setProperty('--panel', varMap['--panel'] || '#fff');
  document.documentElement.style.setProperty('--panel2', varMap['--panel2'] || '#f5f5f5');
  document.documentElement.style.setProperty('--line', varMap['--line'] || '#e0e0e0');

  patchNode(clone);
  document.body.appendChild(clone);

  try {
    const canvas = await html2canvas(clone, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
    });

    const imgData = canvas.toDataURL('image/png');
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 36;
    const contentW = pageW - margin * 2;
    const imgH = (canvas.height / canvas.width) * contentW;

    let yOffset = 0;
    while (yOffset < imgH) {
      if (yOffset > 0) pdf.addPage();
      pdf.addImage(
        imgData, 'PNG',
        margin,
        margin - yOffset,
        contentW,
        imgH,
      );
      // Clip: draw a white rectangle over the portion that bleeds beyond the page
      pdf.setFillColor(255, 255, 255);
      pdf.rect(0, pageH - margin, pageW, margin + 10, 'F');
      pdf.rect(0, 0, pageW, margin, 'F');
      yOffset += pageH - margin * 2;
    }

    pdf.save(filename);
  } finally {
    document.body.removeChild(clone);
  }
}

interface MaterialRiskRow {
  material_risk: string;
  avg_compliance_score: number | null;
  avg_validation_score: number | null;
  response_count: number;
}

interface ThematicAreaByBuRow {
  thematic_area: string;
  bu_code: string;
  avg_compliance_score: number | null;
  avg_validation_score: number | null;
  response_count: number;
}

interface CycleSummary {
  cycle_id: number;
  counts: {
    total_questions: number;
    total_submitted: number;
    total_validated: number;
    total_closed: number;
    total_closed_questions: number;
    total_validations: number;
    total_actioned: number;
    total_qa_rows: number;
    total_respondents: number;
  };
  scores_by_bcbs_principle: BcbsPrincipleRow[];
  scores_by_thematic_area: ThematicAreaRow[];
  scores_by_thematic_area_by_bu: ThematicAreaByBuRow[];
  scores_by_material_risk: MaterialRiskRow[];
  scores_by_bu: BURow[];
  validation_vs_compliance: ValidationRow[];
}

interface ThematicAreaRow {
  thematic_area: string;
  avg_compliance_score: number | null;
  consolidated_compliance_score: number | null;
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
  validated_count: number;
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

interface LollipopRow { label: string; dev: number }
function LollipopChart({ rows }: { rows: LollipopRow[] }) {
  const LABEL_W = 220;
  const HALF_W = 160;  // px for each side (positive / negative)
  const CENTRE = LABEL_W + HALF_W;
  const LABEL_R = 50;  // space for deviation label on the right
  const W = CENTRE + HALF_W + LABEL_R;
  const ROW_H = 38;
  const PAD_T = 28;
  const PAD_B = 16;
  const H = PAD_T + rows.length * ROW_H + PAD_B;
  const ALIGNED = 0.10;
  const maxDev = Math.max(...rows.map(r => Math.abs(r.dev)), 0.5);
  const toX = (dev: number) => CENTRE + (dev / maxDev) * HALF_W;
  const dotColor = (dev: number) =>
    Math.abs(dev) < ALIGNED ? '#b0b8c1' : dev > 0 ? '#e07b00' : '#007b85';

  // axis ticks: evenly spaced, always include 0
  const tickStep = maxDev <= 0.5 ? 0.25 : maxDev <= 1 ? 0.5 : 1;
  const ticks: number[] = [];
  for (let t = -maxDev; t <= maxDev + 0.001; t += tickStep) {
    ticks.push(Math.round(t * 100) / 100);
  }

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible' }}>
      {/* direction labels */}
      <text x={CENTRE - 8} y={14} textAnchor="end" fontSize={10} fill="#007b85" fontWeight={700}>◀ Validator higher</text>
      <text x={CENTRE + 8} y={14} textAnchor="start" fontSize={10} fill="#e07b00" fontWeight={700}>Respondent higher ▶</text>

      {/* tick grid lines + labels */}
      {ticks.map(t => {
        const x = toX(t);
        return (
          <g key={t}>
            <line x1={x} y1={PAD_T - 4} x2={x} y2={H - PAD_B}
              stroke={t === 0 ? '#999' : 'var(--line)'}
              strokeWidth={t === 0 ? 1.5 : 1}
              strokeDasharray={t === 0 ? undefined : '3 4'} />
            <text x={x} y={PAD_T - 6} textAnchor="middle" fontSize={9} fill="var(--muted)">
              {t === 0 ? '0' : (t > 0 ? '+' : '') + t.toFixed(2)}
            </text>
          </g>
        );
      })}

      {rows.map((r, i) => {
        const y = PAD_T + i * ROW_H + ROW_H / 2;
        const x0 = CENTRE;
        const x1 = toX(r.dev);
        const col = dotColor(r.dev);
        const isAligned = Math.abs(r.dev) < ALIGNED;
        const devLabel = r.dev === 0 ? '0.00' : (r.dev > 0 ? '+' : '') + r.dev.toFixed(2);

        return (
          <g key={r.label}>
            {i % 2 === 0 && (
              <rect x={0} y={y - ROW_H / 2} width={W} height={ROW_H}
                fill="var(--panel2)" fillOpacity={0.45} />
            )}

            {/* row label */}
            <text x={LABEL_W} y={y} textAnchor="end" fontSize={12}
              fill="var(--text)" fontWeight={500} dominantBaseline="middle">
              {r.label.length > 28 ? r.label.slice(0, 27) + '…' : r.label}
            </text>

            {/* stem from centre to dot */}
            <line x1={x0} y1={y} x2={x1} y2={y}
              stroke={col} strokeWidth={isAligned ? 1.5 : 2.5}
              strokeOpacity={isAligned ? 0.5 : 1}
              strokeDasharray={isAligned ? '4 3' : undefined} />

            {/* dot */}
            <circle cx={x1} cy={y} r={7} fill={col}
              stroke="var(--panel)" strokeWidth={1.5} />

            {/* deviation label */}
            <text x={CENTRE + HALF_W + 8} y={y} fontSize={11} fontWeight={700}
              fill={isAligned ? 'var(--muted)' : col} dominantBaseline="middle">
              {isAligned ? '≈ 0' : devLabel}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

type SlopeCategory = 'overconfident' | 'undervalued' | 'aligned';

interface SlopeRow {
  label: string;
  fullLabel: string;
  selfScore: number;
  validationScore: number;
  category: SlopeCategory;
  index: number;
}

const SLOPE_COLORS: Record<SlopeCategory, string> = {
  overconfident: '#e07b00',
  undervalued:   '#007b85',
  aligned:       '#b0b8c1',
};

function categorise(selfScore: number, validationScore: number): SlopeCategory {
  const gap = selfScore - validationScore;
  if (Math.abs(gap) <= 0.10) return 'aligned';
  if (gap <= 1) return 'undervalued';
  return 'overconfident';
}

function SlopeChart({ rows }: { rows: SlopeRow[] }) {
  const BADGE_W  = 20;
  const LABEL_W  = 210;
  const SCORE_W  = 160;
  const COL_PAD  = 24;
  const VAL_LBL  = 30;  // space for score label next to each dot
  const TAG_W    = 44;
  const W        = BADGE_W + LABEL_W + SCORE_W * 2 + TAG_W;
  const ROW_H    = 26;
  const PAD_T    = 36;
  const PAD_B    = 16;
  const H        = PAD_T + rows.length * ROW_H + PAD_B;

  const LEFT = BADGE_W + LABEL_W;
  const xSelf = (v: number) => LEFT + COL_PAD + ((v - 1) / 3) * (SCORE_W - COL_PAD * 2 - VAL_LBL);
  const xVal  = (v: number) => LEFT + SCORE_W + COL_PAD + ((v - 1) / 3) * (SCORE_W - COL_PAD * 2 - VAL_LBL);

  const TICKS = [1, 2, 3, 4];

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible' }}>
      {/* Column headers */}
      <text x={LEFT + SCORE_W / 2} y={14} textAnchor="middle" fontSize={7} fontWeight={700} fill="var(--muted)">Self Assessment</text>
      <text x={LEFT + SCORE_W + SCORE_W / 2} y={14} textAnchor="middle" fontSize={7} fontWeight={700} fill="var(--muted)">Validation Score</text>

      {/* Score axis ticks */}
      {TICKS.map(t => (
        <g key={t}>
          <text x={xSelf(t)} y={24} textAnchor="middle" fontSize={6} fill="var(--muted)">{t}</text>
          <line x1={xSelf(t)} y1={PAD_T - 4} x2={xSelf(t)} y2={H - PAD_B} stroke="var(--line)" strokeWidth={1} strokeDasharray="3 4" />
          <text x={xVal(t)} y={24} textAnchor="middle" fontSize={6} fill="var(--muted)">{t}</text>
          <line x1={xVal(t)} y1={PAD_T - 4} x2={xVal(t)} y2={H - PAD_B} stroke="var(--line)" strokeWidth={1} strokeDasharray="3 4" />
        </g>
      ))}

      {/* Vertical axis divider */}
      <line x1={LEFT + SCORE_W} y1={PAD_T - 4} x2={LEFT + SCORE_W} y2={H - PAD_B}
        stroke="var(--line)" strokeWidth={1} />

      {rows.map((r, i) => {
        const y   = PAD_T + i * ROW_H + ROW_H / 2;
        const x1  = xSelf(r.selfScore);
        const x2  = xVal(r.validationScore);
        const col = SLOPE_COLORS[r.category];
        const gap = r.selfScore - r.validationScore;
        const gapLabel = Math.abs(gap) <= 0.10 ? '≈ 0' : (gap > 0 ? '+' : '') + gap.toFixed(2);

        return (
          <g key={r.fullLabel}>
            {i % 2 === 0 && (
              <rect x={0} y={y - ROW_H / 2} width={W} height={ROW_H}
                fill="var(--panel2)" fillOpacity={0.45} />
            )}

            {/* Index badge */}
            <circle cx={10} cy={y} r={7} fill={col} stroke="var(--panel)" strokeWidth={1} />
            <text x={10} y={y} textAnchor="middle" dominantBaseline="central"
              fontSize={6} fontWeight={700} fill="#fff">
              {r.index}
            </text>

            {/* Row label */}
            <text x={BADGE_W + 4} y={y} textAnchor="start" fontSize={8}
              fill="var(--text)" fontWeight={500} dominantBaseline="middle">
              <title>{r.fullLabel}</title>
              {r.fullLabel.length > 30 ? r.fullLabel.slice(0, 29) + '…' : r.fullLabel}
            </text>

            {/* Connecting slope line */}
            <line x1={x1} y1={y} x2={x2} y2={y}
              stroke={col} strokeWidth={r.category === 'aligned' ? 1.5 : 2.5}
              strokeOpacity={r.category === 'aligned' ? 0.5 : 1}
              strokeDasharray={r.category === 'aligned' ? '4 3' : undefined} />

            {/* Self-score dot + value */}
            <circle cx={x1} cy={y} r={4} fill={col} stroke="var(--panel)" strokeWidth={1.5} />
            <text x={x1} y={y - 7} textAnchor="middle" fontSize={7} fontWeight={700} fill={col}>
              {r.selfScore.toFixed(2)}
            </text>

            {/* Validation-score dot + value */}
            <circle cx={x2} cy={y} r={4} fill={col} stroke="var(--panel)" strokeWidth={1.5} />
            <text x={x2} y={y - 7} textAnchor="middle" fontSize={7} fontWeight={700} fill={col}>
              {r.validationScore.toFixed(2)}
            </text>

            {/* Gap label */}
            <text x={LEFT + SCORE_W * 2 + 8} y={y} fontSize={7} fontWeight={700}
              fill={r.category === 'aligned' ? 'var(--muted)' : col} dominantBaseline="middle">
              {gapLabel}
            </text>
          </g>
        );
      })}
    </svg>
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
  const [bcbsRows, setBcbsRows] = useState<CycleSummary['scores_by_bcbs_principle'] | null>(null);
  const [loadingCycles, setLoadingCycles] = useState(true);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adminTab, setAdminTab] = useState<'analytics' | 'audit'>('analytics');
  const [deviationView, setDeviationView] = useState<'bars' | 'grouped'>('bars');
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
  const [exporting, setExporting] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);
  const auditTableRef = useRef<HTMLDivElement>(null);
  const [auditTableTop, setAuditTableTop] = useState<number | null>(null);

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
    setBcbsRows(null);
    setThematicBuFilter('all');
    setError(null);
    setDeviationView(c => {
      const cycle = cycles.find(x => x.id === cycleId);
      return cycle?.status === 'closed' ? 'grouped' : 'bars';
    });
    try {
      const data = await api.get<CycleSummary>(`/reporting/cycle/${cycleId}/summary`);
      setSummary(data);
      setThematicRows(data.scores_by_thematic_area);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load report');
    } finally {
      setLoadingSummary(false);
    }
  }, [cycles]);

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
      .then(data => {
        if (!cancelled) {
          setThematicRows(data.scores_by_thematic_area);
          setBcbsRows(data.scores_by_bcbs_principle);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [thematicBuFilter, selectedCycleId]);

  const selectedCycle = cycles.find(c => c.id === selectedCycleId);
  const buName = useBuNames();

  const handleExportPdf = useCallback(async () => {
    if (!reportRef.current || !selectedCycle) return;
    setExporting(true);
    try {
      const filename = `CCL_Report_${selectedCycle.name.replace(/\s+/g, '_')}_${selectedCycle.year}.pdf`;
      await exportToPdf(reportRef.current, filename);
    } finally {
      setExporting(false);
    }
  }, [selectedCycle]);

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

  useEffect(() => {
    if (adminTab !== 'audit') return;
    const measure = () => {
      if (auditTableRef.current) {
        setAuditTableTop(auditTableRef.current.getBoundingClientRect().top);
      }
    };
    // Measure after the tab renders
    const id = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    return () => { cancelAnimationFrame(id); window.removeEventListener('resize', measure); };
  }, [adminTab]);

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

  // ── Validator / Senior Validator — own cycle-card picker layout ─────────────
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

  const submittedBus = summary?.scores_by_bu.filter(bu => bu.submitted_count > 0) ?? [];

  const submissionPct = summary
    ? Math.round((summary.counts.total_submitted / Math.max(summary.counts.total_questions, 1)) * 100)
    : 0;

  const validationPct = (() => {
    if (!summary) return 0;
    const total = summary.counts.total_questions ?? 0;
    if (total === 0) return 0;
    return Math.min(100, Math.round((summary.counts.total_validated / total) * 100));
  })();

  const barChartData = (bcbsRows ?? summary?.scores_by_bcbs_principle ?? []).map(row => ({
    name: row.bcbs_principle_name?.trim() ?? '—',
    'Respondent Assessment': row.avg_compliance_score !== null ? Number(Number(row.avg_compliance_score).toFixed(2)) : 0,
    'Validation': row.avg_validation_score !== null ? Number(Number(row.avg_validation_score).toFixed(2)) : 0,
  }));

  const handleBuFilterChange = (buCode: string) => {
    if (buCode === 'all') {
      setThematicBuFilter('all');
      setBcbsRows(null);
      if (summary) setThematicRows(summary.scores_by_thematic_area);
    } else {
      setThematicBuFilter(buCode);
    }
  };

  const radarRows = (thematicRows ?? summary?.scores_by_thematic_area ?? [])
    .filter(r => r.avg_validation_score !== null);
  const radarData = radarRows.map((row, i) => ({
    area: String(i + 1),
    fullArea: row.thematic_area.replace(/^\d+\.\s*/, '').trim(),
    score: Number(Number(row.avg_validation_score).toFixed(2)),
    fullMark: 4,
  }));

  return (
    <div ref={reportRef}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 16, flexWrap: 'wrap' }}>
        <div>
          {!embedded && <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.3px' }}>Reports</div>}
          {selectedCycle && (
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {!embedded && currentUser?.role !== 'Admin' && (
            <>
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
            </>
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
          {selectedCycle?.checklist_file && (
            <button
              className="btn"
              onClick={() => {
                const userId = getCurrentUserId();
                const headers: Record<string, string> = {};
                if (userId) headers['X-User-Id'] = userId;
                fetch(`/api/cycles/${selectedCycle.id}/checklist`, { headers })
                  .then(r => r.blob())
                  .then(blob => {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = selectedCycle.checklist_original_name ?? `${selectedCycle.name}_checklist.xlsx`;
                    a.click();
                    URL.revokeObjectURL(url);
                  });
              }}
              title="Download compliance checklist"
              style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
              </svg>
              Checklist
            </button>
          )}
          {summary && (
            <button
              className="btn"
              onClick={handleExportPdf}
              disabled={exporting}
              title="Export visible report to PDF"
              style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              {exporting ? 'Exporting…' : 'Export PDF'}
            </button>
          )}
        </div>
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
          {/* ── Completion overview (non-Admin only) ── */}
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
                  sublabel={`${summary.counts.total_validated} / ${summary.counts.total_questions} questions`}
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
                  { label: 'Closed', value: summary.counts.total_closed_questions, color: 'var(--ok)', icon: '✅' },
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
          {selectedCycle?.status === 'closed' && (
            <div style={{
              padding: '10px 16px', marginBottom: 20,
              background: 'var(--panel)', border: '1px solid var(--line)',
              borderRadius: 'var(--radius2)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            }}>
              <span className="small" style={{ fontWeight: 600, color: 'var(--muted)', whiteSpace: 'nowrap' }}>Score scale:</span>
              <ScoreLegend />
            </div>
          )}

          {/* ── Shared BU filter bar ── */}
          {selectedCycle?.status === 'closed' && submittedBus.length > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 16px', marginBottom: 16,
              background: 'var(--panel)', border: '1px solid var(--line)',
              borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow)',
            }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', whiteSpace: 'nowrap' }}>🏢 Filter by Respondent</span>
              <select
                value={thematicBuFilter}
                onChange={e => handleBuFilterChange(e.target.value)}
                style={{ fontWeight: 500, fontSize: 13, minWidth: 220 }}
              >
                <option value="all">All respondents</option>
                {submittedBus.map(bu => (
                  <option key={bu.bu_code} value={bu.bu_code}>{buName(bu.bu_code)}</option>
                ))}
              </select>
              {thematicBuFilter !== 'all' && (
                <button
                  className="btn"
                  onClick={() => handleBuFilterChange('all')}
                  style={{ fontSize: 12, padding: '3px 10px' }}
                >
                  ✕ Clear
                </button>
              )}
              <span className="small" style={{ marginLeft: 'auto', color: 'var(--muted)' }}>
                Applies to all 3 charts below
              </span>
            </div>
          )}

          {/* ── Deviation: Compliance vs Validation ── */}
          {selectedCycle?.status === 'closed' && (() => {
            const thematicSource = thematicRows ?? summary.scores_by_thematic_area;
            const deviationRows = thematicSource
              .filter(r => r.avg_compliance_score !== null && r.avg_validation_score !== null)
              .map(r => ({
                label: r.thematic_area.replace(/^\d+\.\s*/, '').trim(),
                fullLabel: r.thematic_area.trim(),
                dev: Number((r.avg_compliance_score! - r.avg_validation_score!).toFixed(2)),
              }));

            const buDeviationRows = summary.scores_by_bu
              .filter(b => b.avg_compliance_score !== null && b.avg_validation_score !== null)
              .map(b => ({
                bu_code: b.bu_code,
                dev: Number((b.avg_compliance_score! - b.avg_validation_score!).toFixed(2)),
              }))
              .sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev));

            const maxDev = Math.max(...[...deviationRows.map(r => Math.abs(r.dev)), ...buDeviationRows.map(r => Math.abs(r.dev))], 0.5);
            const scale = maxDev > 0 ? 48 / maxDev : 48; // px per unit, half-bar max = 48px

            function DeviationBar({ dev }: { dev: number }) {
              const px = Math.round(Math.min(Math.abs(dev) * scale, 48));
              const isPos = dev >= 0;
              const color = Math.abs(dev) < 0.05 ? 'var(--muted)' : isPos ? '#e07b00' : '#007b85';
              const label = dev === 0 ? '0.00' : (dev > 0 ? '+' : '') + dev.toFixed(2);
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 22 }}>
                  {/* left (negative) half */}
                  <div style={{ width: 48, display: 'flex', justifyContent: 'flex-end' }}>
                    {!isPos && px > 0 && (
                      <div style={{ width: px, height: 10, background: color, borderRadius: '3px 0 0 3px' }} />
                    )}
                  </div>
                  {/* centre spine */}
                  <div style={{ width: 2, height: 16, background: 'var(--line)', flexShrink: 0 }} />
                  {/* right (positive) half */}
                  <div style={{ width: 48 }}>
                    {isPos && px > 0 && (
                      <div style={{ width: px, height: 10, background: color, borderRadius: '0 3px 3px 0' }} />
                    )}
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, color, minWidth: 36 }}>{label}</span>
                </div>
              );
            }

            if (deviationRows.length === 0) return null;

            return (
              <>
              {selectedCycle?.status !== 'closed' && <div style={{ marginBottom: 16 }}>
                <div style={{
                  background: 'var(--panel)', border: '1px solid var(--line)',
                  borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow)', overflow: 'hidden',
                }}>
                  {/* Header */}
                  <div style={{
                    padding: '12px 20px', borderBottom: '1px solid var(--line)',
                    background: 'var(--panel2)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                  }}>
                    <span style={{ fontSize: 15 }}>↔️</span>
                    <strong style={{ fontSize: 13 }}>Compliance vs Validation Deviation by Thematic Area</strong>
                    {thematicBuFilter !== 'all' && (
                      <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{buName(thematicBuFilter)}</span>
                    )}
                    <span className="small" style={{ color: 'var(--muted)' }}>
                      Positive = respondent self-score higher than validation · Negative = validator scored higher
                    </span>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--line)' }}>
                      {(['bars', 'grouped'] as const).map(v => (
                        <button
                          key={v}
                          onClick={() => setDeviationView(v)}
                          style={{
                            padding: '3px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none',
                            background: deviationView === v ? 'var(--accent)' : 'var(--panel)',
                            color: deviationView === v ? '#fff' : 'var(--muted)',
                            transition: 'background 0.15s',
                          }}
                        >
                          {v === 'bars' ? 'Deviation bars' : 'Grouped scores'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {deviationView === 'bars' ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 0 }}>
                    {/* Left: thematic area table */}
                    <div style={{ overflowX: 'auto' }}>
                      <table className="table" style={{ marginBottom: 0 }}>
                        <thead>
                          <tr>
                            <th>Thematic Area</th>
                            <th style={{ width: 140, textAlign: 'center' }}>
                              <span style={{ color: '#007b85' }}>◀</span>
                              {' Validator higher '}
                              <span style={{ color: '#e07b00' }}>▶</span>
                              {' Respondent higher'}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {deviationRows.map(row => (
                            <tr key={row.fullLabel} title={row.fullLabel}>
                              <td style={{ fontSize: 13, fontWeight: 500, maxWidth: 320, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {row.fullLabel}
                              </td>
                              <td style={{ paddingTop: 6, paddingBottom: 6 }}>
                                <DeviationBar dev={row.dev} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Right: per-BU ranking (only when showing all respondents) */}
                    {thematicBuFilter === 'all' && buDeviationRows.length > 0 && (
                      <div style={{ borderLeft: '1px solid var(--line)', minWidth: 260 }}>
                        <table className="table" style={{ marginBottom: 0 }}>
                          <thead>
                            <tr>
                              <th>Respondent</th>
                              <th style={{ width: 140, textAlign: 'center' }}>Overall Deviation</th>
                            </tr>
                          </thead>
                          <tbody>
                            {buDeviationRows.map(b => (
                              <tr key={b.bu_code}>
                                <td style={{ fontSize: 12, fontWeight: 600 }}>
                                  <span style={{
                                    display: 'inline-block', padding: '1px 6px',
                                    borderRadius: 3, background: 'var(--chip)',
                                    fontFamily: 'monospace', fontSize: 11,
                                    border: '1px solid var(--line)',
                                  }}>{b.bu_code}</span>
                                  {' '}
                                  <span style={{ fontFamily: 'inherit', fontSize: 12, color: 'var(--muted)' }}>{buName(b.bu_code)}</span>
                                </td>
                                <td style={{ paddingTop: 6, paddingBottom: 6 }}>
                                  <DeviationBar dev={b.dev} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                  ) : (
                  /* ── Grouped bar chart view ── */
                  (() => {
                    const groupedData = (thematicRows ?? summary.scores_by_thematic_area)
                      .filter(r => r.avg_compliance_score !== null || r.avg_validation_score !== null)
                      .map(r => ({
                        name: r.thematic_area.replace(/^\d+\.\s*/, '').trim(),
                        fullName: r.thematic_area.trim(),
                        compliance: r.avg_compliance_score !== null ? Number(r.avg_compliance_score.toFixed(2)) : undefined,
                        validation: r.avg_validation_score !== null ? Number(r.avg_validation_score.toFixed(2)) : undefined,
                      }));
                    return (
                      <div style={{ padding: '16px 16px 8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ width: 12, height: 12, borderRadius: 2, background: '#e07b00' }} />
                            <span style={{ fontSize: 12, color: 'var(--muted)' }}>Compliance (self-score)</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ width: 12, height: 12, borderRadius: 2, background: '#007b85' }} />
                            <span style={{ fontSize: 12, color: 'var(--muted)' }}>Validation score</span>
                          </div>
                        </div>
                        <ResponsiveContainer width="100%" height={Math.max(280, groupedData.length * 52)}>
                          <BarChart
                            data={groupedData}
                            layout="vertical"
                            margin={{ top: 4, right: 52, left: 8, bottom: 4 }}
                            barGap={3}
                            barCategoryGap="28%"
                          >
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={false} />
                            <XAxis
                              type="number"
                              domain={[0, 4]}
                              ticks={[1, 2, 3, 4]}
                              tick={{ fontSize: 11, fill: 'var(--muted)' }}
                              axisLine={{ stroke: 'var(--line)' }}
                              tickLine={false}
                            />
                            <YAxis
                              type="category"
                              dataKey="name"
                              width={200}
                              tickFormatter={(v: string) => v.length > 30 ? v.slice(0, 29) + '…' : v}
                              tick={{ fontSize: 12, fill: 'var(--text)', fontWeight: 500 }}
                              axisLine={false}
                              tickLine={false}
                            />
                            <Tooltip
                              contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--shadow-md)' }}
                              labelStyle={{ fontWeight: 700, marginBottom: 4 }}
                              cursor={{ fill: 'var(--hover-bg)' }}
                              formatter={(val: number, name: string) => [
                                val.toFixed(2),
                                name === 'compliance' ? 'Compliance (self-score)' : 'Validation score',
                              ]}
                              labelFormatter={(_label: any, payload: any[]) =>
                                payload?.[0]?.payload?.fullName ?? String(_label)
                              }
                            />
                            <Bar dataKey="compliance" fill="#e07b00" radius={[0, 3, 3, 0]} maxBarSize={14} />
                            <Bar dataKey="validation" fill="#007b85" radius={[0, 3, 3, 0]} maxBarSize={14} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    );
                  })()
                  )}
                </div>
              </div>}

              {/* ── Score Deviation: quadrant scatter (closed) or lollipop (active) ── */}
              {(() => {
                const source = thematicRows ?? summary.scores_by_thematic_area;
                const isClosed = selectedCycle?.status === 'closed';

                if (isClosed) {
                  /* ── Slope chart for closed cycles ── */
                  const slopeRows: SlopeRow[] = source
                    .filter(r => (r.consolidated_compliance_score ?? r.avg_compliance_score) !== null && r.avg_validation_score !== null)
                    .map((r, i) => {
                      const self = Number((r.consolidated_compliance_score ?? r.avg_compliance_score)!.toFixed(2));
                      const val  = Number(r.avg_validation_score!.toFixed(2));
                      return {
                        label: r.thematic_area.replace(/^\d+\.\s*/, '').trim(),
                        fullLabel: r.thematic_area.trim(),
                        selfScore: self,
                        validationScore: val,
                        category: categorise(self, val),
                        index: i + 1,
                      };
                    });
                  if (slopeRows.length === 0) return null;

                  const quadrantCounts = {
                    overconfident: slopeRows.filter(d => d.category === 'overconfident').length,
                    undervalued:   slopeRows.filter(d => d.category === 'undervalued').length,
                  };

                  const avgSelf = slopeRows.reduce((s, r) => s + r.selfScore, 0) / slopeRows.length;
                  const avgVal  = slopeRows.reduce((s, r) => s + r.validationScore, 0) / slopeRows.length;
                  const avgGap  = avgSelf - avgVal;

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
                        <span style={{ fontSize: 15 }}>🎯</span>
                        <strong style={{ fontSize: 13 }}>Consolidated Score Deviation by Thematic Area</strong>
                        {thematicBuFilter !== 'all' && (
                          <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{buName(thematicBuFilter)}</span>
                        )}
                        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                          {([
                            { cat: 'overconfident' as SlopeCategory, label: 'Overconfident' },
                            { cat: 'undervalued'   as SlopeCategory, label: 'Undervalued (gap ≤ 1)' },
                            { cat: 'aligned'       as SlopeCategory, label: 'Aligned (±0.10)' },
                          ] as const).map(({ cat, label }) => (
                            <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <div style={{ width: 10, height: 10, borderRadius: '50%', background: SLOPE_COLORS[cat] }} />
                              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Category summary pills */}
                      <div style={{
                        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
                        borderBottom: '1px solid var(--line)',
                      }}>
                        {[
                          { label: 'Overconfident', sub: 'Self − Validation > 1', count: quadrantCounts.overconfident, color: SLOPE_COLORS.overconfident, bg: 'rgba(224,123,0,.07)' },
                          { label: 'Undervalued',   sub: 'Self − Validation ≤ 1', count: quadrantCounts.undervalued,   color: SLOPE_COLORS.undervalued,   bg: 'rgba(0,123,133,.07)' },
                        ].map(({ label, sub, count, color, bg }) => (
                          <div key={label} style={{
                            padding: '10px 16px', background: bg,
                            borderRight: '1px solid var(--line)', textAlign: 'center',
                          }}>
                            <div style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1 }}>{count}</div>
                            <div style={{ fontSize: 11, fontWeight: 600, color, marginTop: 2 }}>{label}</div>
                            <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>
                          </div>
                        ))}
                        {/* Avg scores + total gap */}
                        <div style={{
                          padding: '10px 16px', textAlign: 'center',
                          background: 'var(--panel2)',
                          display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4,
                        }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                            Portfolio Avg
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
                            <div style={{ textAlign: 'center' }}>
                              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', lineHeight: 1 }}>{avgSelf.toFixed(2)}</div>
                              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>Self</div>
                            </div>
                            <div style={{ width: 1, background: 'var(--line)', alignSelf: 'stretch' }} />
                            <div style={{ textAlign: 'center' }}>
                              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', lineHeight: 1 }}>{avgVal.toFixed(2)}</div>
                              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>Validation</div>
                            </div>
                          </div>
                          <div style={{
                            fontSize: 13, fontWeight: 700, marginTop: 2,
                            color: Math.abs(avgGap) <= 0.10 ? 'var(--muted)' : avgGap > 0 ? SLOPE_COLORS.overconfident : SLOPE_COLORS.undervalued,
                          }}>
                            {Math.abs(avgGap) <= 0.10 ? '≈ 0' : (avgGap > 0 ? '+' : '') + avgGap.toFixed(2)} gap
                          </div>
                        </div>
                      </div>

                      {/* Slope chart */}
                      <div style={{ padding: '16px 24px 8px', overflowX: 'auto' }}>
                        <SlopeChart rows={slopeRows} />
                      </div>

                      {/* Footer note */}
                      <div style={{ padding: '4px 20px 12px', fontSize: 10, color: 'var(--muted)' }}>
                        Left column = Self Assessment score · Right column = Validation score · Gap label = Self − Validation · Line slope and colour indicate direction and category.
                      </div>

                      {/* ── Material Risk compact table ── */}
                      {(() => {
                        const mrRows = summary.scores_by_material_risk ?? [];
                        if (mrRows.length === 0) return null;
                        const RISK_PALETTE: Record<string, { accent: string; bg: string }> = {
                          'Market Risk':      { accent: '#e07b00', bg: 'rgba(224,123,0,.05)'  },
                          'Liquidity Risk':   { accent: '#007b85', bg: 'rgba(0,123,133,.05)'  },
                          'IRRBB Risk':       { accent: '#5a3ea1', bg: 'rgba(90,62,161,.05)'  },
                          'Credit Risk':      { accent: '#c0392b', bg: 'rgba(192,57,43,.05)'  },
                          'Operational Risk': { accent: '#2980b9', bg: 'rgba(41,128,185,.05)' },
                          'Strategic Risk':   { accent: '#27ae60', bg: 'rgba(39,174,96,.05)'  },
                        };
                        const FALLBACK = ['#c0392b', '#28a745', '#2980b9', '#8e44ad'];
                        const riskPalette = (risk: string, idx: number) =>
                          RISK_PALETTE[risk] ?? { accent: FALLBACK[idx % FALLBACK.length], bg: `${FALLBACK[idx % FALLBACK.length]}0d` };

                        const overallMrComp = (() => {
                          const vals = mrRows.map(r => r.avg_compliance_score).filter((v): v is number => v !== null);
                          return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
                        })();
                        const overallMrVal = (() => {
                          const vals = mrRows.map(r => r.avg_validation_score).filter((v): v is number => v !== null);
                          return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
                        })();

                        const InlineScore = ({ value, accent }: { value: number | null; accent: string }) => {
                          if (value === null) return <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>;
                          const col = scoreColor(Math.round(value));
                          const pct = ((value - 1) / 3) * 100;
                          return (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: 13, fontWeight: 700, color: col, minWidth: 34 }}>{value.toFixed(2)}</span>
                              <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--line)', overflow: 'hidden', minWidth: 60 }}>
                                <div style={{ height: '100%', width: `${pct}%`, background: accent, borderRadius: 3 }} />
                              </div>
                              <span style={{ fontSize: 10, color: col, fontWeight: 600, minWidth: 72 }}>{SCORE_LABELS[Math.round(value)] ?? ''}</span>
                            </div>
                          );
                        };

                        const th: React.CSSProperties = {
                          padding: '7px 14px', fontSize: 10, fontWeight: 700,
                          color: 'var(--muted)', textTransform: 'uppercase',
                          letterSpacing: '.05em', borderBottom: '2px solid var(--line)',
                          background: 'var(--panel2)', textAlign: 'left',
                        };

                        return (
                          <div style={{ borderTop: '2px solid var(--line)' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                              <thead>
                                <tr>
                                  <th style={{ ...th, width: 160 }}>Material Risk</th>
                                  <th style={{ ...th }}>Self Assessment</th>
                                  <th style={{ ...th }}>Validation</th>
                                  <th style={{ ...th, width: 110 }}>Gap</th>
                                </tr>
                              </thead>
                              <tbody>
                                {mrRows.map((r, i) => {
                                  const p = riskPalette(r.material_risk, i);
                                  const gap = r.avg_compliance_score !== null && r.avg_validation_score !== null
                                    ? r.avg_compliance_score - r.avg_validation_score : null;
                                  const gapColor = gap === null || Math.abs(gap) <= 0.10 ? 'var(--muted)'
                                    : gap > 0 ? '#e07b00' : '#007b85';
                                  const gapLabel = gap === null ? '—'
                                    : Math.abs(gap) <= 0.10 ? '≈ aligned'
                                    : (gap > 0 ? '+' : '') + gap.toFixed(2);
                                  return (
                                    <tr key={r.material_risk} style={{ background: p.bg, borderBottom: '1px solid var(--line)' }}>
                                      <td style={{ padding: '9px 14px', borderLeft: `4px solid ${p.accent}` }}>
                                        <span style={{ fontSize: 12, fontWeight: 700, color: p.accent }}>{r.material_risk}</span>
                                      </td>
                                      <td style={{ padding: '9px 14px' }}>
                                        <InlineScore value={r.avg_compliance_score} accent={p.accent} />
                                      </td>
                                      <td style={{ padding: '9px 14px' }}>
                                        <InlineScore value={r.avg_validation_score} accent={p.accent} />
                                      </td>
                                      <td style={{ padding: '9px 14px' }}>
                                        <span style={{
                                          fontSize: 11, fontWeight: 700, color: gapColor,
                                          background: `${gapColor}15`, border: `1px solid ${gapColor}40`,
                                          borderRadius: 20, padding: '2px 9px', whiteSpace: 'nowrap',
                                        }}>
                                          {gapLabel}
                                        </span>
                                      </td>
                                    </tr>
                                  );
                                })}
                                {/* Portfolio average footer row */}
                                <tr style={{ background: 'var(--panel2)', borderTop: '2px solid var(--line)' }}>
                                  <td style={{ padding: '9px 14px', borderLeft: '4px solid var(--line)' }}>
                                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Portfolio Avg</span>
                                  </td>
                                  <td style={{ padding: '9px 14px' }}>
                                    <InlineScore value={overallMrComp} accent="var(--muted)" />
                                  </td>
                                  <td style={{ padding: '9px 14px' }}>
                                    <InlineScore value={overallMrVal} accent="var(--muted)" />
                                  </td>
                                  <td />
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        );
                      })()}
                    </div>
                  );
                }

                /* ── Lollipop for non-closed cycles ── */
                const lollipopRows: LollipopRow[] = source
                  .filter(r => r.avg_compliance_score !== null && r.avg_validation_score !== null)
                  .map(r => ({
                    label: r.thematic_area.replace(/^\d+\.\s*/, '').trim(),
                    dev: Number((r.avg_compliance_score! - r.avg_validation_score!).toFixed(2)),
                  }));
                if (lollipopRows.length === 0) return null;
                return (
                  <div style={{
                    background: 'var(--panel)', border: '1px solid var(--line)',
                    borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow)',
                    marginBottom: 20, overflow: 'hidden',
                  }}>
                    <div style={{
                      padding: '12px 20px', borderBottom: '1px solid var(--line)',
                      background: 'var(--panel2)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                    }}>
                      <span style={{ fontSize: 15 }}>↔️</span>
                      <strong style={{ fontSize: 13 }}>Score Deviation by Thematic Area</strong>
                      {thematicBuFilter !== 'all' && (
                        <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{buName(thematicBuFilter)}</span>
                      )}
                      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#e07b00' }} />
                          <span style={{ fontSize: 11, color: 'var(--muted)' }}>Respondent higher</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#007b85' }} />
                          <span style={{ fontSize: 11, color: 'var(--muted)' }}>Validator higher</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#b0b8c1' }} />
                          <span style={{ fontSize: 11, color: 'var(--muted)' }}>Aligned (±0.10)</span>
                        </div>
                      </div>
                    </div>
                    <div style={{ padding: '16px 24px 20px', overflowX: 'auto' }}>
                      <LollipopChart rows={lollipopRows} />
                    </div>
                    <div style={{
                      padding: '8px 20px', borderTop: '1px solid var(--line)',
                      background: 'var(--panel2)', fontSize: 11, color: 'var(--muted)',
                    }}>
                      Deviation = Respondent self-score − Validator score. Dots to the right mean the respondent assessed higher than the validator.
                    </div>
                  </div>
                );
              })()}
              </>
            );
          })()}

          {/* ── Summary of Consolidated Scores by Thematic Area ── */}
          {selectedCycle?.status === 'closed' && (() => {
            const rows = thematicRows ?? summary.scores_by_thematic_area;
            const compValues = rows.map(r => r.consolidated_compliance_score ?? r.avg_compliance_score).filter((v): v is number => v !== null);
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
                  <strong style={{ fontSize: 13 }}>Summary of Consolidated Scores by Thematic Area</strong>
                  {thematicBuFilter !== 'all' && (
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>
                      {buName(thematicBuFilter)}
                    </span>
                  )}
                </div>
                {/* Thematic area table */}
                <div style={{ overflow: 'auto' }}>
                    <table className="table" style={{ marginBottom: 0 }}>
                      <thead>
                        <tr>
                          <th>Thematic Area</th>
                          <th style={{ textAlign: 'right', width: 80 }}>Questions</th>
                          <th style={{ width: 220 }}>Self Assessment</th>
                          <th style={{ width: 220 }}>Validation</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.length === 0 && (
                          <tr><td colSpan={4} className="small" style={{ textAlign: 'center', padding: 32 }}>No data yet.</td></tr>
                        )}
                        {rows.map(row => {
                          const compScore = row.consolidated_compliance_score ?? row.avg_compliance_score;
                          const rowBg = compScore !== null ? `${scoreColor(compScore)}08` : undefined;
                          return (
                            <tr key={row.thematic_area} style={{ background: rowBg }}>
                              <td style={{ fontWeight: 500, fontSize: 13 }}>{row.thematic_area.trim()}</td>
                              <td style={{ textAlign: 'right', color: 'var(--muted)', fontSize: 13 }}>{row.response_count}</td>
                              <td><ScoreBar value={compScore} /></td>
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
                            <td style={{ fontWeight: 700, fontSize: 13 }}>Consolidated Average</td>
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
              </div>
            );
          })()}

          {/* ── Charts row ── */}
          <div style={{ display: 'grid', gridTemplateColumns: radarData.length > 2 ? '1fr 1fr' : '1fr', gap: 16, marginBottom: 20 }}>
            {/* Bar chart — BCBS 239 Principle (closed cycles only) */}
            {barChartData.length > 0 && selectedCycle?.status === 'closed' && (
              <div style={{
                background: 'var(--panel)', border: '1px solid var(--line)',
                borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow)', overflow: 'hidden',
              }}>
                <div style={{
                  padding: '12px 20px', borderBottom: '1px solid var(--line)',
                  background: 'var(--panel2)', display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <span style={{ fontSize: 15 }}>📊</span>
                  <strong style={{ fontSize: 13 }}>Average Scores by BCBS 239 Principle</strong>
                  <span className="small" style={{ color: 'var(--muted)' }}>Scale 1–4</span>
                  {thematicBuFilter !== 'all' && (
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>
                      {buName(thematicBuFilter)}
                    </span>
                  )}
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
                      <Bar dataKey="Respondent Assessment" fill="var(--accent)" radius={[0, 4, 4, 0]} />
                      <Bar dataKey="Validation" fill="var(--ok)" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Radar chart — compliance profile */}
            {radarData.length > 2 && (
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
                  {thematicBuFilter !== 'all' && (
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>
                      {buName(thematicBuFilter)}
                    </span>
                  )}
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

          {/* ── Scores by BU (non-Admin only) ── */}
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
              <strong style={{ fontSize: 13 }}>
                {selectedCycle?.status === 'closed' ? 'Business-RDARR Validation: Assessment Alignment' : 'Respondent-RDARR Validation: Assessment Alignment'}
              </strong>
              <span className="small" style={{ marginLeft: 'auto' }}>{summary.scores_by_bu.length} Respondents</span>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Respondent</th>
                  {selectedCycle?.status === 'closed' ? (
                    <>
                      <th style={{ width: 220 }}>Avg Self Assessment Score</th>
                      <th style={{ width: 220 }}>Avg Consolidated Validation</th>
                    </>
                  ) : (
                    <>
                      <th style={{ width: 200 }}>Submission Progress</th>
                      <th style={{ width: 100, textAlign: 'right' }}>Submitted</th>
                      <th style={{ width: 200 }}>Validation Progress</th>
                      <th style={{ width: 100, textAlign: 'right' }}>In Validation</th>
                      <th style={{ width: 110, textAlign: 'center' }}>Status</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {summary.scores_by_bu.length === 0 && (
                  <tr><td colSpan={selectedCycle?.status === 'closed' ? 3 : 6} className="small" style={{ textAlign: 'center', padding: 32 }}>No data yet.</td></tr>
                )}
                {(() => {
                  // Merge 006 + 956 into one Finance Reporting row.
                  // If the DB returns them as separate codes, merge them.
                  // If the DB already returns a combined '006-956' row, use it directly (renamed to '006').
                  const FINANCE_CODES = new Set(['006', '956']);
                  const separateFinanceRows = summary.scores_by_bu.filter(r => FINANCE_CODES.has(r.bu_code));
                  const combinedFinanceRow  = summary.scores_by_bu.find(r => r.bu_code === '006-956');
                  const financeRows = separateFinanceRows.length > 0 ? separateFinanceRows : (combinedFinanceRow ? [combinedFinanceRow] : []);
                  const mergedFinance: BURow | null = financeRows.length > 0 ? (() => {
                    const totalResp = financeRows.reduce((s, r) => s + r.response_count, 0);
                    const totalSub  = financeRows.reduce((s, r) => s + r.submitted_count, 0);
                    const totalVal  = financeRows.reduce((s, r) => s + r.validated_count, 0);
                    const wAvgComp = financeRows.every(r => r.avg_compliance_score === null) ? null
                      : financeRows.reduce((s, r) => s + (r.avg_compliance_score ?? 0) * r.submitted_count, 0) / Math.max(totalSub, 1);
                    const wAvgVal  = financeRows.every(r => r.avg_validation_score === null) ? null
                      : financeRows.reduce((s, r) => s + (r.avg_validation_score ?? 0) * r.response_count, 0) / Math.max(totalResp, 1);
                    return { bu_code: '006', avg_compliance_score: wAvgComp, avg_validation_score: wAvgVal, response_count: totalResp, submitted_count: totalSub, validated_count: totalVal };
                  })() : null;
                  const displayRows: BURow[] = [
                    ...summary.scores_by_bu.filter(r => !FINANCE_CODES.has(r.bu_code) && r.bu_code !== '006-956'),
                    ...(mergedFinance ? [mergedFinance] : []),
                  ].sort((a, b) => a.bu_code.localeCompare(b.bu_code));

                  return displayRows.map(row => {
                    const subPct = row.response_count > 0
                      ? Math.round((row.submitted_count / row.response_count) * 100)
                      : 0;
                    const valPct = row.response_count > 0
                      ? Math.round((row.validated_count / row.response_count) * 100)
                      : 0;
                    const allSubmitted = subPct === 100 && row.response_count > 0;
                    const allValidated = valPct === 100 && row.response_count > 0;

                    const statusBadge = (() => {
                      if (allValidated) return { label: '✓ Validated', bg: 'rgba(40,167,69,.12)', color: 'var(--ok)' };
                      if (row.validated_count > 0) return { label: 'In Validation', bg: 'rgba(0,123,133,.10)', color: 'var(--accent)' };
                      if (allSubmitted) return { label: '✓ Submitted', bg: 'rgba(40,167,69,.08)', color: 'var(--ok)' };
                      if (row.submitted_count > 0) return { label: 'In Progress', bg: 'rgba(255,193,7,.12)', color: '#856404' };
                      return { label: 'Pending', bg: 'transparent', color: 'var(--muted)' };
                    })();

                    const ProgressBar = ({ pct, color }: { pct: number; color: string }) => (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1, height: 7, background: 'var(--line)', borderRadius: 4, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 4, transition: 'width .4s ease' }} />
                        </div>
                        <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{pct}%</span>
                      </div>
                    );

                    return (
                      <tr key={row.bu_code}>
                        <td>
                          <span style={{
                            display: 'inline-block', padding: '2px 8px',
                            borderRadius: 4, background: 'var(--chip)',
                            fontFamily: 'monospace', fontSize: 12, fontWeight: 700,
                            border: '1px solid var(--line)', color: 'var(--text)',
                          }}>
                            {row.bu_code === '006' ? 'Finance Reporting (006-956)' : buName(row.bu_code)}
                          </span>
                        </td>
                        {selectedCycle?.status === 'closed' ? (
                          <>
                            <td><ScoreBar value={row.avg_compliance_score} /></td>
                            <td><ScoreBar value={row.avg_validation_score} /></td>
                          </>
                        ) : (
                          <>
                            <td><ProgressBar pct={subPct} color={completionColor(subPct)} /></td>
                            <td style={{ textAlign: 'right', fontSize: 13 }}>
                              <span style={{ color: allSubmitted ? 'var(--ok)' : 'var(--text)', fontWeight: allSubmitted ? 700 : 400 }}>
                                {row.submitted_count}
                              </span>
                              <span style={{ color: 'var(--muted)' }}>/{row.response_count}</span>
                            </td>
                            <td><ProgressBar pct={valPct} color="var(--accent)" /></td>
                            <td style={{ textAlign: 'right', fontSize: 13 }}>
                              <span style={{ color: allValidated ? 'var(--ok)' : 'var(--text)', fontWeight: allValidated ? 700 : 400 }}>
                                {row.validated_count}
                              </span>
                              <span style={{ color: 'var(--muted)' }}>/{row.response_count}</span>
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <span style={{
                                fontSize: 11, fontWeight: 700, padding: '2px 8px',
                                borderRadius: 999,
                                background: statusBadge.bg,
                                color: statusBadge.color,
                              }}>
                                {statusBadge.label}
                              </span>
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>}

          {/* ── Scores by Material Risk (removed) ── */}
          {false && (() => {
            const mrRows = summary.scores_by_material_risk ?? [];
            if (mrRows.length === 0) return null;

            const RISK_PALETTE: Record<string, { bar: string; bg: string }> = {
              'Market Risk':      { bar: '#e07b00', bg: 'rgba(224,123,0,.07)'   },
              'Liquidity Risk':   { bar: '#007b85', bg: 'rgba(0,123,133,.07)'   },
              'IRRBB Risk':       { bar: '#5a3ea1', bg: 'rgba(90,62,161,.07)'   },
              'Credit Risk':      { bar: '#c0392b', bg: 'rgba(192,57,43,.07)'   },
              'Operational Risk': { bar: '#2980b9', bg: 'rgba(41,128,185,.07)'  },
              'Strategic Risk':   { bar: '#27ae60', bg: 'rgba(39,174,96,.07)'   },
            };
            const FALLBACK = ['#c0392b', '#28a745', '#2980b9', '#8e44ad'];
            const riskPalette = (risk: string, idx: number) => {
              if (RISK_PALETTE[risk]) return RISK_PALETTE[risk];
              const col = FALLBACK[idx % FALLBACK.length];
              return { bar: col, bg: `${col}12` };
            };

            const chartData = mrRows.map(r => ({
              risk: r.material_risk,
              compliance: r.avg_compliance_score !== null ? Number(r.avg_compliance_score.toFixed(2)) : null,
              validation: r.avg_validation_score !== null ? Number(r.avg_validation_score.toFixed(2)) : null,
              count: r.response_count,
            }));

            const overallComp = (() => {
              const vals = mrRows.map(r => r.avg_compliance_score).filter((v): v is number => v !== null);
              return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
            })();
            const overallVal = (() => {
              const vals = mrRows.map(r => r.avg_validation_score).filter((v): v is number => v !== null);
              return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
            })();

            return (
              <div style={{
                background: 'var(--panel)', border: '1px solid var(--line)',
                borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow)',
                marginBottom: 20, overflow: 'hidden',
              }}>
                {/* Header */}
                <div style={{
                  padding: '12px 20px', borderBottom: '1px solid var(--line)',
                  background: 'var(--panel2)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                }}>
                  <span style={{ fontSize: 15 }}>⚠️</span>
                  <strong style={{ fontSize: 13 }}>Scores by Material Risk</strong>
                  <span className="small" style={{ color: 'var(--muted)' }}>Scale 1–4</span>
                  <span className="small" style={{ color: 'var(--muted)', marginLeft: 'auto' }}>BU 961 — {mrRows.length} risk type{mrRows.length !== 1 ? 's' : ''}</span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 0 }}>
                  {/* Chart */}
                  <div style={{ padding: '20px 20px 12px' }}>
                    {/* Legend */}
                    <div style={{ display: 'flex', gap: 20, marginBottom: 16, flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: 12, height: 12, borderRadius: 2, background: 'var(--accent-dark)' }} />
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Self Assessment</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: 12, height: 12, borderRadius: 2, background: 'var(--ok)' }} />
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Validation Score</span>
                      </div>
                    </div>
                    <ResponsiveContainer width="100%" height={Math.max(180, chartData.length * 72)}>
                      <BarChart
                        data={chartData}
                        layout="vertical"
                        margin={{ top: 4, right: 64, left: 8, bottom: 4 }}
                        barGap={4}
                        barCategoryGap="32%"
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={false} />
                        <XAxis
                          type="number"
                          domain={[0, 4]}
                          ticks={[1, 2, 3, 4]}
                          tick={{ fontSize: 11, fill: 'var(--muted)' }}
                          axisLine={{ stroke: 'var(--line)' }}
                          tickLine={false}
                        />
                        <YAxis
                          type="category"
                          dataKey="risk"
                          width={130}
                          tick={{ fontSize: 12, fill: 'var(--text)', fontWeight: 600 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip
                          contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--shadow-md)' }}
                          labelStyle={{ fontWeight: 700, marginBottom: 6 }}
                          cursor={{ fill: 'var(--hover-bg)' }}
                          formatter={(val: number | null, name: string) => [
                            val !== null ? val.toFixed(2) : '—',
                            name === 'compliance' ? 'Self Assessment' : 'Validation Score',
                          ]}
                        />
                        {overallComp !== null && (
                          <ReferenceLine x={overallComp} stroke="var(--accent-dark)" strokeDasharray="4 3" strokeWidth={1.5}
                            label={{ value: `Avg ${overallComp.toFixed(2)}`, position: 'insideTopRight', fontSize: 9, fill: 'var(--accent-dark)', dy: -6 }} />
                        )}
                        {overallVal !== null && (
                          <ReferenceLine x={overallVal} stroke="var(--ok)" strokeDasharray="4 3" strokeWidth={1.5}
                            label={{ value: `Avg ${overallVal.toFixed(2)}`, position: 'insideBottomRight', fontSize: 9, fill: 'var(--ok)', dy: 6 }} />
                        )}
                        <Bar dataKey="compliance" radius={[0, 4, 4, 0]} maxBarSize={18}>
                          {chartData.map((d, i) => (
                            <Cell key={d.risk} fill={riskPalette(d.risk, i).bar} fillOpacity={0.75} />
                          ))}
                        </Bar>
                        <Bar dataKey="validation" radius={[0, 4, 4, 0]} maxBarSize={18} fill="var(--ok)" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Score cards */}
                  <div style={{
                    borderLeft: '1px solid var(--line)',
                    display: 'flex', flexDirection: 'column',
                    minWidth: 220,
                  }}>
                    {mrRows.map((r, i) => {
                      const p = riskPalette(r.material_risk, i);
                      const gap = r.avg_compliance_score !== null && r.avg_validation_score !== null
                        ? r.avg_compliance_score - r.avg_validation_score
                        : null;
                      return (
                        <div key={r.material_risk} style={{
                          padding: '16px 20px',
                          borderBottom: i < mrRows.length - 1 ? '1px solid var(--line)' : undefined,
                          borderLeft: `4px solid ${p.bar}`,
                          background: p.bg,
                          flex: 1,
                        }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: p.bar, marginBottom: 8 }}>{r.material_risk}</div>
                          <div style={{ display: 'flex', gap: 12, marginBottom: 6 }}>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>Self</div>
                              <ScoreBar value={r.avg_compliance_score} />
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>Validation</div>
                              <ScoreBar value={r.avg_validation_score} />
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                            <span style={{ fontSize: 10, color: 'var(--muted)' }}>{r.response_count} question{r.response_count !== 1 ? 's' : ''}</span>
                            {gap !== null && (
                              <span style={{
                                fontSize: 11, fontWeight: 700,
                                color: Math.abs(gap) <= 0.10 ? 'var(--muted)' : gap > 0 ? '#e07b00' : '#007b85',
                              }}>
                                {Math.abs(gap) <= 0.10 ? '≈ aligned' : (gap > 0 ? '+' : '') + gap.toFixed(2) + ' gap'}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {/* Overall average row */}
                    <div style={{
                      padding: '14px 20px',
                      background: 'var(--panel2)',
                      borderTop: '2px solid var(--line)',
                    }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>Portfolio Average</div>
                      <div style={{ display: 'flex', gap: 12 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>Self</div>
                          <ScoreBar value={overallComp} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>Validation</div>
                          <ScoreBar value={overallVal} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div style={{
                  padding: '8px 20px', borderTop: '1px solid var(--line)',
                  background: 'var(--panel2)', fontSize: 11, color: 'var(--muted)',
                }}>
                  Material risks apply to BU 961 (Group Financial &amp; Liquidity Risk Management). Each risk type is scored independently.
                </div>
              </div>
            );
          })()}
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
              <span className="small" style={{ color: 'var(--muted)' }}>Event Type</span>
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

          <div
            ref={auditTableRef}
            style={{
              background: 'var(--panel)', border: '1px solid var(--line)',
              borderRadius: 'var(--radius2)', boxShadow: 'var(--shadow)',
              overflow: 'auto',
              height: auditTableTop != null ? `calc(100vh - ${auditTableTop}px - 24px)` : '65vh',
            }}
          >
            <table className="table" style={{ fontSize: 12, minWidth: 1100 }}>
              <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                <tr>
                  <th style={{ whiteSpace: 'nowrap' }}>Timestamp</th>
                  <th>Event</th>
                  <th>Actor</th>
                  <th>Role</th>
                  <th>Cycle</th>
                  <th>Subject</th>
                  <th>Score</th>
                  <th>Comment / Justification</th>
                  <th>Additional Controls</th>
                  <th>File</th>
                </tr>
              </thead>
              <tbody>
                {auditLoading && <tr><td colSpan={10} className="small" style={{ textAlign: 'center', padding: 24 }}>Loading…</td></tr>}
                {!auditLoading && auditEntries.length === 0 && <tr><td colSpan={10} className="small" style={{ textAlign: 'center', padding: 24 }}>No audit entries found.</td></tr>}
                {!auditLoading && auditEntries.map(entry => {
                  const d = entry.details ?? {};

                  const ACTION_LABELS: Record<string, string> = {
                    response_saved:                    'Score saved',
                    response_submitted:                'Assessment submitted',
                    response_returned:                 'Assessment returned to respondent',
                    validation_updated:                'Validation score saved',
                    validation_submitted_for_approval: 'Submitted for approval',
                    validation_approved:               'Validation approved',
                    validation_rejected:               'Validation rejected',
                    validation_attachment_uploaded:    'Evidence file uploaded',
                    attachment_uploaded:               'File uploaded',
                    attachment_deleted:                'File deleted',
                    cycle_created:                     'Cycle created',
                    cycle_submitted_for_approval:      'Cycle submitted for approval',
                    cycle_approved:                    'Cycle approved',
                    cycle_rejected:                    'Cycle rejected',
                    cycle_distributed:                 'Cycle distributed',
                    cycle_closed:                      'Cycle closed',
                    cycle_deleted:                     'Cycle deleted',
                    checklist_uploaded:                'Checklist uploaded',
                    applicability_assigned:            'BU assigned to question',
                    applicability_removed:             'BU removed from question',
                    user_created:                      'User created',
                    user_updated:                      'User updated',
                    user_enabled:                      'User enabled',
                    user_disabled:                     'User disabled',
                    user_deleted:                      'User deleted',
                  };

                  const SCORE_LABELS_AUDIT: Record<number, string> = { 1: '1 – Non-compliant', 2: '2 – Partially compliant', 3: '3 – Largely compliant', 4: '4 – Compliant' };
                  const scoreLabel = (v: unknown) => v != null ? (SCORE_LABELS_AUDIT[Number(v)] ?? String(v)) : null;

                  const questionLabel = d.item_number != null ? `Item ${d.item_number}` : d.question_id ? `Q${d.question_id}` : null;
                  const subject = [
                    d.bu_code   ? `BU ${d.bu_code}`              : null,
                    questionLabel,
                    d.bu_name   ? `(${d.bu_name})`               : null,
                    d.display_name ? d.display_name as string     : null,
                  ].filter(Boolean).join(' ') || '—';

                  const comment = (d.comments as string | null) ?? (d.return_comment as string | null) ?? (d.rejection_comment as string | null) ?? (d.justification as string | null) ?? null;
                  const additionalControls = (d.additional_controls as string | null) ?? null;
                  const file    = (d.file_name as string | null) ?? null;

                  // Show the score the user entered: prefer new_score, fall back to old_score
                  const scoreVal = d.new_score != null ? d.new_score : (d.old_score != null ? d.old_score : null);
                  const scoreStr = scoreLabel(scoreVal);
                  const scoreNum = scoreVal != null ? Number(scoreVal) : null;

                  const eventLabel = ACTION_LABELS[entry.action] ?? entry.action;

                  const EVENT_COLOR: Record<string, string> = {
                    response_submitted:                'var(--accent)',
                    validation_approved:               'var(--ok)',
                    validation_rejected:               'var(--danger)',
                    cycle_closed:                      'var(--ok)',
                    cycle_distributed:                 'var(--accent)',
                    response_returned:                 'var(--warn)',
                  };
                  const eventColor = EVENT_COLOR[entry.action] ?? 'var(--text)';

                  const scoreColor2 = scoreNum != null
                    ? scoreNum <= 1.5 ? 'var(--danger)' : scoreNum <= 2.5 ? '#ffc000' : scoreNum <= 3.5 ? '#81b848' : 'var(--ok)'
                    : 'var(--muted)';

                  return (
                    <tr key={entry.id}>
                      <td style={{ whiteSpace: 'nowrap', color: 'var(--muted)', fontSize: 11 }}>
                        {entry.created_at ? new Date(entry.created_at).toLocaleString() : '—'}
                      </td>
                      <td>
                        <span style={{ fontWeight: 600, color: eventColor }}>{eventLabel}</span>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{entry.actor_name ?? entry.actor_id ?? '—'}</td>
                      <td style={{ whiteSpace: 'nowrap', color: 'var(--muted)' }}>{entry.actor_role ?? '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{entry.cycle_name ?? (entry.cycle_id ? String(entry.cycle_id) : '—')}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{subject}</td>
                      <td style={{ color: scoreColor2, fontWeight: scoreStr ? 600 : undefined }}>
                        {scoreStr ?? <span style={{ color: 'var(--muted)' }}>—</span>}
                      </td>
                      <td style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--muted)' }} title={comment ?? ''}>
                        {comment ?? <span style={{ color: 'var(--muted)' }}>—</span>}
                      </td>
                      <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--muted)' }} title={additionalControls ?? ''}>
                        {additionalControls ?? <span style={{ color: 'var(--muted)' }}>—</span>}
                      </td>
                      <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={displayFileName(file)}>
                        {file
                          ? <a href={`/api/audit-log/${entry.id}/file`} download={file} style={{ color: 'var(--accent)', textDecoration: 'underline' }}>{displayFileName(file)}</a>
                          : <span style={{ color: 'var(--muted)' }}>—</span>
                        }
                      </td>
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
