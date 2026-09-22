/**
 * The contract between a strategy and everything around it.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * Two strategies were built here at different times, each inventing its own
 * result shape, and every consumer — dashboard, backtest, scanner, database —
 * grew a dependency on one or the other. Changing a strategy meant changing
 * all of them, so neither could be removed and both stayed.
 *
 * So the rule now: a strategy is a function from candles to THIS type, and
 * nothing outside `src/services/strategy/` may import anything narrower. The
 * scanner, the backtest and the UI read only what is declared here, which is
 * what makes the strategy replaceable without touching them.
 *
 * WHAT BELONGS HERE, AND WHAT DOES NOT
 * ────────────────────────────────────
 * Only fields the surrounding system genuinely acts on: a direction, a graded
 * signal, a confidence, a risk ticket, and an explanation. The previous
 * contract also carried Kumo thickness, slope grades, pullback depth and zone
 * strength — real concepts, but concepts belonging to ONE strategy, which is
 * how the coupling started.
 *
 * Anything a strategy wants to record beyond this goes in `detail`, which is
 * stored verbatim as the `analysis` JSON column and never interpreted out
 * here. That is the seam: a new strategy adds to `detail` freely and this file
 * does not change.
 */

/** Which way the strategy wants to trade, if either. */
export type Direction = 'long' | 'short' | 'none';

/**
 * The graded verdict.
 *
 * WATCH is deliberately distinct from NEUTRAL: "a real setup that has not met
 * its entry condition yet" and "nothing here" are different answers, and
 * collapsing them is what makes a terminal either too noisy or silent.
 * NO_TRADE means the strategy refused outright — not enough data, or a
 * condition that forbids trading at all.
 */
export type SignalTier =
  | 'STRONG_LONG'
  | 'LONG'
  | 'WATCH_LONG'
  | 'NEUTRAL'
  | 'WATCH_SHORT'
  | 'SHORT'
  | 'STRONG_SHORT'
  | 'NO_TRADE';

/**
 * Setup lifecycle, owned by `lifecycle.ts` rather than by any strategy.
 *
 *   FORMING ──▶ CONFIRMING ──▶ CONFIRMED ──▶ ACTIVE ──┬─▶ COMPLETED
 *      ▲                                              └─▶ INVALIDATED
 *      └──────────────── reset ────────────────────────────┘
 *
 * A signal is emitted on ENTERING a state, never while sitting in one. That
 * is the whole reason the same setup does not print on every candle, and it
 * is a property of the tracker, not of the rules — so it survives a strategy
 * rewrite.
 */
export type SetupStatus = 'FORMING' | 'CONFIRMING' | 'CONFIRMED' | 'ACTIVE' | 'INVALIDATED' | 'COMPLETED';

/** The order ticket. Null throughout when the strategy is not proposing a trade. */
export interface RiskTicket {
  entry: number | null;
  /**
   * The stop the position is SIZED against. Never move this once set: R is
   * measured against the risk actually taken, and a breakeven move that
   * overwrites it leaves the division with a zero denominator.
   */
  stop: number | null;
  /** Ordered, nearest first. Any length; the database stores the first three. */
  targets: number[];
  stopPips: number | null;
  /** Plain sentence describing what would prove the idea wrong. */
  invalidation: string | null;
}

export interface StrategyAnalysis {
  symbol: string;
  timeframe: string;
  /** Open time of the analysed bar, UNIX seconds. */
  barTime: number;
  /**
   * False while the last candle is still forming.
   * A strategy must not report CONFIRMED on an unclosed bar — the rejection it
   * thinks it sees can still be erased before the close.
   */
  barClosed: boolean;

  direction: Direction;
  signal: SignalTier;
  /** 0–100. */
  confidence: number;
  /**
   * The strategy's own name for current conditions, free-form.
   * Grouped verbatim in the performance breakdowns, so keep it to a small
   * stable set of values or the tables become unreadable.
   */
  marketCondition: string;
  status: SetupStatus;

  price: number;
  risk: RiskTicket;

  /**
   * Identity of the setup being tracked, if the strategy has one.
   *
   * The tracker uses it to tell "the same setup, still developing" from "a new
   * setup in the same direction" — without it, a fresh opportunity after an
   * old one fades is silently swallowed as a duplicate. Typically the price
   * level the move originated from. Null means every re-entry reads as the
   * same setup.
   */
  anchor: number | null;

  /** Why it is saying this. Rendered to the user verbatim. */
  reasons: string[];
  /** What weakened it. Shown as caveats, not as reasons against. */
  warnings: string[];
  /** Strategy-specific payload, stored as JSON and never read out here. */
  detail: Record<string, unknown>;
}

export interface AnalyseOptions {
  symbol: string;
  timeframe: string;
  /**
   * Analyse as if this were the last bar, ignoring everything after it.
   *
   * The backtest needs this to replay history without lookahead, and passing
   * an index rather than a fresh slice per bar keeps that loop linear instead
   * of quadratic. Defaults to the final candle.
   */
  index?: number;
  /** False when the final candle is still open. */
  lastBarClosed?: boolean;
  /** Direction from a higher timeframe, when the caller has fetched one. */
  higherTimeframeBias?: Direction;
}

/** Signals that warrant placing an order, as opposed to watching. */
export function isActionable(signal: SignalTier): boolean {
  return signal === 'LONG' || signal === 'SHORT' || signal === 'STRONG_LONG' || signal === 'STRONG_SHORT';
}

/** The side a signal implies, ignoring its grade. */
export function directionOf(signal: SignalTier): Direction {
  if (signal.endsWith('_LONG')) return 'long';
  if (signal.endsWith('_SHORT')) return 'short';
  return 'none';
}
