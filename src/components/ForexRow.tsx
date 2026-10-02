import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { getPair } from '../config/pairs';
import type { Timeframe } from '../config/timeframes';
import { formatNumber, formatPrice } from '../lib/format';
import { formatClock } from '../lib/time';
import { useSymbolSignal } from '../hooks/useSignals';
import { useMarketStore } from '../state/marketStore';
import { PriceChange } from './PriceChange';
import { SignalBadge } from './SignalBadge';

interface Props {
  symbol: string;
  timeframe: Timeframe;
  onOpen: (symbol: string) => void;
}

/**
 * One scanner row. Subscribes only to its own quote, so a tick on
 * EUR/USD re-renders one row — not the whole table.
 */
export const ForexRow = memo(function ForexRow({ symbol, timeframe, onOpen }: Props) {
  const quote = useMarketStore((s) => s.quotes[symbol]);
  const live = useMarketStore((s) => s.status === 'ONLINE');
  const loading = useMarketStore((s) => s.status === 'LOADING');
  const symbolError = useMarketStore((s) => s.symbolErrors[symbol]);
  const signal = useSymbolSignal(symbol);
  const pair = getPair(symbol);

  // Brief green/red flash on price change.
  const prev = useRef<number | undefined>(undefined);
  const [tick, setTick] = useState<'' | 'tick-up' | 'tick-down'>('');
  useEffect(() => {
    if (!quote) return;
    const p = prev.current;
    prev.current = quote.price;
    if (p === undefined || p === quote.price) return;
    setTick(quote.price > p ? 'tick-up' : 'tick-down');
    const t = setTimeout(() => setTick(''), 450);
    return () => clearTimeout(t);
  }, [quote]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(symbol);
    }
  };

  const stale = !!quote && !live;
  const closed = quote?.marketOpen === false;
  const sk = <span className="skeleton" />;
  const blank = loading && !quote ? sk : <span className="muted">—</span>;

  return (
    <tr
      className={`row-link${stale ? ' row-stale' : ''}`}
      tabIndex={0}
      role="link"
      aria-label={`Open ${symbol} details`}
      onClick={() => onOpen(symbol)}
      onKeyDown={onKey}
    >
      <td>
        <div className="pair-cell">
          <span className="pair-flag" aria-hidden="true">{pair.base}</span>
          <span className="pair-name">{symbol}</span>
          {signal && <SignalBadge signal={signal} compact />}
          {symbolError && <span className="tag warn" title={symbolError}>UNAVAILABLE</span>}
          {stale && <span className="tag warn" title="Connection lost — last known value">STALE</span>}
          {!stale && closed && <span className="tag" title="Market closed — last traded price">CLOSED</span>}
        </div>
      </td>
      <td className={`price-cell ${tick}`}>{quote ? formatPrice(symbol, quote.price) : blank}</td>
      <td className="num">{quote ? formatPrice(symbol, quote.bid) : blank}</td>
      <td className="num">{quote ? formatPrice(symbol, quote.ask) : blank}</td>
      <td className="num">{quote ? formatNumber(quote.spreadPips, 1) : blank}</td>
      <td>{quote ? <PriceChange value={quote.changePct} /> : blank}</td>
      <td><span className="tag tf-tag">{timeframe}</span></td>
      <td className="num muted">{quote ? formatClock(quote.timestamp) : blank}</td>
    </tr>
  );
});
