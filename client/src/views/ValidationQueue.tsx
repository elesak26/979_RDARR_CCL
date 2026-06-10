import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Cycle, Validation, User } from '../types';
import WorkflowBadge from '../components/common/WorkflowBadge';

interface EnrichedValidation extends Validation {
  cycleName: string;
  cycleId: number;
  allSubmitted: boolean;
}

export default function ValidationQueue() {
  const [items, setItems] = useState<EnrichedValidation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const statusFilter = searchParams.get('status');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [me, cycles] = await Promise.all([
        api.get<User>('/users/me'),
        api.get<Cycle[]>('/cycles'),
      ]);
      setCurrentUser(me);
      const activeCycles = cycles.filter(c => c.status === 'distributed');

      const enriched: EnrichedValidation[] = [];

      await Promise.all(activeCycles.map(async cycle => {
        try {
          const validations = await api.get<Validation[]>(`/cycles/${cycle.id}/validations`);

          for (const v of validations) {
            const allSubmitted = v.status === 'in_review' || v.status === 'pending_approval' || v.status === 'closed';
            enriched.push({
              ...v,
              cycleName: cycle.name,
              cycleId: cycle.id,
              allSubmitted,
            });
          }
        } catch {
          // skip failing cycle
        }
      }));

      // Sort: rejected first, then in_review, then returned, then pending_approval, then pending, then closed
      const order: Record<string, number> = { rejected: 0, in_review: 1, returned: 2, pending_approval: 3, pending: 4, closed: 5 };
      enriched.sort((a, b) => {
        const diff = (order[a.status] ?? 99) - (order[b.status] ?? 99);
        if (diff !== 0) return diff;
        return (a.item_number ?? 0) - (b.item_number ?? 0);
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
  // Validators default to seeing both in_review and rejected (both require action)
  const displayedItems = effectiveFilter
    ? items.filter(i => i.status === effectiveFilter)
    : isValidator && !statusFilter
      ? items.filter(i => i.status === 'in_review' || i.status === 'rejected')
      : items;

  const rejectedCount = items.filter(i => i.status === 'rejected').length;
  const inReviewCount = items.filter(i => i.status === 'in_review').length;
  const returnedCount = items.filter(i => i.status === 'returned').length;
  const pendingApprovalCount = items.filter(i => i.status === 'pending_approval').length;
  const pendingCount = items.filter(i => i.status === 'pending').length;
  const closedCount = items.filter(i => i.status === 'closed').length;

  return (
    <div>
      <div className="topbar" style={{ marginBottom: 16 }}>
        <div className="left">
          <strong style={{ fontSize: 18 }}>Validation Actions</strong>
          {effectiveFilter ? (
            <span className="chip">{displayedItems.length} filtered</span>
          ) : (
            <span className="chip">{items.length} total</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <span className="small">
            <span style={{ color: '#a61c2e', fontWeight: 600 }}>{rejectedCount}</span> rejected ·{' '}
            <span style={{ color: 'var(--warn)', fontWeight: 600 }}>{inReviewCount}</span> ready ·{' '}
            <span style={{ color: '#dc3545', fontWeight: 600 }}>{returnedCount}</span> returned ·{' '}
            <span style={{ color: '#7c3aed', fontWeight: 600 }}>{pendingApprovalCount}</span> pending approval ·{' '}
            <span style={{ color: 'var(--muted)', fontWeight: 600 }}>{pendingCount}</span> pending ·{' '}
            <span style={{ color: 'var(--ok)', fontWeight: 600 }}>{closedCount}</span> closed
          </span>
        </div>
      </div>

      {effectiveFilter === 'in_review' && isSeniorValidator && (
        <div style={{
          padding: '10px 16px', marginBottom: 12,
          background: 'rgba(255,193,7,0.08)',
          border: '1px solid var(--warn)',
          borderRadius: 6, fontSize: 13,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <span style={{ color: 'var(--warn)', fontWeight: 600 }}>
            Viewing items currently In Review by Validators — read-only.
          </span>
          <button className="btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => navigate('/validation')}>
            Show All
          </button>
        </div>
      )}

      {effectiveFilter === 'closed' && isSeniorValidator && (
        <div style={{
          padding: '10px 16px', marginBottom: 12,
          background: 'rgba(76,175,80,0.08)',
          border: '1px solid var(--ok)',
          borderRadius: 6, fontSize: 13,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <span style={{ color: 'var(--ok)', fontWeight: 600 }}>
            Viewing closed items — read-only.
          </span>
          <button className="btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => navigate('/validation')}>
            Show All
          </button>
        </div>
      )}

      {effectiveFilter === 'pending' && isValidator && (
        <div style={{
          padding: '10px 16px', marginBottom: 12,
          background: 'rgba(100,116,139,0.08)',
          border: '1px solid var(--muted)',
          borderRadius: 6, fontSize: 13,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <span style={{ color: 'var(--muted)', fontWeight: 600 }}>
            Viewing items pending BU responses — read-only.
          </span>
          <button className="btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => navigate('/validation')}>
            Show All
          </button>
        </div>
      )}

      {effectiveFilter === 'pending_approval' && isValidator && (
        <div style={{
          padding: '10px 16px', marginBottom: 12,
          background: 'rgba(124,58,237,0.08)',
          border: '1px solid #7c3aed',
          borderRadius: 6, fontSize: 13,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <span style={{ color: '#7c3aed', fontWeight: 600 }}>
            Viewing items submitted for Senior Validator approval — read-only.
          </span>
          <button className="btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => navigate('/validation')}>
            Show All
          </button>
        </div>
      )}

      {effectiveFilter === 'closed' && isValidator && (
        <div style={{
          padding: '10px 16px', marginBottom: 12,
          background: 'rgba(76,175,80,0.08)',
          border: '1px solid var(--ok)',
          borderRadius: 6, fontSize: 13,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <span style={{ color: 'var(--ok)', fontWeight: 600 }}>
            Viewing closed items — read-only.
          </span>
          <button className="btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => navigate('/validation')}>
            Show All
          </button>
        </div>
      )}

      <div className="panel">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 48 }}>Q#</th>
              <th>Thematic Area</th>
              <th>Requirement</th>
              <th style={{ width: 110, textAlign: 'center' }}>All Submitted?</th>
              <th style={{ width: 110 }}>Status</th>
              <th style={{ width: 80 }}>Cycle</th>
              <th style={{ width: 80 }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {displayedItems.length === 0 && (
              <tr>
                <td colSpan={7} className="small" style={{ textAlign: 'center', padding: 32 }}>
                  {isSeniorValidator && effectiveFilter === 'pending_approval' && !statusFilter
                    ? 'No items are pending approval at this time. Validators have not yet submitted any items for your review.'
                    : effectiveFilter ? 'No items match this filter.' : 'No validations found. Make sure there is a distributed cycle.'}
                </td>
              </tr>
            )}
            {displayedItems.map(v => (
              <tr key={`${v.cycleId}-${v.id}`}>
                <td style={{ color: 'var(--muted)', fontWeight: 600 }}>{v.item_number ?? '—'}</td>
                <td className="small">{v.thematic_area ?? '—'}</td>
                <td style={{ maxWidth: 280 }}>
                  <span
                    title={v.requirement}
                    style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 13 }}
                  >
                    {v.requirement ?? '—'}
                  </span>
                </td>
                <td style={{ textAlign: 'center' }}>
                  {v.allSubmitted ? (
                    <span style={{ color: 'var(--ok)', fontWeight: 600, fontSize: 12 }}>✓ Yes</span>
                  ) : (
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>Waiting…</span>
                  )}
                </td>
                <td><WorkflowBadge status={v.status} size="sm" /></td>
                <td className="small">{v.cycleName}</td>
                <td>
                  {(v.status === 'in_review' || v.status === 'rejected' || v.status === 'returned' || v.status === 'pending_approval' || v.status === 'closed') && (
                    <button
                      className={`btn ${(v.status === 'in_review' && !isSeniorValidator) || (v.status === 'rejected' && isValidator) || v.status === 'pending_approval' ? 'primary' : ''}`}
                      onClick={() => navigate(`/validation/${v.id}`, { state: { cycleId: v.cycleId } })}
                      style={{ fontSize: 12, padding: '4px 10px' }}
                    >
                      {v.status === 'closed' || v.status === 'returned' || (v.status === 'in_review' && isSeniorValidator) ? 'View' : 'Review'}
                    </button>
                  )}
                  {v.status === 'pending' && (
                    <span className="small" style={{ color: 'var(--muted)' }}>Waiting</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
