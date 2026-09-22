/**
 * Runs a backtest: fetch history, hand it to the pure harness, keep the state.
 *
 *   run(request)
 *     │
 *     ├─ bars needed = range ÷ timeframe + indicator warm-up
 *     ├─ marketDataService.getCandles(...)   ← one request per run, cached
 *     │     └─ providers return the MOST RECENT n bars, so an old date range
 *     │        may simply not be available
 *     └─ runBacktest() ─▶ trades · report
 *
 * The fetch is marked `background` so a backtest can never delay a price
 * update on a credit-metered provider.
 *
 * There is ONE backtest now. The previous version carried two, because two
 * strategies existed and each had its own harness and its own result shape;
 * the hook had to hold both and every consumer had to branch on which was
 * non-null. A single `analyse()` seam removes that split entirely.
 */
import { useCallback, useState } from 'react';
import type { BacktestRequest } from '../components/BacktestPanel';
import { TIMEFRAME_SECONDS } from '../config/timeframes';
import { marketDataService } from '../services/marketData';
import { toProviderError } from '../services/marketData/types';
import { MIN_BARS, runBacktest, type BacktestResult } from '../services/strategy';

/** Most providers cap a single history request here. */
const MAX_BARS = 5_000;

export type BacktestStatus = 'IDLE' | 'RUNNING' | 'DONE' | 'ERROR';

export interface BacktestState {
  status: BacktestStatus;
  result: BacktestResult | null;
  error: string | null;
  request: BacktestRequest | null;
}

/**
 * How many bars to fetch for a date range.
 *
 * Indicators need history BEFORE the first tradable bar, so this deliberately
 * over-fetches by the strategy's warm-up plus a margin. Under-fetching does
 * not fail loudly — it silently shortens the testable range, which is worse.
 */
export function barsForRange(
  startDate: string,
  endDate: string,
  timeframe: keyof typeof TIMEFRAME_SECONDS,
): number {
  const from = Date.parse(`${startDate}T00:00:00Z`) / 1000;
  const to = Date.parse(`${endDate}T23:59:59Z`) / 1000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return MAX_BARS;
  const span = Math.ceil((to - from) / TIMEFRAME_SECONDS[timeframe]);
  const warmup = MIN_BARS + 40;
  return Math.min(MAX_BARS, Math.max(warmup + 10, span + warmup));
}

export function useBacktest() {
  const [state, setState] = useState<BacktestState>({
    status: 'IDLE',
    result: null,
    error: null,
    request: null,
  });

  const run = useCallback(async (request: BacktestRequest) => {
    setState({ status: 'RUNNING', result: null, error: null, request });
    try {
      const count = barsForRange(request.startDate, request.endDate, request.timeframe);
      const candles = await marketDataService.getCandles(request.pair, request.timeframe, count, { background: true });

      // No lot sizing here: results are measured in R, which is independent of
      // position size by construction. The balance and risk percentage the
      // form collects are applied when the numbers are DISPLAYED, so changing
      // them never requires re-running the test.
      const result = runBacktest(candles, {
        symbol: request.pair,
        timeframe: request.timeframe,
        from: Date.parse(`${request.startDate}T00:00:00Z`) / 1000,
        to: Date.parse(`${request.endDate}T23:59:59Z`) / 1000,
      });
      setState({ status: 'DONE', result, error: null, request });
    } catch (err) {
      setState({ status: 'ERROR', result: null, error: toProviderError(err).message, request });
    }
  }, []);

  return { ...state, run };
}
