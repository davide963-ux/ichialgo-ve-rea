import { KumoGlyph } from './KumoMark';
import {
  ICHIMOKU_CHECKS,
  directionOf,
  explainContext,
  type IchimokuContext,
  type TouchSignal,
} from '../services/strategy';

/**
 * Ichimoku agreement for one touch, as a score out of 5 with the individual
 * checks in the tooltip. Green when the cloud agrees with the touch's
 * direction, grey when it does not — the signal is never hidden either way.
 */
export function IchimokuTag({ signal, ctx }: { signal: TouchSignal; ctx: IchimokuContext | null }) {
  if (!ctx) {
    return (
      <span className="muted" title="Ichimoku needs 52 + 26 candles before a cloud is in effect">
        —
      </span>
    );
  }

  const direction = directionOf(signal);
  const title = [`Ichimoku ${ctx.score}/${ICHIMOKU_CHECKS} for a ${direction}:`, ...explainContext(ctx, direction)].join('\n');

  return (
    <span className={`tag ichi-tag${ctx.agrees ? ' pos' : ''}`} title={title}>
      <KumoGlyph />
      {ctx.score}/{ICHIMOKU_CHECKS}
      {ctx.kijunConfluence && (
        <span className="ichi-kijun" title="EMA50 and Kijun-sen mark the same level" aria-label="Kijun confluence">
          K
        </span>
      )}
    </span>
  );
}
