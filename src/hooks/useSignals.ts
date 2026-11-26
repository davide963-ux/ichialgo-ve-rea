/**
 * Strategy hooks.
 *
 *   useStrategyEngine(tf)  — starts/retargets the engine for the whole app
 *   useSignals()           — the signal log (newest first)
 *   useSignalSummary()     — the Dashboard's "active / today" counters
 *   useSymbolSignal(sym)   — the latest signal for one pair (scanner row tag)
 *   useWatchLevel(sym)     — the Kijun band one pair is sitting against
 *   useIchimokuAnalysis(…) — signals for the candles a chart already has
 *   useTradePlan(signal)   — ticket prices and lot size for one signal
 */
import { useEffect, useMemo } from 'react';
import { STRATEGY_CONFIG } from '../config/strategy';
import { TIMEFRAME_SECONDS, type Timeframe } from '../config/timeframes';
import { analyseIchimoku, planFromSignal, signalTimeMs, strategyEngine } from '../services/strategy';
import type { IchimokuAnalysis, IchimokuLevel, IchimokuSignal, TradePlan } from '../services/strategy';
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

export const useSignals = (): IchimokuSignal[] => useSignalStore((s) => s.signals);
export const useStrategyStatus = () => useSignalStore((s) => s.status);
export const useLastScanAt = () => useSignalStore((s) => s.lastScanAt);
export const useWatchLevel = (symbol: string): IchimokuLevel | undefined =>
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
  /** Pairs sitting in the Kijun band right now, with a trend to trade. */
  active: number;
  /** Signals detected since local midnight. */
  today: number;
  /** Most recent signal, whatever its age. */
  latest: IchimokuSignal | null;
}

export function useSignalSummary(): SignalSummary {
  const signals = useSignals();
  const levels = useSignalStore((s) => s.levels);
  return useMemo(() => {
    const dayStart = startOfToday(Date.now());
    const cutoff = Date.now() - STRATEGY_CONFIG.liveSignalTtlMs;
    /**
     * "Active" means a pullback is in progress that COULD trade: price inside
     * the Kijun band and clear of the cloud. A pair inside the cloud is also
     * near its Kijun by construction and has no trend to pull back into, so
     * counting it would make the number mean "near a line" instead of "in a
     * setup".
     */
    const active = Object.values(levels).filter(
      (l) => l.direction !== null && l.inBand && l.updatedAt >= cutoff,
    ).length;
    return {
      active,
      today: signals.filter((s) => signalTimeMs(s) >= dayStart).length,
      latest: signals[0] ?? null,
    };
  }, [signals, levels]);
}

/**
 * Signals for one chart's candle window.
 *
 * Deliberately recomputed from the candles the chart already holds rather
 * than read from the store: the overlay then always matches the bars on
 * screen, and it costs no extra provider request.
 */
export function useIchimokuAnalysis(symbol: string, timeframe: Timeframe, candles: Candle[]): IchimokuAnalysis {
  return useMemo(() => analyseIchimoku(candles, symbol, timeframe), [candles, symbol, timeframe]);
}

/**
 * Latest signal for one pair, for the scanner row badge — but only while it
 * is still current. A pullback from twelve hours ago is history, not a live
 * alert, and badging every row permanently would make the column meaningless.
 * "Current" = within `freshBars` bars of the timeframe it fired on.
 */
export function useSymbolSignal(symbol: string, freshBars = 3): IchimokuSignal | undefined {
  const signals = useSignals();
  return useMemo(() => {
    const latest = signals.find((s) => s.symbol === symbol);
    if (!latest) return undefined;
    const window = TIMEFRAME_SECONDS[latest.timeframe] * freshBars * 1000;
    return Date.now() - signalTimeMs(latest) <= window ? latest : undefined;
  }, [signals, symbol, freshBars]);
}

/**
 * The order ticket for a signal: the detector's own levels rounded to prices
 * a broker accepts, plus the lot size that risks exactly the configured
 * percentage of the account.
 *
 * Live quotes are passed in as the USD conversion source, so a cross like
 * EUR/GBP can be sized from the GBP/USD rate the scanner already holds.
 */
export function useTradePlan(signal: IchimokuSignal | null | undefined): TradePlan | null {
  const balance = useAccount((a) => a.balance);
  const riskPct = useAccount((a) => a.riskPct);
  const quotes = useMarketStore((s) => s.quotes);

  return useMemo(() => {
    if (!signal) return null;
    const lookup: RateLookup = (sym) => quotes[sym]?.price ?? null;
    return planFromSignal(signal, { balance, riskPct }, lookup);
  }, [signal, balance, riskPct, quotes]);
}
