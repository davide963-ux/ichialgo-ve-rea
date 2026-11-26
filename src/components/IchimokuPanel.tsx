import { formatNumber, formatPrice } from '../lib/format';
import type { IchimokuSeries } from '../lib/indicators';
import type { Candle } from '../services/marketData';
import type { IchimokuSignal } from '../services/strategy';
import { KumoGlyph } from './KumoMark';

/**
 * Why one signal fired, in the words of the entry that fired it.
 *
 * This panel knows nothing about the conditions. It renders whatever
 * `signal.checks` contains, which is what lets one component explain both of
 * the system's entries — a breakout and a pullback have different conditions
 * and different counts — without a branch, and what stops the UI describing
 * one entry's rules while showing the other's numbers.
 *
 * Optional checks are marked. OANDA's cloud-thickness grade is one: a break
 * through a thin cloud is still a break, "just a weaker one", so it changes
 * how a signal reads rather than whether it exists.
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

  return (
    <div className="panel-body plan-card">
      <div className="plan-head">
        <span className="tag ichi-tag pos">
          <KumoGlyph size={12} />
          {signal.score}/{signal.checksTotal}
        </span>
        <span className="panel-sub">
          {signal.entryType === 'breakout' ? 'Kumo breakout' : 'Tenkan/Kijun pullback'} — rules by OANDA. Every
          check marked required passed, or this signal would not exist.
        </span>
      </div>

      <ul className="check-list">
        {signal.checks.map((c) => (
          <li key={c.label} className={c.pass === true ? 'pos' : c.pass === null ? 'muted' : ''}>
            <span className="check-mark" aria-hidden="true">
              {c.pass === true ? '✓' : c.pass === null ? '·' : '✕'}
            </span>
            <span className="check-label">
              {c.label}
              {!c.required && <span className="muted"> (optional)</span>}
            </span>
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
          <dt>Cloud thickness</dt>
          <dd className="num">{formatNumber(signal.cloudPips, 1)} pips</dd>
        </div>
      </dl>
    </div>
  );
}
