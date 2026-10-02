/**
 * Indicator overlays for a price chart.
 *
 * Deliberately NOT a strategy hook. It computes Ichimoku and a moving average
 * from candles and stops there — no signals, no bias, no opinion about what
 * the numbers mean. Drawing an EMA on a chart is not a trading decision, and
 * the chart should not go blank just because no strategy is configured.
 *
 * The previous version of this was `useTouchAnalysis`, which returned the
 * overlays AND the strategy's signals in one object, so the chart could not be
 * rendered without running the strategy. That coupling is why removing a
 * strategy broke the price chart.
 */
import { useMemo } from 'react';
import { emaOfCloses, ichimoku, type IchimokuSeries } from '../lib/indicators';
import type { Candle } from '../services/marketData';

/** Matches the period the charts have always drawn. */
export const CHART_EMA_PERIOD = 50;

export interface ChartIndicators {
  /** EMA values, index-aligned with `candles`. Null before it is defined. */
  ema: (number | null)[];
  /** Null until there are enough bars for a cloud to exist at all. */
  ichimoku: IchimokuSeries | null;
}

export function useChartIndicators(candles: readonly Candle[], period = CHART_EMA_PERIOD): ChartIndicators {
  return useMemo(() => {
    if (candles.length === 0) return { ema: [], ichimoku: null };
    return {
      ema: emaOfCloses(candles, period),
      // Senkou B needs 52 bars and the cloud is displaced 26 further, so a
      // short series has no cloud in effect at any bar. Returning null rather
      // than an all-null series lets the chart skip the overlay entirely.
      ichimoku: candles.length >= 78 ? ichimoku(candles) : null,
    };
  }, [candles, period]);
}
