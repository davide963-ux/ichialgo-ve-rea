/**
 * Loads OHLC candles for (symbol, timeframe) through MarketDataService.
 *
 *   mount / symbol / timeframe change ─▶ LOADING ─▶ fetch ─┬─▶ READY
 *                                                         ├─▶ EMPTY
 *                                                         └─▶ ERROR
 *   every capabilities.candleRefreshMs ─▶ silent refresh (keeps chart, updates bars)
 *   live quote tick ─▶ patch the forming (incomplete) candle's high/low/close
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_CONFIG } from '../config/app';
import { TIMEFRAME_SECONDS, type Timeframe } from '../config/timeframes';
import { marketDataService, type Candle } from '../services/marketData';
import { toProviderError } from '../services/marketData/types';
import { useMarketStore } from '../state/marketStore';

export type CandleStatus = 'LOADING' | 'READY' | 'EMPTY' | 'ERROR';

export interface CandleState {
  status: CandleStatus;
  candles: Candle[];
  error: string | null;
  fetchedAt: number | null;
  reload: () => void;
}

export function useCandles(symbol: string, timeframe: Timeframe): CandleState {
  const [state, setState] = useState<Omit<CandleState, 'reload'>>({ status: 'LOADING', candles: [], error: null, fetchedAt: null });
  const [nonce, setNonce] = useState(0);
  const reqId = useRef(0);
  const quote = useMarketStore((s) => s.quotes[symbol]);
  const live = useMarketStore((s) => s.status === 'ONLINE');

  // Fetch + periodic refresh
  useEffect(() => {
    let cancelled = false;
    const load = async (initial: boolean) => {
      const id = ++reqId.current;
      if (initial) setState({ status: 'LOADING', candles: [], error: null, fetchedAt: null });
      try {
        const candles = await marketDataService.getCandles(symbol, timeframe, APP_CONFIG.chartCandleCount, { force: !initial });
        if (cancelled || id !== reqId.current) return;
        setState({ status: candles.length ? 'READY' : 'EMPTY', candles, error: null, fetchedAt: Date.now() });
      } catch (err) {
        if (cancelled || id !== reqId.current) return;
        const e = toProviderError(err);
        // On a failed background refresh keep the chart, but surface the error.
        setState((prev) =>
          !initial && prev.candles.length
            ? { ...prev, error: e.message }
            : { status: 'ERROR', candles: [], error: e.message, fetchedAt: null },
        );
      }
    };
    void load(true);
    const timer = setInterval(() => void load(false), marketDataService.capabilities.candleRefreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [symbol, timeframe, nonce]);

  // Merge live ticks into the forming candle (real prices only; never invents bars).
  useEffect(() => {
    if (!quote || !live) return;
    setState((prev) => {
      const last = prev.candles[prev.candles.length - 1];
      if (!last || last.complete) return prev;
      const t = Math.floor(quote.timestamp / 1000);
      if (t < last.time || t >= last.time + TIMEFRAME_SECONDS[timeframe]) return prev;
      if (quote.price === last.close) return prev;
      const patched: Candle = {
        ...last,
        close: quote.price,
        high: Math.max(last.high, quote.price),
        low: Math.min(last.low, quote.price),
      };
      return { ...prev, candles: [...prev.candles.slice(0, -1), patched] };
    });
  }, [quote, live, timeframe]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
