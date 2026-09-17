/**
 * Strategy hooks.
 *
 *   useStrategyEngine(tf) — starts/retargets the engine for the whole app
 *   useSignals()          — the signal log (newest first)
 *   useSignalSummary()    — the Dashboard's "active / today" counters
 *   useSymbolSignal(sym)  — the latest signal for one pair (scanner row tag)
 *   useWatchLevel(sym)    — the live EMA level (chart overlay, pair page)
 *   useTouchAnalysis(...) — EMA + touches for the candles a chart already has
 *   useTradePlan(signal)  — ATR stop, target and lot size for one touch
 */
import { useEffect, useMemo } from 'react';
import { STRATEGY_CONFIG } from '../config/strategy';
import { TIMEFRAME_SECONDS, type Timeframe } from '../config/timeframes';
import { analyseEma50Touch, planFromTouch, strategyEngine, touchTimeMs } from '../services/strategy';
import type { TouchAnalysis, TouchSignal, TradePlan, WatchLevel } from '../services/strategy';
import type { Candle } from '../services/marketData';
import type { RateLookup } from '../lib/positionSize';
import { useAccount } from '../state/accountStore';
import { useMarketStore } from '../state/marketStore';
import { useSignalStore } from '../state/signalStore';

/** Runs the engine for as long as the app is mounted, following the timeframe. */
export function useStrategyEngine(timeframe: Timeframe): void {
  useEffect(() => {
    strategyEngine.setTimeframe(timeframe);
  }, [timeframe]);

  useEffect(() => () => strategyEngine.stop(), []);
}

export const useSignals = (): TouchSignal[] => useSignalStore((s) => s.signals);
export const useStrategyStatus = () => useSignalStore((s) => s.status);
export const useLastScanAt = () => useSignalStore((s) => s.lastScanAt);
export const useScanProgress = () => ({
  scanned: useSignalStore((s) => s.scannedSymbols),
  total: useSignalStore((s) => s.totalSymbols),
});
export const useWatchLevel = (symbol: string): WatchLevel | undefined =>
  useSignalStore((s) => s.levels[symbol]);
export const useStrategyNotice = (symbol: string): string | undefined =>
  useSignalStore((s) => s.notices[symbol]);

/** Start of the current day in the user's timezone — "signals today" is local. */
function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface SignalSummary {
  /** Pairs sitting in the EMA band right now. */
  active: number;
  /** Touches detected since local midnight. */
  today: number;
  /** Most recent signal, whatever its age. */
  latest: TouchSignal | null;
}

export function useSignalSummary(): SignalSummary {
  const signals = useSignals();
  const levels = useSignalStore((s) => s.levels);
  return useMemo(() => {
    const dayStart = startOfToday(Date.now());
    const cutoff = Date.now() - STRATEGY_CONFIG.liveSignalTtlMs;
    const active = Object.values(levels).filter((l) => l.side === 'inside' && l.updatedAt >= cutoff).length;
    return {
      active,
      today: signals.filter((s) => touchTimeMs(s) >= dayStart).length,
      latest: signals[0] ?? null,
    };
  }, [signals, levels]);
}

/**
 * EMA + touches for one chart's candle window.
 *
 * Deliberately recomputed from the candles the chart already holds rather
 * than read from the store: the overlay then always matches the bars on
 * screen, and it costs no extra provider request.
 */
export function useTouchAnalysis(symbol: string, timeframe: Timeframe, candles: Candle[]): TouchAnalysis {
  return useMemo(() => analyseEma50Touch(candles, symbol, timeframe), [candles, symbol, timeframe]);
}

/**
 * Latest signal for one pair, for the scanner row badge — but only while it
 * is still current. A touch from twelve hours ago is history, not a live
 * alert, and badging every row permanently would make the column meaningless.
 * "Current" = within `freshBars` bars of the timeframe it fired on.
 */
export function useSymbolSignal(symbol: string, freshBars = 3): TouchSignal | undefined {
  const signals = useSignals();
  return useMemo(() => {
    const latest = signals.find((s) => s.symbol === symbol);
    if (!latest) return undefined;
    const window = TIMEFRAME_SECONDS[latest.timeframe] * freshBars * 1000;
    return Date.now() - touchTimeMs(latest) <= window ? latest : undefined;
  }, [signals, symbol, freshBars]);
}

/**
 * The order ticket for a touch: ATR-based stop, R-multiple target and the
 * lot size that risks exactly the configured percentage of the account.
 *
 * Live quotes are passed in as the USD conversion source, so a cross like
 * EUR/GBP can be sized from the GBP/USD rate the scanner already holds.
 */
export function useTradePlan(signal: TouchSignal | null | undefined): TradePlan | null {
  const balance = useAccount((a) => a.balance);
  const riskPct = useAccount((a) => a.riskPct);
  const quotes = useMarketStore((s) => s.quotes);

  return useMemo(() => {
    if (!signal) return null;
    const lookup: RateLookup = (sym) => quotes[sym]?.price ?? null;
    return planFromTouch(signal, { balance, riskPct }, lookup);
  }, [signal, balance, riskPct, quotes]);
}
