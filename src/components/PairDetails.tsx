import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Timeframe } from '../config/timeframes';
import { useCandles } from '../hooks/useCandles';
import { useNow } from '../hooks/useNow';
import { useChartIndicators } from '../hooks/useChartIndicators';
import { formatNumber, formatPrice } from '../lib/format';
import { formatAgo } from '../lib/time';
import { useIchimokuAnalysis, useStrategyNotice, useTradePlan } from '../hooks/useSignals';
import { pipSize } from '../lib/pips';
import { futureCloudZone, minBars, signalMarkers, zoneStrength } from '../services/strategy';
import { CloudZonePanel } from './CloudZonePanel';
import { useMarketStore } from '../state/marketStore';
import { CandlestickChart } from './CandlestickChart';
import { EmptyState } from './EmptyState';
import { MarketStatus } from './MarketStatus';
import { PriceChange } from './PriceChange';
import { IchimokuPanel } from './IchimokuPanel';
import { SignalTable } from './SignalTable';
import { TimeframeSelector } from './TimeframeSelector';
import { TradePlanCard } from './TradePlanCard';

interface Props {
  symbol: string;
  timeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
}

export function PairDetails({ symbol, timeframe, onTimeframeChange }: Props) {
  const quote = useMarketStore((s) => s.quotes[symbol]);
  const status = useMarketStore((s) => s.status);
  const provider = useMarketStore((s) => s.provider.label);
  const bidAsk = useMarketStore((s) => s.provider.capabilities.bidAsk);
  const symbolError = useMarketStore((s) => s.symbolErrors[symbol]);
  const { status: chartStatus, candles, error, fetchedAt, reload } = useCandles(symbol, timeframe);
  const indicators = useChartIndicators(candles);
  const now = useNow();
  const [showIchimoku, setShowIchimoku] = useState(true);
  const live = status === 'ONLINE';

  /**
   * The strategy reads the SAME candles the chart is drawing, so what the
   * panel says and what you can see never disagree — and it costs no extra
   * provider request. The chart's own overlays stay on useChartIndicators:
   * a price chart must still render when the strategy has nothing to say.
   */
  const analysis = useIchimokuAnalysis(symbol, timeframe, candles);
  const latest = analysis.signals.at(-1) ?? null;
  const plan = useTradePlan(latest);
  const strategyNotice = useStrategyNotice(symbol);
  const markers = useMemo(() => signalMarkers(analysis.signals, symbol, timeframe), [analysis.signals, symbol, timeframe]);

  // Distance to Kijun right now, from the same bars the chart is showing.
  const level = analysis.level;
  const distancePips = level && quote ? (quote.price - level.kijun) / pipSize(symbol) : null;
  const bandPips = level ? level.band / pipSize(symbol) : null;
  const atTheLevel =
    level !== null && distancePips !== null && bandPips !== null && Math.abs(distancePips) <= bandPips;

  return (
    <>
      <Link to={`/?tf=${timeframe}`} className="back-link">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        </svg>
        Back to scanner
      </Link>

      <section className="pair-hero">
        <div>
          <h1>{symbol}</h1>
          <div className="hero-price">
            <span className={`num${live ? '' : ' muted'}`}>{quote ? formatPrice(symbol, quote.price) : '—'}</span>
            {quote && <PriceChange value={quote.changePct} />}
            {quote && !live && <span className="tag warn">STALE</span>}
            {quote?.marketOpen === false && live && <span className="tag">MARKET CLOSED</span>}
          </div>
          <div className="panel-sub" style={{ marginTop: 8 }}>
            Updated {formatAgo(quote?.timestamp ?? null, now)} via {provider}
          </div>
        </div>

        <dl className="quote-grid">
          <div>
            <dt>Bid</dt>
            <dd>{formatPrice(symbol, quote?.bid)}</dd>
          </div>
          <div>
            <dt>Ask</dt>
            <dd>{formatPrice(symbol, quote?.ask)}</dd>
          </div>
          <div>
            <dt>Spread</dt>
            <dd>{quote?.spreadPips != null ? `${formatNumber(quote.spreadPips, 1)} pips` : '—'}</dd>
          </div>
          <div>
            <dt>24H change</dt>
            <dd><PriceChange value={quote?.changePct} /></dd>
          </div>
        </dl>
      </section>

      {symbolError && (
        <div className="banner danger" role="alert">
          <div className="banner-body">
            <strong>{symbol} is unavailable</strong>
            {symbolError}
          </div>
        </div>
      )}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">Price chart</h2>
            <span className="panel-sub">
              {bidAsk ? 'Mid-price candles, times in UTC' : 'Candles, times in UTC'}
              {showIchimoku ? ' · Ichimoku overlay' : ''}
            </span>
          </div>
          <div className="page-head-aside">
            <label className="overlay-toggle">
              <input type="checkbox" checked={showIchimoku} onChange={(e) => setShowIchimoku(e.target.checked)} />
              Ichimoku
            </label>
            <TimeframeSelector value={timeframe} onChange={onTimeframeChange} label="Chart timeframe" />
          </div>
        </div>

        <div className="chart-box">
          <CandlestickChart
            symbol={symbol}
            timeframe={timeframe}
            candles={candles}
            markers={markers}
            ichimoku={indicators.ichimoku ?? undefined}
            showIchimoku={showIchimoku}
          />
          {chartStatus === 'LOADING' && (
            <div className="chart-overlay">
              <MarketStatus status="LOADING" />
            </div>
          )}
          {chartStatus === 'ERROR' && (
            <div className="chart-overlay">
              <EmptyState icon="plug" title="Chart data unavailable" compact action={<button className="btn" onClick={reload}>Load again</button>}>
                {error}
              </EmptyState>
            </div>
          )}
          {chartStatus === 'EMPTY' && (
            <div className="chart-overlay">
              <EmptyState title="No candles for this timeframe" compact>
                {provider} returned no {timeframe} candles for {symbol}.
              </EmptyState>
            </div>
          )}
        </div>

        <div className="chart-foot">
          <span>
            {candles.length ? `${candles.length} candles on ${timeframe}` : 'No candles loaded'}
            {error && chartStatus === 'READY' && <span className="neg"> (last refresh failed: {error})</span>}
          </span>
          <span>
            Chart refreshed {formatAgo(fetchedAt, now)}{' '}
            <button className="inline-link" onClick={reload} disabled={chartStatus === 'LOADING'}>
              Refresh
            </button>
          </span>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">The Ichimoku system</h2>
            <span className="panel-sub">
              Two entries, from OANDA's guide: a <strong>Kumo breakout</strong> when price leaves the cloud and the
              cloud ahead turns with it, and a <strong>Tenkan/Kijun pullback</strong> when price already clear of
              the cloud comes back to the lines and closes through Kijun. Chikou validates both.{' '}
              <strong>One trade at a time</strong>: once a signal fires, this pair reports nothing further until
              price reaches that trade's stop or target.
            </span>
          </div>
          {level?.openTrade ? (
            <span
              className="tag"
              title="One trade per pair. This pair stays quiet until the trade reaches its stop or its target."
            >
              IN A TRADE
            </span>
          ) : level?.pending ? (
            <span className="tag pos" title="A setup is part-formed on this pair and waiting for its confirmation">
              {level.pending === 'breakout' ? 'BREAK PENDING' : 'PULLBACK PENDING'}
            </span>
          ) : null}
        </div>

        {level ? (
          <>
            <dl className="quote-grid panel-body">
              <div>
                <dt>Kijun-sen</dt>
                <dd className="num">{formatPrice(symbol, level.kijun)}</dd>
              </div>
              <div>
                <dt>Distance to Kijun</dt>
                <dd className={`num${atTheLevel ? ' pos' : ''}`}>
                  {distancePips === null
                    ? '—'
                    : `${distancePips > 0 ? '+' : '−'}${formatNumber(Math.abs(distancePips), 1)} pips`}
                </dd>
              </div>
              <div>
                <dt>Kumo side</dt>
                <dd className={level.direction === 'LONG' ? 'pos' : level.direction === 'SHORT' ? 'neg' : 'muted'}>
                  {level.side.toUpperCase()}
                  {level.direction === null && (
                    <span className="muted" title="Inside the cloud there is no trend to pull back into">
                      {' '}· no trade
                    </span>
                  )}
                </dd>
              </div>
              <div>
                {/* Two separate facts, not one. A pair can be in a setup and
                    already have fired on it, or be armed and nowhere near one;
                    collapsing them into a single word gets it wrong in both
                    directions. */}
                <dt>State</dt>
                <dd
                  className="muted"
                  title={
                    level.openTrade
                      ? 'One trade per pair: no new signal here until this one hits its stop or target'
                      : 'A setup is part-formed and waiting for the event that completes it'
                  }
                >
                  {level.openTrade
                    ? `IN A TRADE — ${level.openTrade.direction}, since the ${formatPrice(symbol, level.openTrade.entry)} close`
                    : level.pending === null
                      ? 'WATCHING'
                      : level.pending === 'breakout'
                        ? 'BREAK — waiting for the span twist'
                        : 'PULLBACK — waiting for a close through Kijun'}
                </dd>
              </div>
            </dl>
            <SignalTable
              signals={analysis.signals.slice().reverse()}
              limit={10}
              emptyHint={
                level.openTrade
                  ? 'A trade is running on this pair. The next signal comes after it reaches its stop or target.'
                  : `No breakout or pullback in the last ${candles.length} ${timeframe} candles.`
              }
            />
          </>
        ) : (
          <EmptyState title="Not enough history" compact>
            {strategyNotice ??
              `A cloud in effect plus its 26-bar range needs at least ${minBars()} ${timeframe} candles; ${candles.length} loaded.`}
          </EmptyState>
        )}
      </section>

      {latest && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2 className="panel-title">Trade plan</h2>
              <span className="panel-sub">
                From the most recent signal. Entry at the close of the bar that completed the setup; the stop
                sits just beyond the structure the entry is based on — Kijun-sen for a pullback, the far cloud
                edge for a breakout — and the target is twice that risk, sized off the balance and risk % the
                calculator uses. Once the trade is <strong>10 pips ahead the stop moves to a pip past the
                entry</strong>, so from then on it cannot cost anything. The <strong>exit is ours</strong>: the
                article names Kijun and the Kumo as support and resistance, but gives no reward multiple and no
                break-even rule.
              </span>
            </div>
          </div>
          <TradePlanCard signal={latest} plan={plan} />
        </section>
      )}

      {latest && indicators.ichimoku && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2 className="panel-title">Why it fired</h2>
              <span className="panel-sub">
                The conditions this entry required, in the article's own terms. A breakout and a pullback do not
                have the same ones, or the same number of them.
              </span>
            </div>
          </div>
          <IchimokuPanel signal={latest} series={indicators.ichimoku} candles={candles} />
        </section>
      )}

      {indicators.ichimoku && (
        <CloudZonePanel
          symbol={symbol}
          zone={futureCloudZone(candles, indicators.ichimoku, symbol)}
          rangePips={level ? level.range / pipSize(symbol) : null}
          strength={zoneStrength}
        />
      )}

    </>
  );
}
