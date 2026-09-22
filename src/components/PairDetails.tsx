import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Timeframe } from '../config/timeframes';
import { useCandles } from '../hooks/useCandles';
import { useNow } from '../hooks/useNow';
import { CHART_EMA_PERIOD, useChartIndicators } from '../hooks/useChartIndicators';
import { formatNumber, formatPrice } from '../lib/format';
import { formatAgo } from '../lib/time';
import { useMarketStore } from '../state/marketStore';
import { CandlestickChart } from './CandlestickChart';
import { EmptyState } from './EmptyState';
import { MarketStatus } from './MarketStatus';
import { PriceChange } from './PriceChange';
import { TimeframeSelector } from './TimeframeSelector';

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
              {bidAsk ? 'Mid-price candles, times in UTC' : 'Candles, times in UTC'} · EMA{CHART_EMA_PERIOD}
              {showIchimoku ? ' + Ichimoku' : ''} overlay
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
            ema={indicators.ema}
            emaLabel={`EMA${CHART_EMA_PERIOD}`}
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

    </>
  );
}
