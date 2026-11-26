/**
 * Strategy-layer contracts. The UI depends on these, never on a detector.
 *
 * They live in their own module for one practical reason: `signalStore` needs
 * the shapes, the engine writes to `signalStore`, and the strategy's barrel
 * re-exports the engine — so a store that imported the barrel would close a
 * runtime cycle. Types are erased at compile time, this file has no runtime
 * imports, and the cycle cannot form.
 *
 * WHY THE CONDITIONS ARE A LIST AND NOT NAMED FIELDS
 * ─────────────────────────────────────────────────
 * There used to be four booleans here — cloudBullish, futureCloudBullish,
 * chikouFree, tenkanAgrees — because there was one strategy with exactly four
 * conditions. There are now three strategies with different ones, and OANDA's
 * published rules do not use the same checks as ours: their pullback needs
 * Tenkan above Kijun and a confirming close, and does not look at the cloud's
 * colour or at Chikou at all.
 *
 * Named fields would mean a union of every condition any strategy might have,
 * mostly null on any given row, with the UI guessing which ones apply. A list
 * of checks lets each detector state its OWN rules in its own words, and lets
 * one panel render all three without knowing what they are.
 */
import type { EntryType } from '../../config/ichimokuStrategy';
import type { Timeframe } from '../../config/timeframes';

export type { EntryType };

/**
 * The strategy. One, because the article describes one.
 *
 * It was briefly three selectable rules — our old gated pullback plus OANDA's
 * two entries as rivals — which measured the parts of their system against
 * each other instead of running it. The ids are still namespaced because the
 * table holds rows from strategies that have been retired.
 */
export type StrategyId = 'ichimoku';

export type Direction = 'LONG' | 'SHORT';

/** Which side of the Kumo price closed on. */
export type Kumo = 'above' | 'below';

/**
 * One condition a strategy evaluated, in that strategy's own language.
 *
 * `required` is the distinction OANDA's article draws and the old code could
 * not express. A Kumo breakout needs price through the cloud — without it
 * there is no setup at all — but the Span A/B twist is described as something
 * that "increases the probability", and in both of the article's worked
 * examples it arrived hours after the break. One is a gate, the other is
 * grading, and collapsing them into a single score loses that.
 */
export interface SignalCheck {
  /** Short label, e.g. "Tenkan above Kijun". */
  label: string;
  /** Null when the data cannot answer it — never silently a failure. */
  pass: boolean | null;
  /** The numbers behind the verdict, for a tooltip. */
  detail: string;
  /** True when the signal cannot exist without it. */
  required: boolean;
}

/**
 * One signal.
 *
 * Every field is Ichimoku's own or derived from it. There is no moving
 * average here and no volatility measure from outside the cloud — distance is
 * the 26-bar high-low range, which is the Kijun's own width.
 */
export interface IchimokuSignal {
  /** Stable per (strategy, symbol, timeframe, bar) — re-scanning never duplicates one. */
  id: string;
  strategy: StrategyId;
  symbol: string;
  timeframe: Timeframe;
  /** Open time of the bar the signal fired on, UNIX seconds (UTC). */
  barTime: number;
  /** When this app detected it (ms). */
  detectedAt: number;
  /**
   * 'candle' — found on a closed bar during a scan.
   * 'live'   — the quote stream triggered it between scans.
   */
  source: 'candle' | 'live';

  /** From the Kumo, never from the side price approached on. */
  direction: Direction;
  kumo: Kumo;
  /**
   * Which of the system's two entries fired.
   *
   *   'breakout'  price left the Kumo and the cloud ahead turned with it —
   *               a trend CHANGE after consolidation.
   *   'pullback'  price clear of the Kumo came back to Tenkan or Kijun and
   *               closed back through the base line — a trend CONTINUATION.
   *
   * It decides where the stop goes, so it is stored rather than inferred.
   */
  entryType: EntryType;

