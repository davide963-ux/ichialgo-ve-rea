/**
 * Strategy-layer contracts. The UI depends on these, never on the detector.
 *
 * They live in their own module for one practical reason: `signalStore` needs
 * the shapes, the engine writes to `signalStore`, and the strategy's barrel
 * re-exports the engine — so a store that imported the barrel would close a
 * runtime cycle. Types are erased at compile time, this file has no runtime
 * imports, and the cycle cannot form.
 */
import type { Timeframe } from '../../config/timeframes';

export type StrategyId = 'ichimoku-kijun';

export type Direction = 'LONG' | 'SHORT';

/** Which side of the Kumo price closed on. The cloud sets the direction. */
export type Kumo = 'above' | 'below';

/**
 * One signal: price pulled back to Kijun-sen inside a trend the cloud had
 * already established, and all the required confirmations agreed.
 *
 * Every field is Ichimoku's own or derived from it. There is no moving
 * average here and no volatility measure from outside the cloud — distance is
 * the 26-bar high-low range, which is the Kijun's own width.
 */
export interface IchimokuSignal {
  /** Stable per (symbol, timeframe, bar) — re-scanning never duplicates one. */
  id: string;
  strategy: StrategyId;
  symbol: string;
  timeframe: Timeframe;
  /** Open time of the bar that touched Kijun, UNIX seconds (UTC). */
  barTime: number;
  /** When this app detected it (ms). */
  detectedAt: number;
  /**
   * 'candle' — found on a closed bar during a scan.
   * 'live'   — the quote stream reached the Kijun band between scans.
   */
  source: 'candle' | 'live';

  /** From the Kumo, never from the side price approached on. */
  direction: Direction;
  kumo: Kumo;

  // ── the levels, all Ichimoku-derived ───────────────────────────────────
  /** Where a market order fills: the signal bar's close, or the live quote. */
  entry: number;
  stop: number;
  target: number;
  /** |entry − stop| in pips. */
  stopPips: number;
  /** The 26-bar range in pips — this strategy's unit of distance. */
  rangePips: number;

  // ── the lines at the moment of the signal ──────────────────────────────
  tenkan: number | null;
  kijun: number;
  senkouA: number;
  senkouB: number;
  /** |entry − Kijun| in pips: how clean the retest was. */
  distancePips: number;

  // ── the four confirmations ─────────────────────────────────────────────
  /** Cloud in effect agrees: Senkou A above B for a long, below for a short. */
  cloudBullish: boolean;
  /** The cloud 26 bars ahead — known today, and what the trend walks into. */
  futureCloudBullish: boolean | null;
  /** Lagging line clear of the candles it is drawn over. */
  chikouFree: boolean | null;
  /** Tenkan on the direction's side of Kijun. */
  tenkanAgrees: boolean;
  /** How many of the four agree, 0–4. A gate, not a label. */
  score: number;
}

/**
 * The Kijun band one pair is sitting against right now, as of its last closed
 * bar — what the live quote stream is checked against between scans.
 *
 * It carries the confirmations as well as the level, because a live touch has
 * to be scored the moment it happens. The cloud in effect is displaced 26
 * bars so it cannot change inside a bar; Tenkan and Kijun drift a little as
 * the forming bar moves, which is why a live signal inherits these rather
 * than recomputing a cloud from a half-finished bar.
 */
export interface IchimokuLevel {
  symbol: string;
  timeframe: Timeframe;
  kijun: number;
  /** Half-width of the pullback zone, in price units. */
  band: number;
  /** The 26-bar range in price units — the stop is a fraction of it. */
  range: number;
  /** Null while price is inside the cloud: there is no trend to pull into. */
  direction: Direction | null;
  /** Where price closed relative to the cloud, 'inside' included. */
  side: Kumo | 'inside';
  /** False until price closes clear of the band again — stops repeat signals. */
  armed: boolean;
  /**
   * Price is in the pullback zone right now.
   *
   * Separate from `armed`, which is about whether a signal is ALLOWED. A pair
   * can be in the band and disarmed (it already fired on this pullback), or
   * armed and nowhere near it. The Dashboard's "active setups" counter needs
   * both, and deriving one from the other gets it wrong in both directions.
   */
  inBand: boolean;
  /** Open time of the bar the level was computed from. */
  barTime: number;
  updatedAt: number;

  // ── inherited by a live touch ──────────────────────────────────────────
  tenkan: number | null;
  senkouA: number;
  senkouB: number;
  cloudBullish: boolean;
  futureCloudBullish: boolean | null;
  tenkanAgrees: boolean;
  /**
   * High and low of the bar 26 back, so a live touch can judge Chikou against
   * the quote itself rather than against a close that has already happened.
   */
  backHigh: number | null;
  backLow: number | null;
}
