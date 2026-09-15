import type { ReactNode } from 'react';

interface Props {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: boolean;
}

export function MetricCard({ label, value, hint, accent }: Props) {
  return (
    <div className={`metric${accent ? ' accent' : ''}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {hint !== undefined && <div className="metric-hint">{hint}</div>}
    </div>
  );
}
