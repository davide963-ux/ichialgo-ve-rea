import type { IchimokuSignal } from '../services/strategy';
import { KumoGlyph } from './KumoMark';

/**
 * The confirmation score for one signal, with the individual checks in the
 * tooltip.
 *
 * It reads the signal's own `checks` rather than a fixed set, because the two
 * entries do not share one. A pullback states four conditions; a breakout
 * states three plus a cloud-thickness grade that is explicitly not a gate. So
 * there is no "number of checks" for this strategy, and a component that
 * assumed one would mislabel every signal of the other kind.
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
