/**
 * Touches, as arrows a chart can draw.
 *
 * This lives in the strategy layer rather than in the chart because the chart
 * is deliberately strategy-agnostic: it takes {time, side, color} and knows
 * nothing about EMAs or touches. Coupling the two is what once made removing
 * a strategy break the price chart.
 *
 * The arrow sits on the side price came FROM, so it points at the candle:
 * a pullback from above gets an up arrow below the bar.
 */
import type { TouchSignal } from './types';

/** Greyed out: a counter-trend touch is a worse trade, not an impossible one. */
const COUNTER_TREND = '#7F9189';
const SHORT = '#F0616D';
const LONG = '#E9B949';

export interface TouchMarker {
  time: number;
  side: 'up' | 'down';
  color?: string;
}

export function touchMarkers(signals: readonly TouchSignal[], symbol: string, timeframe: string): TouchMarker[] {
  return signals
    .filter((s) => s.symbol === symbol && s.timeframe === timeframe)
    .map((s) => ({
      time: s.barTime,
      side: s.approach === 'above' ? ('up' as const) : ('down' as const),
      color: s.counterTrend ? COUNTER_TREND : s.bias === 'short' ? SHORT : LONG,
    }));
}
