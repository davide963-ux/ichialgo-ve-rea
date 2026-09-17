/**
 * Strategy-layer contracts. The UI depends on these, never on the detector.
 */
import type { Timeframe } from '../../config/timeframes';

export type StrategyId = 'ema50-touch';

/** Which side price came from before it reached the EMA. */
export type Approach = 'above' | 'below';

/** What the bar did after reaching the EMA. */
export type TouchOutcome =
  | 'bounce' // closed back on the approach side — the EMA held
  | 'cross' // closed through — the EMA broke
  | 'inside' // closed inside the tolerance band — undecided
  | 'pending'; // the bar is still forming (live touch)

export type Trend = 'up' | 'down' | 'flat';

/** Directional read of the touch, once trend is taken into account. */
export type Bias = 'long' | 'short' | 'neutral';

export interface TouchSignal {
  /** Stable per (symbol, timeframe, bar) — re-scanning never duplicates a signal. */
  id: string;
  strategy: StrategyId;
  symbol: string;
  timeframe: Timeframe;
  /** Open time of the bar that touched, UNIX seconds (UTC). */
  barTime: number;
  /** When this app detected it (ms). */
  detectedAt: number;
  /**
   * 'candle' — found on a closed/forming bar during a scan.
   * 'live'   — the incoming quote reached the level between scans.
   */
  source: 'candle' | 'live';
  /** Price that made contact (bar extreme, or the live quote). */
  price: number;
  /** EMA value at the touch. */
  ema: number;
  /** Half-width of the touch band, in pips. */
  tolerancePips: number;
  /** ATR at the touch, in price units — the stop distance is built from it. */
  atr: number;
  /** |price − ema| in pips: 0 = dead on the line. */
  distancePips: number;
  approach: Approach;
  outcome: TouchOutcome;
  trend: Trend;
  bias: Bias;
  /** True when the touch is against the EMA's own trend — the weaker case. */
  counterTrend: boolean;
}

/** Live level the engine watches between candle scans. */
export interface WatchLevel {
  symbol: string;
  timeframe: Timeframe;
  ema: number;
  /** Band half-width in price units. */
  tolerance: number;
  tolerancePips: number;
  /** ATR at the last scan, in price units. */
  atr: number;
  trend: Trend;
  /** Where price sat at the last scan. */
  side: Approach | 'inside';
  /** False while price is still inside the band — suppresses repeat signals. */
  armed: boolean;
  /** Open time of the bar the level was computed from. */
  barTime: number;
  updatedAt: number;
}
