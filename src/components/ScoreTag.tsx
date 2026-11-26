import type { IchimokuSignal } from '../services/strategy';
import { KumoGlyph } from './KumoMark';

/**
 * The confirmation score for one signal, with the individual checks in the
 * tooltip.
 *
 * It reads the signal's own `checks` rather than a fixed set, because the
 * three strategies do not share one. Ours scores out of four Ichimoku
 * confirmations; OANDA's pullback has four conditions of its own, none of
 * which are the same four; their breakout has three plus a thickness grade.
 *
 * Green when every REQUIRED check passed, which is the only state a stored
 * signal can be in — the optional ones grade rather than gate, so a 3/4 with
 * its one failure optional is a real signal, not a near miss.
 */
export function ScoreTag({ signal }: { signal: IchimokuSignal }) {
  const mark = (p: boolean | null) => (p === true ? '✓' : p === null ? '·' : '✕');
  const title = [
    `${signal.score}/${signal.checksTotal} checks for a ${signal.direction}:`,
    ...signal.checks.map((c) => `${mark(c.pass)} ${c.label}${c.required ? '' : ' (optional)'} — ${c.detail}`),
  ].join('\n');

  return (
    <span className="tag ichi-tag pos" title={title}>
      <KumoGlyph />
      {signal.score}/{signal.checksTotal}
    </span>
  );
}
