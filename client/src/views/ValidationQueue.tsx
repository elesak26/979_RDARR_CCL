import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Cycle, Validation, User } from '../types';
import { useBuNames } from '../hooks/useBuNames';

interface EnrichedValidation extends Validation {
  cycleName: string;
  cycleId: number;
}

const STATUS_COLOR: Record<string, string> = {
  rejected:         '#a61c2e',
  in_review:        'var(--warn)',
  returned:         '#e07b00',
  pending_approval: '#7c3aed',
  pending:          'var(--muted)',
  closed:           'var(--ok)',
};

const STATUS_LABEL: Record<string, string> = {
  rejected:         'Rejected by SV',
  in_review:        'Ready to Review',
  returned:         'Returned to BU',
  pending_approval: 'Awaiting SV',
  pending:          'Pending',
  closed:           'Closed',
};

// Semantic sections shown to Validator
const VALIDATOR_SECTIONS = [
  {
    id: 'action',
    label: 'Action Required',
    statuses: ['rejected', 'in_review'],
    color: '#a61c2e',
    collapsible: false,
    readOnly: false,
  },
  {
    id: 'returned',
    label: 'Returned to BU',
    statuses: ['returned'],
    color: '#e07b00',
    collapsible: false,
    readOnly: true,
  },
  {
    id: 'awaiting',
    label: 'Awaiting Senior Validator',
    statuses: ['pending_approval'],
    color: '#7c3aed',
    collapsible: false,
    readOnly: true,
  },
  {
    id: 'closed',
    label: 'Closed',
    statuses: ['closed'],
    color: 'var(--ok)',
    collapsible: true,
    readOnly: true,
  },
] as const;

