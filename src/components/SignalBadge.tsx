import { detectorFor, type IchimokuSignal } from '../services/strategy';

/**
 * Compact signal chip for the scanner row and the signal table.
 *
 *   ▲ / ▼    the TRADE's direction, which is the cloud's
 *   greyed   fired from a live tick inside an unfinished bar
 *
 * The arrow no longer encodes which side price approached from, because that
 * is exactly what the retired EMA strategy got wrong: a pullback inside a
 * downtrend is still a short.
 *
 * The label names the EVENT, which differs by strategy — a pullback to a line
 * and a break through the cloud are not the same thing and must not read the
 * same. It comes off the signal's own strategy id, so a row cannot be
 * labelled with a rule that did not produce it.
 */
const EVENT: Record<IchimokuSignal['strategy'], string> = {
  'ichimoku-kijun': 'KIJUN',
  'oanda-pullback': 'PULLBACK',
  'oanda-breakout': 'KUMO BREAK',
};

export function SignalBadge({ signal, compact = false }: { signal: IchimokuSignal; compact?: boolean }) {
  const long = signal.direction === 'LONG';
  const tone = signal.source === 'live' ? '' : long ? ' pos' : ' neg';
  const detector = detectorFor(signal.strategy);
  const title =
    `${detector.name} (${detector.source}) — ${signal.direction} on the ${signal.timeframe} chart. ` +
    `Price is ${signal.kumo} the Kumo; ${signal.distancePips.toFixed(1)} pips from Kijun-sen at entry. ` +
    `${signal.source === 'live' ? 'Fired from a live tick inside an unfinished bar.' : ''}`;

  return (
    <span className={`tag signal-tag${tone}`} title={title.trim()}>
      <span aria-hidden="true">{long ? '▲' : '▼'}</span>
      {compact ? EVENT[signal.strategy] : `${EVENT[signal.strategy]}, ${signal.kumo} cloud`}
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
