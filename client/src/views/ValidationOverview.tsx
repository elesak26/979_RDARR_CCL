import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Cycle } from '../types';
import { scoreColor, SCORE_LABELS } from '../utils/scores';

function parseOverviewRow(r: OverviewRow): OverviewRow {
  return {
    ...r,
    self_score: r.self_score != null ? parseFloat(String(r.self_score)) : null,
    weight: parseFloat(String(r.weight)),
    consolidated_score: r.consolidated_score != null ? parseFloat(String(r.consolidated_score)) : null,
  };
}

interface OverviewRow {
  validation_id: number;
  question_id: number;
  bu_code: string;
  status: string;
  validation_score: number | null;
  item_number: number;
  thematic_area: string;
  requirement: string;
  bcbs_principle_name: string | null;
  bcbs_principle_number: number | null;
  self_score: number | null;
  weight: number;
  bu_name: string | null;
  consolidated_score: number | null;
}

interface QuestionGroup {
  question_id: number;
  item_number: number;
  thematic_area: string;
  requirement: string;
  bcbs_principle_name: string | null;
  bcbs_principle_number: number | null;
  consolidated_score: number | null;
  rows: OverviewRow[];
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>;
  const rounded = Math.round(score);
  const color = scoreColor(rounded);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: `${color}18`, border: `1px solid ${color}55`,
      borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 700, color,
    }}>
      {score.toFixed(2)} — {SCORE_LABELS[rounded] ?? ''}
    </span>
  );
}

async function exportOverviewToPdf(el: HTMLElement, filename: string, cycleName: string) {
  const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);
  const canvas = await html2canvas(el, { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false });
  const imgData = canvas.toDataURL('image/png');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 36;
  const headerH = 48;
  const contentW = pageW - margin * 2;
  const imgH = (canvas.height / canvas.width) * contentW;

  // Draw cycle name header on every page
  const drawHeader = () => {
    pdf.setFillColor(245, 247, 250);
    pdf.rect(0, 0, pageW, headerH, 'F');
    pdf.setFontSize(9);
    pdf.setTextColor(130, 130, 130);
    pdf.text('Validation Overview', margin, 18);
    pdf.setFontSize(13);
    pdf.setTextColor(30, 30, 30);
    pdf.setFont('helvetica', 'bold');
    pdf.text(cycleName, margin, 36);
    pdf.setFont('helvetica', 'normal');
  };

  let yOffset = 0;
  while (yOffset < imgH) {
    if (yOffset > 0) pdf.addPage();
    drawHeader();
    pdf.addImage(imgData, 'PNG', margin, headerH + 8 - yOffset, contentW, imgH);
    pdf.setFillColor(255, 255, 255);
    pdf.rect(0, pageH - margin, pageW, margin + 10, 'F');
    pdf.rect(0, 0, pageW, headerH, 'F');
    drawHeader();
    yOffset += pageH - headerH - 8 - margin;
  }
  pdf.save(filename);
}


interface RejectModal {
  question_id: number;
  item_number: number;
}

