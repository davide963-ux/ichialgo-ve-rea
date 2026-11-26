import type { IchimokuSignal } from '../services/strategy';

/**
 * Compact signal chip for the scanner row and the signal table.
 *
 *   ▲ KIJUN  — price above the Kumo, caught at Kijun: a long
 *   ▼ KIJUN  — price below the Kumo, caught at Kijun: a short
 *   greyed   — fired from a live tick inside an unfinished bar
 *
 * The arrow is the TRADE's direction, which is the cloud's. It no longer
 * encodes which side price approached from, because that is exactly the thing
 * the old strategy got wrong: a pullback inside a downtrend is still a short.
 */
export function SignalBadge({ signal, compact = false }: { signal: IchimokuSignal; compact?: boolean }) {
  const long = signal.direction === 'LONG';
  const tone = signal.source === 'live' ? '' : long ? ' pos' : ' neg';
  const title =
    `${signal.direction} on the ${signal.timeframe} chart: price is ${signal.kumo} the Kumo and pulled back ` +
    `to Kijun-sen, ${signal.distancePips.toFixed(1)} pips from the line. ` +
    `${signal.source === 'live' ? 'Fired from a live tick inside an unfinished bar.' : ''}`;

  return (
    <span className={`tag signal-tag${tone}`} title={title.trim()}>
      <span aria-hidden="true">{long ? '▲' : '▼'}</span>
      {compact ? 'KIJUN' : `Kijun pullback, ${signal.kumo} cloud`}
    </span>
  );
}

/** Where the signal came from: a closed bar, or a tick between scans. */
export function SourceTag({ source }: { source: IchimokuSignal['source'] }) {
  return source === 'live' ? (
    <span className="tag" title="Fired from a live quote inside a bar that had not closed yet">
      LIVE
    </span>
  ) : (
    <span className="tag pos" title="Found on a closed bar, so the entry is that bar's close">
      CLOSED
    </span>
  );
}
