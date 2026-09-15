import type { ReactNode } from 'react';

interface Props {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: 'chart' | 'flask' | 'plug' | 'table';
  compact?: boolean;
}

const ICONS: Record<NonNullable<Props['icon']>, ReactNode> = {
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  flask: <path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3M7 15h10" />,
  plug: <path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5" />,
  table: <path d="M3 5h18v14H3zM3 10h18M3 15h18M9 5v14" />,
};

export function EmptyState({ title, children, action, icon = 'chart', compact }: Props) {
  return (
    <div className={`empty${compact ? ' compact' : ''}`}>
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#39B982" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {ICONS[icon]}
      </svg>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div style={{ marginTop: 10 }}>{action}</div>}
    </div>
  );
}