export default function ValidationOverview() {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const overviewRef = useRef<HTMLDivElement>(null);
  const [bulkActing, setBulkActing] = useState<number | null>(null);
  const [rejectModal, setRejectModal] = useState<RejectModal | null>(null);
  const [rejectComment, setRejectComment] = useState('');
  const [bulkError, setBulkError] = useState<string | null>(null);

  const cycleIdParam = searchParams.get('cycle');
  const selectedCycleId = cycleIdParam ? parseInt(cycleIdParam, 10) : null;

  // Load distributed + closed cycles on mount
  useEffect(() => {
    api.get<Cycle[]>('/cycles').then(all => {
      const relevant = all.filter(c => c.status === 'distributed' || c.status === 'closed');
      setCycles(relevant);
      if (!cycleIdParam && relevant.length > 0) {
        const preferred = relevant.find(c => c.status === 'distributed') ?? relevant[0];
        setSearchParams({ cycle: String(preferred.id) }, { replace: true });
      }
    }).catch(() => {});
  }, []);

  const loadOverview = useCallback(async (cycleId: number) => {
    setLoading(true);
    setError(null);
    try {
      const raw = await api.get<OverviewRow[]>(`/cycles/${cycleId}/validation-overview`);
      setRows(raw.map(parseOverviewRow));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedCycleId) loadOverview(selectedCycleId);
    else setRows([]);
  }, [selectedCycleId, loadOverview]);

  async function handleBulkApprove(questionId: number) {
    if (!selectedCycleId) return;
    setBulkActing(questionId);
    setBulkError(null);
    try {
      await api.put(`/cycles/${selectedCycleId}/questions/${questionId}/approve`);
      await loadOverview(selectedCycleId);
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : 'Approve failed');
    } finally {
      setBulkActing(null);
    }
  }

  async function handleBulkReject() {
    if (!selectedCycleId || !rejectModal) return;
    setBulkActing(rejectModal.question_id);
    setBulkError(null);
    try {
      await api.put(`/cycles/${selectedCycleId}/questions/${rejectModal.question_id}/reject`, { rejection_comment: rejectComment.trim() });
      setRejectModal(null);
      setRejectComment('');
      await loadOverview(selectedCycleId);
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : 'Reject failed');
    } finally {
      setBulkActing(null);
    }
  }

  // Group: thematic_area → bcbs_principle_name → requirement → question
  const byArea = new Map<string, Map<string, Map<string, QuestionGroup[]>>>();
  for (const row of rows) {
    const area = row.thematic_area;
    const principle = row.bcbs_principle_name ?? '—';
    const req = row.requirement;

    if (!byArea.has(area)) byArea.set(area, new Map());
    const byPrinciple = byArea.get(area)!;
    if (!byPrinciple.has(principle)) byPrinciple.set(principle, new Map());
    const byReq = byPrinciple.get(principle)!;
    if (!byReq.has(req)) {
      byReq.set(req, [{
        question_id: row.question_id,
        item_number: row.item_number,
        thematic_area: row.thematic_area,
        requirement: row.requirement,
        bcbs_principle_name: row.bcbs_principle_name,
        bcbs_principle_number: row.bcbs_principle_number,
        consolidated_score: row.consolidated_score,
        rows: [],
      }]);
    }
    byReq.get(req)![0].rows.push(row);
  }

  const selectedCycle = cycles.find(c => c.id === selectedCycleId);

  // Group cycles by year descending for optgroup picker
  const cyclesByYear = cycles.reduce<Map<number, Cycle[]>>((map, c) => {
    if (!map.has(c.year)) map.set(c.year, []);
    map.get(c.year)!.push(c);
    return map;
  }, new Map());
  const sortedYears = Array.from(cyclesByYear.keys()).sort((a, b) => b - a);

  return (
    <div>
      {/* Header */}
      <div className="topbar" style={{ marginBottom: 16 }}>
        <div className="left">
          <strong style={{ fontSize: 18 }}>Validation Overview</strong>
          {rows.length > 0 && (
            <span className="chip">{byArea.size} areas · {new Set(rows.map(r => r.question_id)).size} items</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {cycles.length === 0 ? (
            <span className="small" style={{ color: 'var(--muted)' }}>No cycles available</span>
          ) : (
            <select
              value={selectedCycleId ?? ''}
              onChange={e => setSearchParams({ cycle: e.target.value })}
              style={{ fontSize: 13, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--input-bg)', color: 'var(--text)' }}
            >
              {sortedYears.map(year => (
                <optgroup key={year} label={String(year)}>
                  {cyclesByYear.get(year)!.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name}{c.status === 'closed' ? ' — Closed' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
          {rows.length > 0 && (
            <button
              className="btn"
              disabled={exporting}
              onClick={async () => {
                if (!overviewRef.current || !selectedCycle) return;
                setExporting(true);
                try { await exportOverviewToPdf(overviewRef.current, `${selectedCycle.name.replace(/\s+/g, '_')}_Validation_Overview.pdf`, selectedCycle.name); }
                finally { setExporting(false); }
              }}
              style={{ display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              {exporting ? 'Exporting…' : 'Export PDF'}
            </button>
          )}
        </div>
      </div>

      {selectedCycle?.status === 'closed' && (
        <div style={{
          padding: '10px 16px', marginBottom: 16,
          background: 'rgba(40,167,69,0.08)',
          border: '1px solid var(--ok)',
          borderRadius: 6, fontSize: 13, color: 'var(--ok)',
          fontWeight: 500,
        }}>
          This cycle is complete — all validations have been approved. View only.
        </div>
      )}

      {loading && <div className="small" style={{ padding: 24, color: 'var(--muted)' }}>Loading…</div>}
      {error && <div style={{ color: 'var(--danger)', padding: 16 }}>Error: {error}</div>}

      {!loading && !error && selectedCycleId && rows.length === 0 && (
        <div className="panel" style={{ padding: '32px 24px', textAlign: 'center', color: 'var(--muted)' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
          <div>No items available in {selectedCycle?.name ?? 'this cycle'}.</div>
          <div className="small" style={{ marginTop: 6 }}>Items appear here once all BU Validators have completed validation for each question.</div>
        </div>
      )}

      {bulkError && (
        <div style={{ color: 'var(--danger)', padding: '8px 12px', marginBottom: 12, background: 'rgba(220,53,69,.08)', borderRadius: 6, border: '1px solid var(--danger)', fontSize: 13 }}>
          {bulkError}
        </div>
      )}

      {!loading && !error && byArea.size > 0 && (
        <div ref={overviewRef} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {Array.from(byArea.entries()).map(([area, byPrinciple]) => (
            <div key={area} className="panel" style={{ padding: 0, overflow: 'hidden' }}>
              {/* Thematic Area header */}
              <div style={{
                padding: '10px 16px',
                background: 'var(--accent)10',
                borderBottom: '1px solid var(--line)',
                fontWeight: 700, fontSize: 14, color: 'var(--accent)',
              }}>
                {area}
              </div>

              {Array.from(byPrinciple.entries()).map(([principle, byReq]) => (
                <div key={principle}>
                  {/* BCBS Principle header */}
                  <div style={{
                    padding: '7px 16px 7px 24px',
                    background: 'var(--panel-bg, var(--bg))',
                    borderBottom: '1px solid var(--line)',
                    fontSize: 12, fontWeight: 600, color: 'var(--muted)',
                    letterSpacing: '0.04em', textTransform: 'uppercase',
                  }}>
                    {principle !== '—' ? `BCBS: ${principle}` : 'No BCBS Principle'}
                  </div>

                  {Array.from(byReq.entries()).map(([req, groups]) =>
                    groups.map(group => (
                      <div key={group.question_id} style={{ borderBottom: '1px solid var(--line)' }}>
                        {/* Requirement row */}
                        <div style={{
                          padding: '8px 16px 8px 32px',
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
                        }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                              <span style={{
                                fontSize: 11, fontWeight: 700, letterSpacing: '0.05em',
                                background: 'var(--accent)18', color: 'var(--accent)',
                                padding: '2px 7px', borderRadius: 4, flexShrink: 0,
                              }}>
                                Item #{group.item_number}
                              </span>
                              <span className="small" style={{ color: 'var(--muted)' }}>
                                {group.rows.length} respondent{group.rows.length !== 1 ? 's' : ''}
                              </span>
                            </div>
                            <div style={{ fontSize: 13, lineHeight: 1.4, color: 'var(--text)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                              {req}
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                            <ScoreBadge score={group.consolidated_score} />
                            {group.rows.every(r => r.status === 'closed') ? (
                              <span style={{
                                display: 'inline-flex', alignItems: 'center',
                                background: '#2f9e4418', border: '1px solid #2f9e4455',
                                borderRadius: 6, padding: '2px 10px', fontSize: 12, fontWeight: 700, color: '#2f9e44',
                              }}>
                                Approved
                              </span>
                            ) : (
                              <>
                                <span style={{
                                  display: 'inline-flex', alignItems: 'center',
                                  background: '#f08c0018', border: '1px solid #f08c0055',
                                  borderRadius: 6, padding: '2px 10px', fontSize: 12, fontWeight: 700, color: '#f08c00',
                                }}>
                                  Pending Approval
                                </span>
                                {selectedCycle?.status === 'distributed' && (
                                  <>
                                    <button
                                      className="btn"
                                      style={{ fontSize: 12, padding: '4px 10px', background: '#2f9e44', color: '#fff', border: 'none' }}
                                      disabled={bulkActing === group.question_id}
                                      onClick={() => handleBulkApprove(group.question_id)}
                                      title="Approve all BU validations for this item"
                                    >
                                      {bulkActing === group.question_id ? '…' : 'Approve all'}
                                    </button>
                                    <button
                                      className="btn danger"
                                      style={{ fontSize: 12, padding: '4px 10px' }}
                                      disabled={bulkActing === group.question_id}
                                      onClick={() => { setBulkError(null); setRejectComment(''); setRejectModal({ question_id: group.question_id, item_number: group.item_number }); }}
                                      title="Reject all BU validations for this item"
                                    >
                                      Reject all
                                    </button>
                                  </>
                                )}
                              </>
                            )}
                            <button
                              className="btn primary"
                              style={{ fontSize: 12, padding: '4px 12px' }}
                              onClick={() => navigate(`/validation-overview/${selectedCycleId}/${group.question_id}`)}
                            >
                              Details
                            </button>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {/* Reject all modal */}
      {rejectModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}
          onClick={e => { if (e.target === e.currentTarget) { setRejectModal(null); setRejectComment(''); } }}
        >
          <div style={{
            background: 'var(--bg)', borderRadius: 10, padding: '28px 28px 24px',
            width: 440, maxWidth: '92vw', boxShadow: '0 8px 40px rgba(0,0,0,.3)',
          }}>
            <h2 style={{ margin: '0 0 6px', fontSize: 17, color: 'var(--danger)' }}>Reject all — Item #{rejectModal.item_number}</h2>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
              All pending BU validations for this item will be rejected and returned to the Validator.
            </p>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>
                Rejection comment <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span>
              </label>
              <textarea
                autoFocus
                rows={4}
                value={rejectComment}
                onChange={e => setRejectComment(e.target.value)}
                placeholder="Explain what needs to be revised…"
                style={{
                  width: '100%', padding: '8px 10px', fontSize: 13,
                  border: '1px solid var(--line)', borderRadius: 6,
                  background: 'var(--input-bg)', color: 'var(--text)',
                  resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, boxSizing: 'border-box',
                }}
              />
            </div>
            {bulkError && (
              <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>{bulkError}</div>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => { setRejectModal(null); setRejectComment(''); setBulkError(null); }}>
                Cancel
              </button>
              <button
                className="btn danger"
                disabled={bulkActing === rejectModal.question_id}
                onClick={handleBulkReject}
              >
                {bulkActing === rejectModal.question_id ? 'Rejecting…' : 'Reject all'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
