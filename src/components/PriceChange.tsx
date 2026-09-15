import { formatPct } from '../lib/format';

/** Signed % change with direction arrow. Red is used only for negatives. */
export function PriceChange({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className="change muted">—</span>;
  }
  const cls = value > 0 ? 'pos' : value < 0 ? 'neg' : 'muted';
  return (
    <span className={`change ${cls}`}>
      {value !== 0 && (
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <path d={value > 0 ? 'M4 1l3.5 5h-7z' : 'M4 7L.5 2h7z'} fill="currentColor" />
        </svg>
      )}
      {formatPct(value)}
    </span>
  );
}
