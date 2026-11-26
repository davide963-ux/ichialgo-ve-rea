import { ICHIMOKU_SIGNAL_CHECKS, ICHIMOKU_STRATEGY } from '../config/ichimokuStrategy';
import { formatNumber, formatPrice } from '../lib/format';
import type { IchimokuSeries } from '../lib/indicators';
import type { Candle } from '../services/marketData';
import { explainSignal, type IchimokuSignal } from '../services/strategy';
import { KumoGlyph } from './KumoMark';

/**
 * The four confirmations for one signal, each shown pass/fail with the
 * numbers behind it, plus the lines as they stand now.
 *
 * The checks are read in the direction being traded — the same facts score
 * differently for a long and a short, which is the point. What has changed
 * since the previous version of this panel is that the score is a threshold
 * rather than a remark: a setup that does not reach `minScore` never becomes
 * a signal, so there is no "Ichimoku does not back this" state left to show.
 */
export function IchimokuPanel({
  signal,
  series,
  candles,
}: {
  signal: IchimokuSignal;
  series: IchimokuSeries;
  candles: Candle[];
}) {
  const i = candles.length - 1;
  const checks = [
    {
      label: `Price ${signal.direction === 'LONG' ? 'above' : 'below'} the Kumo`,
      pass: true,
      detail: `${signal.kumo} the cloud — this is what set the direction, so it cannot fail`,
    },
    ...explainSignal(signal),
  ];

  return (
    <div className="panel-body plan-card">
      <div className="plan-head">
        <span className="tag ichi-tag pos">
          <KumoGlyph size={12} />
          {signal.score}/{ICHIMOKU_SIGNAL_CHECKS}
        </span>
        <span className="panel-sub">
          The gate is {ICHIMOKU_STRATEGY.minScore}/{ICHIMOKU_SIGNAL_CHECKS}: below it no signal is produced, so
          everything shown here already passed.
        </span>
      </div>

      <ul className="check-list">
        {checks.map((c) => (
          <li key={c.label} className={c.pass === true ? 'pos' : c.pass === null ? 'muted' : ''}>
            <span className="check-mark" aria-hidden="true">
              {c.pass === true ? '✓' : c.pass === null ? '·' : '✕'}
            </span>
            <span className="check-label">{c.label}</span>
            <span className="check-detail muted">{c.detail}</span>
          </li>
        ))}
      </ul>

      <dl className="quote-grid">
        <div>
          <dt>Tenkan-sen (9)</dt>
          <dd className="num">{formatPrice(signal.symbol, series.tenkan[i])}</dd>
        </div>
        <div>
          <dt>Kijun-sen (26)</dt>
          <dd className="num">{formatPrice(signal.symbol, series.kijun[i])}</dd>
        </div>
        <div>
          <dt>Senkou A</dt>
          <dd className="num">{formatPrice(signal.symbol, series.senkouA[i])}</dd>
        </div>
        <div>
          <dt>Senkou B</dt>
          <dd className="num">{formatPrice(signal.symbol, series.senkouB[i])}</dd>
        </div>
        <div>
          {/* The volatility measure. Named so the reader can see that the stop
              is drawn from Ichimoku's own geometry and not from elsewhere. */}
          <dt>26-bar range</dt>
          <dd className="num">{formatNumber(signal.rangePips, 1)} pips</dd>
        </div>
        <div>
          <dt>Off Kijun at entry</dt>
          <dd className="num">{formatNumber(signal.distancePips, 1)} pips</dd>
        </div>
      </dl>
    </div>
  );
}
