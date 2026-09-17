import type { TouchSignal } from '../services/strategy';

/**
 * Compact signal chip used in the scanner row and the signal table.
 *
 *   ▲ EMA50  — pullback from above (potential long), trend agrees
 *   ▼ EMA50  — rally from below (potential short), trend agrees
 *   greyed   — counter-trend or undecided touch
 */
export function SignalBadge({ signal, compact = false }: { signal: TouchSignal; compact?: boolean }) {
  const tone = signal.counterTrend || signal.bias === 'neutral' ? '' : signal.bias === 'long' ? ' pos' : ' neg';
  const arrow = signal.approach === 'above' ? '▲' : '▼';
  const title =
    `EMA50 touched on the ${signal.timeframe} chart — price came from ${signal.approach}, ` +
    `${signal.distancePips.toFixed(1)} pips from the line (band ±${signal.tolerancePips.toFixed(1)}). ` +
    `EMA trend: ${signal.trend}. ${signal.counterTrend ? 'Against the trend.' : `Bias: ${signal.bias}.`}`;

  return (
    <span className={`tag signal-tag${tone}`} title={title}>
      <span aria-hidden="true">{arrow}</span>
      {compact ? 'EMA50' : `EMA50 ${signal.approach === 'above' ? 'from above' : 'from below'}`}
    </span>
  );
}

const OUTCOME_LABEL: Record<TouchSignal['outcome'], string> = {
  bounce: 'BOUNCE',
  cross: 'CROSS',
  inside: 'INSIDE',
  pending: 'FORMING',
};

const OUTCOME_HINT: Record<TouchSignal['outcome'], string> = {
  bounce: 'The bar closed back on the side it came from — the EMA held',
  cross: 'The bar closed through the EMA — the level broke',
  inside: 'The bar closed inside the tolerance band — undecided',
  pending: 'The bar is still forming, or the touch came from a live tick',
};

export function OutcomeTag({ outcome }: { outcome: TouchSignal['outcome'] }) {
  const tone = outcome === 'bounce' ? ' pos' : outcome === 'cross' ? ' neg' : '';
  return (
    <span className={`tag${tone}`} title={OUTCOME_HINT[outcome]}>
      {OUTCOME_LABEL[outcome]}
    </span>
  );
}
