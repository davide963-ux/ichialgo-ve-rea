/**
 * Runs a backtest: fetch history, hand it to the pure engine, keep the state.
 *
 *   run(request)
 *     │
 *     ├─ bars needed = range ÷ timeframe + indicator warm-up
 *     ├─ marketDataService.getCandles(...)   ← one request per run, cached
 *     │     └─ providers return the MOST RECENT n bars, so an old date range
 *     │        may simply not be available; the engine says so in warnings
 *     └─ runBacktest() ─▶ trades · equity · stats
 *
 * The fetch is marked `background` so a backtest can never delay a price
 * update on a credit-metered provider.
 */
import { useCallback, useState } from 'react';
import type { BacktestRequest } from '../components/BacktestPanel';
import { STRATEGY_CONFIG } from '../config/strategy';
import { TIMEFRAME_SECONDS } from '../config/timeframes';
import type { RateLookup } from '../lib/positionSize';
import { marketDataService } from '../services/marketData';
import { toProviderError } from '../services/marketData/types';
import { runBacktest, type BacktestResult } from '../services/strategy';
import { marketStore } from '../state/marketStore';

/** Most providers cap a single history request here. */
const MAX_BARS = 5_000;

export type BacktestStatus = 'IDLE' | 'RUNNING' | 'DONE' | 'ERROR';

export interface BacktestState {
  status: BacktestStatus;
  result: BacktestResult | null;
  error: string | null;
  request: BacktestRequest | null;
}

export function barsForRange(startDate: string, endDate: string, timeframe: keyof typeof TIMEFRAME_SECONDS): number {
  const from = Date.parse(`${startDate}T00:00:00Z`) / 1000;
  const to = Date.parse(`${endDate}T23:59:59Z`) / 1000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return MAX_BARS;
  const span = Math.ceil((to - from) / TIMEFRAME_SECONDS[timeframe]);
  // Indicators need history BEFORE the first tradable bar, so over-fetch.
  const warmup = STRATEGY_CONFIG.ema50Touch.minBars + 80;
  return Math.min(MAX_BARS, Math.max(warmup + 10, span + warmup));
}

export function useBacktest() {
  const [state, setState] = useState<BacktestState>({ status: 'IDLE', result: null, error: null, request: null });

  const run = useCallback(async (request: BacktestRequest) => {
    setState({ status: 'RUNNING', result: null, error: null, request });
    try {
      const count = barsForRange(request.startDate, request.endDate, request.timeframe);
      const candles = await marketDataService.getCandles(request.pair, request.timeframe, count, { background: true });

      // Live quotes are the USD conversion source for crosses like EUR/GBP.
      const quotes = marketStore.get().quotes;
      const lookup: RateLookup = (sym) => quotes[sym]?.price ?? null;

      const result = runBacktest(candles, request.pair, request.timeframe, {
        startingBalance: request.startingBalance,
        riskPct: request.riskPct,
        from: Date.parse(`${request.startDate}T00:00:00Z`) / 1000,
        to: Date.parse(`${request.endDate}T23:59:59Z`) / 1000,
        confluentOnly: request.confluentOnly,
        lookup,
      });
      setState({ status: 'DONE', result, error: null, request });
    } catch (err) {
      setState({ status: 'ERROR', result: null, error: toProviderError(err).message, request });
    }
  }, []);

  return { ...state, run };
}
