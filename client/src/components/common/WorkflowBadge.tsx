

interface WorkflowBadgeProps {
  status: string;
  size?: 'sm' | 'md';
}

export default function WorkflowBadge({ status, size = 'md' }: WorkflowBadgeProps) {
  const lower = status.toLowerCase();

  let bg = 'var(--chip)';
  let color = 'var(--muted)';
  let border = 'var(--line)';

  if (lower === 'draft' || lower === 'pending') {
    bg = 'var(--chip)';
    color = 'var(--muted)';
    border = 'var(--line)';
  } else if (lower === 'in_progress') {
    bg = 'rgba(13,110,253,0.10)';
    color = '#084298';
    border = '#084298';
  } else if (lower === 'published' || lower === 'in_review') {
    bg = 'var(--accent-light)';
    color = 'var(--accent-dark)';
    border = 'var(--accent)';
  } else if (lower === 'returned') {
    bg = 'rgba(220,53,69,0.10)';
    color = '#dc3545';
    border = '#dc3545';
  } else if (lower === 'rejected') {
    bg = 'rgba(220,53,69,0.18)';
    color = '#a61c2e';
    border = '#a61c2e';
  } else if (lower === 'distributed' || lower === 'submitted') {
    bg = 'rgba(255,193,7,0.15)';
    color = '#856404';
    border = 'var(--warn)';
  } else if (lower === 'pending_approval') {
    bg = 'rgba(124,58,237,0.12)';
    color = '#7c3aed';
    border = '#7c3aed';
  } else if (lower === 'closed') {
    bg = 'rgba(40,167,69,0.12)';
    color = 'var(--ok)';
    border = 'var(--ok)';
  }

  const fontSize = size === 'sm' ? '11px' : '12px';
  const padding = size === 'sm' ? '2px 6px' : '4px 8px';

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding,
        borderRadius: '999px',
        border: `1px solid ${border}`,
        background: bg,
        color,
        fontSize,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        textTransform: 'capitalize',
        letterSpacing: '0.3px',
      }}
    >
      {lower === 'pending_approval' ? 'Pending Approval' : lower === 'returned' ? 'Returned' : lower === 'rejected' ? 'Rejected' : status.replace('_', ' ')}
    </span>
  );
}