  // ── the ticket ─────────────────────────────────────────────────────────
  /** Where a market order fills: the signal bar's close, or the live quote. */
  entry: number;
  stop: number;
  target: number;
  /** |entry − stop| in pips. */
  stopPips: number;
  /** The structure the stop sits beyond: Kijun-sen, or the far cloud edge. */
  stopLevel: number;
  /** The 26-bar range in pips — the unit every distance is drawn from. */
  rangePips: number;

  // ── the lines at the moment of the signal ──────────────────────────────
  tenkan: number | null;
  kijun: number;
  senkouA: number;
  senkouB: number;
  /** The cloud 26 bars ahead, as computed at this bar. Null before it exists. */
  senkouAheadA: number | null;
  senkouAheadB: number | null;
  /** |entry − Kijun| in pips: how clean the retest was. */
  distancePips: number;
  /**
   * Cloud thickness in pips, |Senkou A − Senkou B| in effect at this bar.
   *
   * OANDA: "a large or thick Cloud indicates potentially stronger support or
   * resistance levels, while a small or thin one can indicate weaker support
   * and resistance. Hence, price breakouts and breakdowns through a thick
   * Cloud are considered more significant."
   */
  cloudPips: number;

  // ── why it fired ───────────────────────────────────────────────────────
  checks: SignalCheck[];
  /** How many checks passed. */
  score: number;
  /** How many there were. A 3/3 and a 3/5 are not the same statement. */
  checksTotal: number;
}

/**
 * What one pair looks like right now, as of its last closed bar — what the
 * live quote stream is checked against between scans.
 *
 * It carries the confirmations as well as the levels, because a live trigger
 * has to be judged the moment it happens. The cloud in effect is displaced 26
 * bars so it cannot change inside a bar; Tenkan and Kijun drift a little as
 * the forming bar moves, which is why a live signal inherits these rather
 * than recomputing a cloud from a half-finished bar.
 */
export interface IchimokuLevel {
  symbol: string;
  timeframe: Timeframe;
  kijun: number;
  tenkan: number | null;
  /** Half-width of the pullback zone, in price units. */
  band: number;
  /** The 26-bar range in price units — the stop is a fraction of it. */
  range: number;
  /** Null while price is inside the cloud: there is no trend to pull into. */
  direction: Direction | null;
  /** Where price closed relative to the cloud, 'inside' included. */
  side: Kumo | 'inside';
  /** False while a setup is part-formed and waiting for its confirmation. */
  armed: boolean;
  /** What the pair is waiting for, if anything. */
  pending: EntryType | null;
  /**
   * Price is in the trigger zone right now.
   *
   * Separate from `armed`, which is about whether a signal is ALLOWED. A pair
   * can be in the zone and disarmed (it already fired on this pullback), or
   * armed and nowhere near it. The Dashboard's "active setups" counter needs
   * both, and deriving one from the other gets it wrong in both directions.
   */
  inBand: boolean;
  /** Open time of the bar the level was computed from. */
  barTime: number;
  updatedAt: number;

  // ── inherited by a live trigger ────────────────────────────────────────
  senkouA: number;
  senkouB: number;
  senkouAheadA: number | null;
  senkouAheadB: number | null;
  cloudBullish: boolean;
  tenkanAgrees: boolean;
  /**
   * High, low and close of the bar 26 back, so a live trigger can judge
   * Chikou against the quote itself rather than against a close that has
   * already happened. OANDA compares the lagging span with "its prior
   * 26-period price", i.e. that bar's CLOSE; our own strategy uses the more
   * demanding high/low, so both are carried.
   */
  backHigh: number | null;
  backLow: number | null;
  backClose: number | null;
}

/**
 * The cloud 26 bars ahead, read as a price zone.
 *
 * OANDA, "Identifying future support and resistance zones": the Kumo "act[s]
 * as a potential future support zone if price is above the Cloud, and as a
 * potential future resistance zone if price is below the Cloud."
 */
export interface CloudZone {
  kind: 'support' | 'resistance';
  /** The nearer edge to price, and the far one. */
  near: number;
  far: number;
  /** Thickness in pips. Thick is stronger, thin is weaker. */
  thicknessPips: number;
  /** Bar time the zone comes into effect. */
  fromBarTime: number;
}
