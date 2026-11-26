import { ICHIMOKU_SIGNAL_CHECKS } from '../config/ichimokuStrategy';
import { explainLines, scoreLabel, type IchimokuSignal } from '../services/strategy';
import { KumoGlyph } from './KumoMark';

/**
 * The confirmation score for one signal, with the individual checks in the
 * tooltip.
 *
 * It is always green, and that is the point. Under the old strategy this was
 * an annotation: a touch was shown whatever Ichimoku said, and the score sat
 * next to it greyed out when the cloud disagreed. The score is now a GATE —
 * a setup below the threshold produces no signal at all — so every score
 * shown here already passed, and colouring some of them as failures would be
 * describing a state the system cannot be in.
 */
export function ScoreTag({ signal }: { signal: IchimokuSignal }) {
  const title = [scoreLabel(signal), ...explainLines(signal)].join('\n');
  return (
    <span className="tag ichi-tag pos" title={title}>
      <KumoGlyph />
      {signal.score}/{ICHIMOKU_SIGNAL_CHECKS}
    </span>
  );
}
