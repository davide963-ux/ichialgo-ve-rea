import type { EntryType, IchimokuSignal } from '../services/strategy';

/**
 * Compact signal chip for the scanner row and the signal table.
 *
 *   ▲ / ▼    the TRADE's direction, which is the cloud's
 *
 * The label names which of the system's two entries fired. A trend starting
 * and a trend resuming are different events and must not read the same —
 * they also take different stops, so conflating them on the row would hide
 * the reason one trade risks four times what another does.
 */
const EVENT: Record<EntryType, string> = {
  breakout: 'KUMO BREAK',
  pullback: 'PULLBACK',
};

const WHAT: Record<EntryType, string> = {
  breakout: 'price left the Kumo and the cloud ahead turned with it — a trend change after consolidation',
  pullback: 'price clear of the Kumo came back to the lines and closed back through Kijun — a trend resuming',
};

export function SignalBadge({ signal, compact = false }: { signal: IchimokuSignal; compact?: boolean }) {
  const long = signal.direction === 'LONG';
  const tone = long ? ' pos' : ' neg';
  const title =
    `${signal.direction} on the ${signal.timeframe} chart: ${WHAT[signal.entryType]}. ` +
    `Stop beyond ${signal.entryType === 'pullback' ? 'Kijun-sen' : 'the far cloud edge'}, ` +
    `${signal.stopPips.toFixed(1)} pips away.`;

  return (
    <span className={`tag signal-tag${tone}`} title={title}>
      <span aria-hidden="true">{long ? '▲' : '▼'}</span>
      {compact ? EVENT[signal.entryType] : `${EVENT[signal.entryType]}, ${signal.kumo} cloud`}
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
