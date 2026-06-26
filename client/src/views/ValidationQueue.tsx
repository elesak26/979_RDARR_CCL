import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Cycle, Validation, User } from '../types';
import { useBuNames } from '../hooks/useBuNames';

interface EnrichedValidation extends Validation {
  cycleName: string;
  cycleId: number;
}

export default function ValidationQueue() {
  const [items, setItems] = useState<EnrichedValidation[]>([]);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const statusFilter = searchParams.get('status');
  const urlCycleId = searchParams.get('cycle_id') ? Number(searchParams.get('cycle_id')) : 'all';
  const [cycleFilter, setCycleFilter] = useState<number | 'all'>(urlCycleId);
  const [buFilter, setBuFilter] = useState<string | 'all'>('all');
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
      const activeCycles = allCycles.filter(c => c.status === 'distributed');
      setCycles(activeCycles);

      const enriched: EnrichedValidation[] = [];
      await Promise.all(activeCycles.map(async cycle => {
        try {
          const validations = await api.get<Validation[]>(`/cycles/${cycle.id}/validations`);
          for (const v of validations) {
            enriched.push({ ...v, cycleName: cycle.name, cycleId: cycle.id });
          }
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

  if (loading) return <div className="small">Loading validation queue…</div>;
  if (error) return (
    <div style={{ color: 'var(--danger)', padding: 16 }}>
      Error: {error} <button className="btn" onClick={load} style={{ marginLeft: 8 }}>Retry</button>
    </div>
  );

  const isSeniorValidator = currentUser?.role === 'Senior Validator';
  const isValidator = currentUser?.role === 'Validator';
  const effectiveFilter = statusFilter ?? (isSeniorValidator ? 'pending_approval' : null);

  // Step 1: status filter
  const statusFiltered = effectiveFilter
    ? items.filter(i => i.status === effectiveFilter)
    : isValidator && !statusFilter
      ? items.filter(i => i.status === 'in_review' || i.status === 'rejected')
      : items;

  // Step 2: cycles that have items after status filter
  const cyclesWithItems = cycles.filter(c => statusFiltered.some(i => i.cycleId === c.id));

  // Step 3: apply cycle filter
  const cycleFiltered = cycleFilter === 'all'
    ? statusFiltered
    : statusFiltered.filter(i => i.cycleId === cycleFilter);

  // Step 4: BUs present in cycle-filtered set
  const allBuCodes = Array.from(new Set(cycleFiltered.map(i => i.bu_code).filter(Boolean) as string[])).sort();

  // Step 5: apply BU filter
  const displayedItems = buFilter === 'all'
    ? cycleFiltered
    : cycleFiltered.filter(i => i.bu_code === buFilter);

  const countByStatus = (s: string) => items.filter(i => i.status === s).length;

  const statusColor: Record<string, string> = {
    rejected: '#a61c2e',
    in_review: 'var(--warn)',
    returned: '#dc3545',
    pending_approval: '#7c3aed',
    pending: 'var(--muted)',
    closed: 'var(--ok)',
  };

  const statusLabel: Record<string, string> = {
    rejected: 'Rejected',
    in_review: 'Ready',
    returned: 'Returned',
    pending_approval: 'Pending Approval',
    pending: 'Pending',
    closed: 'Closed',
  };

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
            <span style={{ color: '#dc3545', fontWeight: 600 }}>{countByStatus('returned')}</span> returned ·{' '}
            <span style={{ color: '#7c3aed', fontWeight: 600 }}>{countByStatus('pending_approval')}</span> pending approval ·{' '}
            <span style={{ color: 'var(--muted)', fontWeight: 600 }}>{countByStatus('pending')}</span> pending ·{' '}
            <span style={{ color: 'var(--ok)', fontWeight: 600 }}>{countByStatus('closed')}</span> closed
          </span>

          {/* Cycle filter — only cycles with items */}
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

          {/* Respondent filter — only BUs with submitted items */}
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
      {effectiveFilter === 'pending' && isValidator && (
        <div style={{ padding: '10px 16px', marginBottom: 12, background: 'rgba(100,116,139,0.08)', border: '1px solid var(--muted)', borderRadius: 6, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: 'var(--muted)', fontWeight: 600 }}>Viewing items pending BU responses — read-only.</span>
          <button className="btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => navigate('/validation')}>Show All</button>
        </div>
      )}
      {effectiveFilter === 'pending_approval' && isValidator && (
        <div style={{ padding: '10px 16px', marginBottom: 12, background: 'rgba(124,58,237,0.08)', border: '1px solid #7c3aed', borderRadius: 6, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: '#7c3aed', fontWeight: 600 }}>Viewing items submitted for Senior Validator approval — read-only.</span>
          <button className="btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => navigate('/validation')}>Show All</button>
        </div>
      )}

      {/* Table */}
      <div className="panel">
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
            {displayedItems.length === 0 && (
              <tr>
                <td colSpan={5} className="small" style={{ textAlign: 'center', padding: 32 }}>
                  {isSeniorValidator && effectiveFilter === 'pending_approval' && !statusFilter
                    ? 'No items are pending approval at this time.'
                    : isFiltered ? 'No items match this filter.' : 'No validations found. Make sure there is a distributed cycle.'}
                </td>
              </tr>
            )}
            {displayedItems.map(v => {
              const statusCol = statusColor[v.status] ?? 'var(--muted)';
              const isActionable = v.status !== 'pending';
              const isPrimary = (v.status === 'in_review' && !isSeniorValidator) || (v.status === 'rejected' && isValidator) || v.status === 'pending_approval';
              const btnLabel = v.status === 'closed' || v.status === 'returned' || (v.status === 'in_review' && isSeniorValidator) ? 'View' : 'Review';

              return (
                <tr key={v.id} style={{ borderLeft: `3px solid ${statusCol}` }}>
                  <td style={{ fontWeight: 700, color: statusCol, fontSize: 13 }}>
                    {v.item_number ?? '—'}
                  </td>
                  <td>
                    {v.bu_code ? (
                      <span style={{
                        fontSize: 12, fontWeight: 700,
                        padding: '3px 8px', borderRadius: 4,
                        background: 'var(--accent)18', color: 'var(--accent)',
                        border: '1px solid var(--accent)44',
                      }}>
                        {buName(v.bu_code)}
                      </span>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>—</span>
                    )}
                  </td>
                  <td className="small" style={{ color: 'var(--muted)' }}>{v.thematic_area ?? '—'}</td>
                  <td>
                    <div style={{ fontSize: 13, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {v.requirement ?? '—'}
                    </div>
                    <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
                        color: statusCol, background: `${statusCol}18`,
                        padding: '2px 6px', borderRadius: 4,
                      }}>
                        {statusLabel[v.status] ?? v.status}
                      </span>
                      {cyclesWithItems.length > 1 && cycleFilter === 'all' && (
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{v.cycleName}</span>
                      )}
                    </div>
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
}