export default function ValidationQueue() {
  const [items, setItems]                     = useState<EnrichedValidation[]>([]);
  const [cycles, setCycles]                   = useState<Cycle[]>([]);
  const [loading, setLoading]                 = useState(true);
  const [error, setError]                     = useState<string | null>(null);
  const [currentUser, setCurrentUser]         = useState<User | null>(null);
  const [cycleFilter, setCycleFilter]         = useState<number | 'all'>('all');
  const [closedExpanded, setClosedExpanded]   = useState(false);
  const [buFilter, setBuFilter]               = useState<string | 'all'>('all');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const statusFilter = searchParams.get('status');
  const urlCycleId   = searchParams.get('cycle_id') ? Number(searchParams.get('cycle_id')) : 'all';
  const buName = useBuNames();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [me, allCycles] = await Promise.all([
        api.get<User>('/users/me'),
        api.get<Cycle[]>('/cycles'),
      ]);
      setCurrentUser(me);
      const activeCycles = allCycles.filter(c => c.status === 'distributed' || c.status === 'closed');
      setCycles(activeCycles);

      const enriched: EnrichedValidation[] = [];
      await Promise.all(activeCycles.map(async cycle => {
        try {
          const validations = await api.get<Validation[]>(`/cycles/${cycle.id}/validations`);
          for (const v of validations) enriched.push({ ...v, cycleName: cycle.name, cycleId: cycle.id });
        } catch { /* skip */ }
      }));

      const order: Record<string, number> = { rejected: 0, in_review: 1, returned: 2, pending_approval: 3, pending: 4, closed: 5 };
      enriched.sort((a, b) => {
        const sd = (order[a.status] ?? 99) - (order[b.status] ?? 99);
        if (sd !== 0) return sd;
        const id = (a.item_number ?? 0) - (b.item_number ?? 0);
        if (id !== 0) return id;
        return (a.bu_code ?? '').localeCompare(b.bu_code ?? '');
      });

      setItems(enriched);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setCycleFilter(urlCycleId); }, [urlCycleId]);

  if (loading) return <div className="small">Loading validation queue…</div>;
  if (error) return (
    <div style={{ color: 'var(--danger)', padding: 16 }}>
      Error: {error} <button className="btn" onClick={load} style={{ marginLeft: 8 }}>Retry</button>
    </div>
  );

  const isSeniorValidator = currentUser?.role === 'Senior Validator';
  const isValidator       = currentUser?.role === 'Validator';
  const effectiveFilter   = statusFilter ?? (isSeniorValidator ? 'pending_approval' : null);

  // Status filter
  const statusFiltered = effectiveFilter
    ? items.filter(i => i.status === effectiveFilter || i.status === 'closed')
    : isValidator
      ? items.filter(i => ['in_review', 'rejected', 'returned', 'pending_approval', 'closed'].includes(i.status))
      : items;

  const cyclesWithItems = cycles.filter(c => statusFiltered.some(i => i.cycleId === c.id));

  const cycleFiltered = cycleFilter === 'all'
    ? statusFiltered
    : statusFiltered.filter(i => i.cycleId === cycleFilter);

  const allBuCodes = Array.from(new Set(cycleFiltered.map(i => i.bu_code).filter(Boolean) as string[])).sort();

  const displayedItems = buFilter === 'all'
    ? cycleFiltered
    : cycleFiltered.filter(i => i.bu_code === buFilter);

  const countByStatus = (s: string) => {
    if (s !== 'pending_approval') return items.filter(i => i.status === s).length;
    // For pending_approval: count questions (not BU rows) where every validation
    // for that question is pending_approval or closed, and at least one is pending_approval.
    const byQuestion = new Map<string, { allDone: boolean; anyPending: boolean }>();
    for (const v of items) {
      const key = `${v.cycleId}:${v.question_id}`;
      const prev = byQuestion.get(key) ?? { allDone: true, anyPending: false };
      byQuestion.set(key, {
        allDone: prev.allDone && (v.status === 'pending_approval' || v.status === 'closed'),
        anyPending: prev.anyPending || v.status === 'pending_approval',
      });
    }
    let count = 0;
    for (const { allDone, anyPending } of byQuestion.values()) {
      if (allDone && anyPending) count++;
    }
    return count;
  };
  const countByCycleStatus = (cid: number, s: string) => {
    if (s !== 'pending_approval') return items.filter(i => i.cycleId === cid && i.status === s).length;
    const byQuestion = new Map<number, { allDone: boolean; anyPending: boolean }>();
    for (const v of items.filter(i => i.cycleId === cid)) {
      const prev = byQuestion.get(v.question_id) ?? { allDone: true, anyPending: false };
      byQuestion.set(v.question_id, {
        allDone: prev.allDone && (v.status === 'pending_approval' || v.status === 'closed'),
        anyPending: prev.anyPending || v.status === 'pending_approval',
      });
    }
    let count = 0;
    for (const { allDone, anyPending } of byQuestion.values()) {
      if (allDone && anyPending) count++;
    }
    return count;
  };

  const multiCycle = cyclesWithItems.length > 1 && cycleFilter === 'all';

  // ── Validator view ────────────────────────────────────────────────────────
  if (isValidator) {
    const renderValidatorSection = (section: typeof VALIDATOR_SECTIONS[number]) => {
      const sectionItems = displayedItems.filter(i => section.statuses.includes(i.status as never));
      if (sectionItems.length === 0) return null;
      const isCollapsed = section.collapsible && !closedExpanded;
      const showStatusCol = section.statuses.length > 1;

      // For "Awaiting SV": show distinct question count in badge, raw assessment count as hint
      const isAwaitingSV = section.id === 'awaiting';
      const awaitingQuestions = isAwaitingSV ? (() => {
        const qs = new Set<number>();
        for (const v of sectionItems) qs.add(v.question_id);
        return qs.size;
      })() : 0;
      const badgeCount = isAwaitingSV ? awaitingQuestions : sectionItems.length;

      return (
        <div key={section.id} style={{ marginBottom: 20 }}>
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 14px', marginBottom: 6,
              borderLeft: `4px solid ${section.color}`,
              background: `${section.color}0d`,
              borderRadius: '0 6px 6px 0',
              cursor: section.collapsible ? 'pointer' : 'default',
              userSelect: 'none',
            }}
            onClick={() => section.collapsible && setClosedExpanded(p => !p)}
          >
            <span style={{ fontWeight: 700, fontSize: 13, color: section.color, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {section.label}
            </span>
            <span style={{
              fontSize: 11, fontWeight: 700,
              background: section.color, color: '#fff',
              borderRadius: 10, padding: '1px 7px', lineHeight: 1.6,
            }}>
              {badgeCount}
            </span>
            {isAwaitingSV && sectionItems.length !== awaitingQuestions && (
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                · {sectionItems.length} assessments
              </span>
            )}
            {!isAwaitingSV && section.readOnly && !section.collapsible && (
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>· view only</span>
            )}
            {section.collapsible && (
              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>
                {isCollapsed ? '▶ show' : '▼ hide'}
              </span>
            )}
          </div>

          {!isCollapsed && (
            <div className="panel" style={{ marginBottom: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 44 }}>Q#</th>
                    <th style={{ width: 100 }}>Respondent</th>
                    <th>Requirement</th>
                    {showStatusCol && <th style={{ width: 130 }}>Status</th>}
                    <th style={{ width: 80 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {sectionItems.map(v => {
                    const col = STATUS_COLOR[v.status] ?? 'var(--muted)';
                    const isPrimary = !section.readOnly && (v.status === 'in_review' || v.status === 'rejected');
                    const btnLabel = section.readOnly ? 'View' : 'Review';
                    return (
                      <tr key={v.id} style={{ borderLeft: `3px solid ${col}` }}>
                        <td style={{ fontWeight: 700, color: col, fontSize: 13 }}>
                          {v.item_number ?? '—'}
                        </td>
                        <td>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            {v.bu_code ? (
                              <span style={{
                                fontSize: 12, fontWeight: 700,
                                padding: '3px 8px', borderRadius: 4,
                                background: 'var(--accent)18', color: 'var(--accent)',
                                border: '1px solid var(--accent)44',
                                alignSelf: 'flex-start',
                              }}>
                                {buName(v.bu_code)}
                              </span>
                            ) : (
                              <span style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>—</span>
                            )}
                            {v.material_risk && (
                              <span style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>{v.material_risk}</span>
                            )}
                          </div>
                        </td>
                        <td>
                          <div style={{ fontSize: 13, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                            {v.requirement ?? '—'}
                          </div>
                          <div style={{ marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                            {v.thematic_area && (
                              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{v.thematic_area}</span>
                            )}
                            {multiCycle && (
                              <span style={{
                                fontSize: 11, padding: '1px 6px', borderRadius: 4,
                                background: 'var(--accent)14', color: 'var(--accent)',
                                border: '1px solid var(--accent)30',
                              }}>
                                {v.cycleName}
                              </span>
                            )}
                          </div>
                        </td>
                        {showStatusCol && (
                          <td>
                            <span style={{
                              fontSize: 11, fontWeight: 600,
                              padding: '2px 7px', borderRadius: 4,
                              background: `${col}18`, color: col,
                              border: `1px solid ${col}44`,
                              whiteSpace: 'nowrap',
                            }}>
                              {STATUS_LABEL[v.status] ?? v.status}
                            </span>
                          </td>
                        )}
                        <td>
                          <button
                            className={`btn${isPrimary ? ' primary' : ''}`}
                            onClick={() => navigate(`/validation/${v.id}`, { state: { cycleId: v.cycleId } })}
                            style={{ fontSize: 12, padding: '4px 10px' }}
                          >
                            {btnLabel}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      );
    };

    const validatorStatusesInCards: string[] = ['rejected', 'in_review', 'returned', 'pending_approval', 'closed'];

    return (
      <div>
        {/* Header */}
        <div className="topbar" style={{ marginBottom: 16 }}>
          <div className="left">
            <strong style={{ fontSize: 18 }}>Validation Actions</strong>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* BU filter */}
            <select
              value={buFilter}
              onChange={e => setBuFilter(e.target.value)}
              disabled={allBuCodes.length === 0}
              style={{
                fontSize: 13, padding: '4px 8px', borderRadius: 6,
                border: '1px solid var(--line)', background: 'var(--input-bg)', color: 'var(--text)',
                opacity: allBuCodes.length === 0 ? 0.45 : 1,
                cursor: allBuCodes.length === 0 ? 'not-allowed' : 'pointer',
              }}
            >
              <option value="all">All respondents{allBuCodes.length > 0 ? ` (${allBuCodes.length})` : ''}</option>
              {allBuCodes.map(bu => (
                <option key={bu} value={bu}>{buName(bu)}</option>
              ))}
            </select>
            <button className="btn" onClick={load} style={{ fontSize: 12, padding: '4px 10px' }}>Refresh</button>
          </div>
        </div>

        {/* Cycle summary cards */}
        {cyclesWithItems.length > 0 && (
          <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
            {cyclesWithItems.map(c => {
              const isActive = cycleFilter === c.id;
              return (
                <div
                  key={c.id}
                  className="panel clickable"
                  onClick={() => setCycleFilter(isActive ? 'all' : c.id)}
                  style={{
                    flex: '1 1 240px',
                    padding: '14px 18px',
                    borderRadius: 8,
                    border: isActive ? '1px solid var(--accent)' : '1px solid var(--line)',
                    boxShadow: isActive ? '0 0 0 3px var(--accent)22' : undefined,
                    cursor: 'pointer',
                    transition: 'border-color 0.15s, box-shadow 0.15s',
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>{c.name}</span>
                    {isActive && (
                      <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                        filtered ✕
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {validatorStatusesInCards.map(s => {
                      const cnt = countByCycleStatus(c.id, s);
                      if (cnt === 0) return null;
                      const col = STATUS_COLOR[s] ?? 'var(--muted)';
                      return (
                        <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{
                            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                            background: col, flexShrink: 0,
                          }} />
                          <span style={{ fontWeight: 700, color: col, fontSize: 13, minWidth: 20 }}>{cnt}</span>
                          <span style={{ color: 'var(--muted)', fontSize: 12 }}>{STATUS_LABEL[s]}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {cyclesWithItems.length > 1 && cycleFilter !== 'all' && (
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button className="btn" onClick={() => setCycleFilter('all')} style={{ fontSize: 12, padding: '4px 10px' }}>
                  Show all cycles
                </button>
              </div>
            )}
          </div>
        )}

        {/* Semantic sections */}
        {displayedItems.length === 0 ? (
          <div className="panel">
            <div className="small" style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>
              No validations found. Make sure there is a distributed cycle.
            </div>
          </div>
        ) : (
          VALIDATOR_SECTIONS.map(section => renderValidatorSection(section))
        )}
      </div>
    );
  }

  // ── Senior Validator / other roles: original layout ───────────────────────
  const isFiltered = cycleFilter !== 'all' || buFilter !== 'all' || !!effectiveFilter;

  return (
    <div>
      {/* Header */}
      <div className="topbar" style={{ marginBottom: 16 }}>
        <div className="left">
          <strong style={{ fontSize: 18 }}>Validation Actions</strong>
          <span className="chip">{displayedItems.length}{isFiltered ? ' filtered' : ' total'}</span>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="small">
            <span style={{ color: '#a61c2e', fontWeight: 600 }}>{countByStatus('rejected')}</span> rejected ·{' '}
            <span style={{ color: 'var(--warn)', fontWeight: 600 }}>{countByStatus('in_review')}</span> ready ·{' '}
            <span style={{ color: '#e07b00', fontWeight: 600 }}>{countByStatus('returned')}</span> returned ·{' '}
            <span style={{ color: '#7c3aed', fontWeight: 600 }}>{countByStatus('pending_approval')}</span> pending approval ·{' '}
            <span style={{ color: 'var(--muted)', fontWeight: 600 }}>{countByStatus('pending')}</span> pending ·{' '}
            <span style={{ color: 'var(--ok)', fontWeight: 600 }}>{countByStatus('closed')}</span> closed
          </span>

          {cyclesWithItems.length > 1 && (
            <select
              value={cycleFilter}
              onChange={e => { setCycleFilter(e.target.value === 'all' ? 'all' : Number(e.target.value)); setBuFilter('all'); }}
              style={{ fontSize: 13, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--input-bg)', color: 'var(--text)' }}
            >
              <option value="all">All cycles ({cyclesWithItems.length})</option>
              {cyclesWithItems.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}

          <select
            value={buFilter}
            onChange={e => setBuFilter(e.target.value)}
            disabled={allBuCodes.length === 0}
            style={{
              fontSize: 13, padding: '4px 8px', borderRadius: 6,
              border: '1px solid var(--line)', background: 'var(--input-bg)', color: 'var(--text)',
              opacity: allBuCodes.length === 0 ? 0.45 : 1,
              cursor: allBuCodes.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            <option value="all">All respondents{allBuCodes.length > 0 ? ` (${allBuCodes.length})` : ''}</option>
            {allBuCodes.map(bu => (
              <option key={bu} value={bu}>{buName(bu)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Context banners */}
      {effectiveFilter === 'in_review' && isSeniorValidator && (
        <div style={{ padding: '10px 16px', marginBottom: 12, background: 'rgba(255,193,7,0.08)', border: '1px solid var(--warn)', borderRadius: 6, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: 'var(--warn)', fontWeight: 600 }}>Viewing items currently In Review by Validators — read-only.</span>
          <button className="btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => navigate('/validation')}>Show All</button>
        </div>
      )}
      {effectiveFilter === 'closed' && (
        <div style={{ padding: '10px 16px', marginBottom: 12, background: 'rgba(76,175,80,0.08)', border: '1px solid var(--ok)', borderRadius: 6, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: 'var(--ok)', fontWeight: 600 }}>Viewing closed items — read-only.</span>
          <button className="btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => navigate('/validation')}>Show All</button>
        </div>
      )}
      {effectiveFilter === 'pending_approval' && isSeniorValidator && (
        <div style={{ padding: '10px 16px', marginBottom: 12, background: 'rgba(124,58,237,0.08)', border: '1px solid #7c3aed', borderRadius: 6, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: '#7c3aed', fontWeight: 600 }}>Viewing items submitted for Senior Validator approval.</span>
          <button className="btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => navigate('/validation')}>Show All</button>
        </div>
      )}

      {/* Status-grouped table */}
      {(() => {
        const statusOrder = ['rejected', 'in_review', 'returned', 'pending_approval', 'pending', 'closed'];
        const groups = statusOrder
          .map(s => ({ status: s, items: displayedItems.filter(i => i.status === s) }))
          .filter(g => g.items.length > 0);

        if (displayedItems.length === 0) {
          return (
            <div className="panel">
              <div className="small" style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>
                {isSeniorValidator && effectiveFilter === 'pending_approval' && !statusFilter
                  ? 'No items are pending approval at this time.'
                  : isFiltered ? 'No items match this filter.' : 'No validations found.'}
              </div>
            </div>
          );
        }

        return groups.map(({ status, items: groupItems }) => {
          const col = STATUS_COLOR[status] ?? 'var(--muted)';
          const label = STATUS_LABEL[status] ?? status;

          return (
            <div key={status} style={{ marginBottom: 20 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '6px 12px', marginBottom: 6,
                borderLeft: `4px solid ${col}`,
                background: `${col}0f`,
                borderRadius: '0 6px 6px 0',
              }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: col, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  {label}
                </span>
                <span style={{
                  fontSize: 11, fontWeight: 700,
                  background: col, color: '#fff',
                  borderRadius: 10, padding: '1px 7px', lineHeight: 1.6,
                }}>
                  {groupItems.length}
                </span>
              </div>

              <div className="panel" style={{ marginBottom: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 44 }}>Q#</th>
                      <th style={{ width: 80 }}>Respondent</th>
                      <th style={{ width: 140 }}>Thematic Area</th>
                      <th>Requirement</th>
                      <th style={{ width: 90 }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupItems.map(v => {
                      const statusCol = STATUS_COLOR[v.status] ?? 'var(--muted)';
                      const isActionable = v.status !== 'pending';
                      const isPrimary = v.status === 'pending_approval';
                      const btnLabel = v.status === 'closed' || v.status === 'returned' || (v.status === 'in_review' && isSeniorValidator) ? 'View' : 'Review';

                      return (
                        <tr key={v.id} style={{ borderLeft: `3px solid ${statusCol}` }}>
                          <td style={{ fontWeight: 700, color: statusCol, fontSize: 13 }}>
                            {v.item_number ?? '—'}
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                              {v.bu_code ? (
                                <span style={{
                                  fontSize: 12, fontWeight: 700,
                                  padding: '3px 8px', borderRadius: 4,
                                  background: 'var(--accent)18', color: 'var(--accent)',
                                  border: '1px solid var(--accent)44',
                                  alignSelf: 'flex-start',
                                }}>
                                  {buName(v.bu_code)}
                                </span>
                              ) : (
                                <span style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>—</span>
                              )}
                              {v.material_risk && (
                                <span style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>{v.material_risk}</span>
                              )}
                            </div>
                          </td>
                          <td className="small" style={{ color: 'var(--muted)' }}>{v.thematic_area ?? '—'}</td>
                          <td>
                            <div style={{ fontSize: 13, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                              {v.requirement ?? '—'}
                            </div>
                            {multiCycle && (
                              <div style={{ marginTop: 4 }}>
                                <span style={{ fontSize: 11, color: 'var(--muted)' }}>{v.cycleName}</span>
                              </div>
                            )}
                          </td>
                          <td>
                            {isActionable ? (
                              <button
                                className={`btn${isPrimary ? ' primary' : ''}`}
                                onClick={() => navigate(`/validation/${v.id}`, { state: { cycleId: v.cycleId } })}
                                style={{ fontSize: 12, padding: '4px 10px' }}
                              >
                                {btnLabel}
                              </button>
                            ) : (
                              <span className="small" style={{ color: 'var(--muted)' }}>Waiting</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        });
      })()}
    </div>
  );
}
