import { ICHIMOKU_CONFLUENCE } from '../config/strategy';
import { formatNumber, formatPrice } from '../lib/format';
import type { IchimokuSeries } from '../lib/indicators';
import type { Candle } from '../services/marketData';
import { ICHIMOKU_CHECKS, directionOf, type TouchSignal } from '../services/strategy';
import { KumoGlyph } from './KumoMark';

/**
 * The five Ichimoku checks for one touch, each shown pass/fail with the
 * numbers behind it, plus the current line values.
 *
 * The checks are read in the direction the touch implies — the same facts
 * score differently for a long and a short, which is the point.
 */
export function IchimokuPanel({
  signal,
  series,
  candles,
}: {
  signal: TouchSignal;
  series: IchimokuSeries;
  candles: Candle[];
}) {
  const ctx = signal.ichimoku;
  const i = candles.length - 1;

  if (!ctx) {
    return (
      <p className="panel-body muted">
        Ichimoku needs {series.config.senkouB} + {series.config.displacement} candles before a cloud is in effect on this
        timeframe; {candles.length} loaded.
      </p>
    );
  }

  const direction = directionOf(signal);
  const long = direction === 'LONG';

  const checks: { label: string; pass: boolean | null; detail: string }[] = [
    {
      label: `Price ${long ? 'above' : 'below'} the Kumo`,
      pass: long ? ctx.kumo === 'above' : ctx.kumo === 'below',
      detail: `actually ${ctx.kumo} the cloud`,
    },
    {
      label: `Cloud ${long ? 'bullish' : 'bearish'}`,
      pass: long ? ctx.cloudBullish : !ctx.cloudBullish,
      detail: `actually Senkou A ${ctx.cloudBullish ? 'above' : 'below'} B${ctx.cloudPips === null ? '' : `, ${formatNumber(ctx.cloudPips, 1)} pips thick`}`,
    },
    {
      label: `Tenkan ${long ? 'above' : 'below'} Kijun`,
      pass: long ? ctx.tenkanAboveKijun : !ctx.tenkanAboveKijun,
      detail: `actually ${ctx.tenkanAboveKijun ? 'above' : 'below'} the base line`,
    },
    {
      label: 'Chikou free',
      pass: ctx.chikouFree,
      detail:
        ctx.chikouFree === null
          ? 'not enough history behind this bar'
          : `lagging line is ${ctx.chikouFree ? 'clear of' : 'blocked by'} the candles ${series.config.displacement} bars back`,
    },
    {
      label: 'EMA50 on Kijun',
      pass: ctx.kijunConfluence,
      detail:
        ctx.kijunDistancePips === null
          ? 'Kijun unavailable'
          : `${formatNumber(ctx.kijunDistancePips, 1)} pips apart (confluent within ${ICHIMOKU_CONFLUENCE.kijunConfluencePips})`,
    },
  ];

  return (
    <div className="panel-body plan-card">
      <div className="plan-head">
        <span className={`tag ichi-tag${ctx.agrees ? ' pos' : ''}`}>
          <KumoGlyph size={12} />
          {ctx.score}/{ICHIMOKU_CHECKS}
        </span>
        <span className="panel-sub">
          {ctx.agrees
            ? `Ichimoku agrees with this ${direction} (threshold ${ICHIMOKU_CONFLUENCE.agreeThreshold}/${ICHIMOKU_CHECKS}).`
            : `Ichimoku does not back this ${direction} — below the ${ICHIMOKU_CONFLUENCE.agreeThreshold}/${ICHIMOKU_CHECKS} threshold.`}
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
      </dl>
    </div>
  );
}
