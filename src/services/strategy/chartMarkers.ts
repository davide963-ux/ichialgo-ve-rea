/**
 * Signals, as arrows a chart can draw.
 *
 * This lives in the strategy layer rather than in the chart because the chart
 * is deliberately strategy-agnostic: it takes {time, side, color} and knows
 * nothing about clouds or pullbacks. Coupling the two is what once made
 * removing a strategy break the price chart.
 *
 * The arrow points the way the trade does, because the trade's direction is
 * the cloud's and no longer depends on which side price arrived from.
 */
import type { IchimokuSignal } from './types';

const LONG = '#E9B949';
const SHORT = '#F0616D';
/** Greyed out: a signal that fired mid-bar is real but less settled. */
const LIVE = '#7F9189';

export interface TouchMarker {
  time: number;
  side: 'up' | 'down';
  color?: string;
}

export function signalMarkers(
  signals: readonly IchimokuSignal[],
  symbol: string,
  timeframe: string,
): TouchMarker[] {
  return signals
    .filter((s) => s.symbol === symbol && s.timeframe === timeframe)
    .map((s) => ({
      time: s.barTime,
      side: s.direction === 'LONG' ? ('up' as const) : ('down' as const),
      color: s.source === 'live' ? LIVE : s.direction === 'LONG' ? LONG : SHORT,
    }));
}
