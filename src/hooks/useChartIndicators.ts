/**
 * Indicator overlays for a price chart.
 *
 * Deliberately NOT a strategy hook. It computes Ichimoku from candles and
 * stops there — no signals, no bias, no opinion about what the numbers mean.
 * The chart should not go blank just because no strategy is configured.
 *
 * The previous version of this was `useTouchAnalysis`, which returned the
 * overlays AND the strategy's signals in one object, so the chart could not be
 * rendered without running the strategy. That coupling is why removing a
 * strategy broke the price chart.
 *
 * It also drew an EMA50, which is gone with the strategy that traded it. The
 * line was not wrong as a drawing, but it was the only moving average left in
 * the app, and a chart that still shows one invites reading it as a signal.
 */
import { useMemo } from 'react';
import { ichimoku, type IchimokuSeries } from '../lib/indicators';
import type { Candle } from '../services/marketData';

/** Senkou B's 52 bars plus the 26-bar displacement: below this, no cloud. */
export const ICHIMOKU_MIN_BARS = 78;

export interface ChartIndicators {
  /** Null until there are enough bars for a cloud to exist at all. */
  ichimoku: IchimokuSeries | null;
}

export function useChartIndicators(candles: readonly Candle[]): ChartIndicators {
  return useMemo(
    () => ({ ichimoku: candles.length >= ICHIMOKU_MIN_BARS ? ichimoku(candles) : null }),
    [candles],
  );
}
