import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Timeframe } from '../config/timeframes';
import { useCandles } from '../hooks/useCandles';
import { useNow } from '../hooks/useNow';
import { useChartIndicators } from '../hooks/useChartIndicators';
import { formatNumber, formatPrice } from '../lib/format';
import { formatAgo } from '../lib/time';
import { ICHIMOKU_SIGNAL_CHECKS, ICHIMOKU_STRATEGY } from '../config/ichimokuStrategy';
import { useIchimokuAnalysis, useStrategyNotice, useTradePlan } from '../hooks/useSignals';
import { pipSize } from '../lib/pips';
import { minBars, signalMarkers } from '../services/strategy';
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
            <h2 className="panel-title">Kijun pullback</h2>
            <span className="panel-sub">
              A pullback is price entering a band of ±{bandPips === null ? '—' : formatNumber(bandPips, 1)} pips
              around Kijun-sen while clear of the Kumo. The band is{' '}
              {formatNumber(ICHIMOKU_STRATEGY.touchBand, 2)} of the 26-bar range, so it means the same thing in a
              dead session and a fast one — and that range is the Kijun's own width, not a second indicator.
            </span>
          </div>
          {atTheLevel && <span className="tag pos" title="Price is inside the band right now">IN THE ZONE</span>}
        </div>

        {level ? (
          <>
            <dl className="quote-grid panel-body">
              <div>
                <dt>Kijun-sen</dt>
                <dd className="num">{formatPrice(symbol, level.kijun)}</dd>
              </div>
              <div>
                <dt>Distance</dt>
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
                <dt>State</dt>
                <dd className="muted" title="Armed = ready to signal the next pullback">
                  {level.armed ? 'ARMED' : 'FIRED'}
                </dd>
              </div>
            </dl>
            <SignalTable
              signals={analysis.signals.slice().reverse()}
              limit={10}
              emptyHint={`No Kijun pullback cleared ${ICHIMOKU_STRATEGY.minScore}/${ICHIMOKU_SIGNAL_CHECKS} in the last ${candles.length} ${timeframe} candles.`}
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
                From the most recent signal. Entry at the pullback's close, stop a fraction of the 26-bar range
                away, target twice that — sized off the balance and risk % the calculator uses.
              </span>
            </div>
          </div>
          <TradePlanCard signal={latest} plan={plan} />
        </section>
      )}

      {latest && analysis.ichimoku && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2 className="panel-title">Confirmations</h2>
              <span className="panel-sub">
                Kijun says where; the Kumo says which way; these {ICHIMOKU_SIGNAL_CHECKS} checks decide whether the
                setup is taken at all. Needs {ICHIMOKU_STRATEGY.minScore} of them.
              </span>
            </div>
          </div>
          <IchimokuPanel signal={latest} series={analysis.ichimoku} candles={candles} />
        </section>
      )}

    </>
  );
}
