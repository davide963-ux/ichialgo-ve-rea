/**
 * Performance metrics, grouped.
 *
 * Deliberately pure and source-agnostic: it takes a list of resolved trades
 * and returns statistics. The live signal history and the backtest both feed
 * it, so "win rate" means exactly the same thing in both places. Two separate
 * implementations would drift, and the first time they disagreed you would not
 * know which to believe.
 *
 * WHY R, NOT MONEY
 * ────────────────
 * Every trade is measured in R — multiples of the risk taken. A 40-pip win on
 * USD/JPY and a 12-pip win on EUR/CHF are not comparable in pips, and comparing
 * them in currency just smuggles position size into a question about the
 * strategy. In R they are directly comparable, and the aggregate answers the
 * only question that matters: does this edge pay more than it costs?
 *
 * A NOTE ON SMALL SAMPLES
 * ───────────────────────
 * Every group reports its `trades` count alongside its rates, because a 100%
 * win rate over three trades is noise and the UI has to be able to say so.
 * `reliable` marks groups big enough to be worth reading at all. Nothing here
 * decides what is significant — it reports the count and lets the caller judge.
 */

export type TradeOutcome = 'tp1' | 'tp2' | 'tp3' | 'sl' | 'be' | 'expired' | 'invalidated' | 'pending';

/** The minimum a trade must carry to be measured. */
export interface MeasuredTrade {
  direction: 'long' | 'short';
  timeframe: string;
  marketCondition: string;
  /** Signal grade at entry — STRONG_LONG, LONG, … */
  signal: string;
  outcome: TradeOutcome;
  /** Result in multiples of risk. Null while the trade is open. */
  rMultiple: number | null;
  confidence: number;
  symbol: string;
}

export interface Metrics {
  trades: number;
  closed: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRatePct: number | null;
  /** Mean R across closed trades — the headline number. */
  averageR: number | null;
  totalR: number;
  /** Gross R won ÷ gross R lost. Above 1 is profitable. */
  profitFactor: number | null;
  /** Deepest peak-to-trough fall of the cumulative R curve. */
  maxDrawdownR: number;
  bestR: number | null;
  worstR: number | null;
  /** False when the sample is too small to read anything into. */
  reliable: boolean;
}

export interface Group extends Metrics {
  key: string;
}

export interface PerformanceReport {
  overall: Metrics;
  byMarketCondition: Group[];
  bySignalStrength: Group[];
  byTimeframe: Group[];
  byDirection: Group[];
  bySymbol: Group[];
  /** Trending vs ranging, the split the strategy's premise rests on. */
  byRegimeFamily: Group[];
}

/** Below this, a group's percentages are not worth reading. */
export const MIN_RELIABLE_TRADES = 10;

const EMPTY: Metrics = {
  trades: 0,
  closed: 0,
  wins: 0,
  losses: 0,
  breakeven: 0,
  winRatePct: null,
  averageR: null,
  totalR: 0,
  profitFactor: null,
  maxDrawdownR: 0,
  bestR: null,
  worstR: null,
  reliable: false,
};

/**
 * Metrics for one set of trades.
 *
 * Open trades count toward `trades` but nothing else: including them in a win
 * rate would let a losing position flatter the numbers simply by staying open,
 * which is the oldest self-deception in trading.
 *
 * Breakeven is its own category rather than a win or a loss. Folding it into
 * either distorts the win rate in opposite directions, and "the stop moved to
 * entry and the trade scratched" is genuinely a third outcome.
 */
export function computeMetrics(trades: readonly MeasuredTrade[]): Metrics {
  if (trades.length === 0) return { ...EMPTY };

  const closed = trades.filter((t) => t.outcome !== 'pending' && t.rMultiple !== null);
  if (closed.length === 0) return { ...EMPTY, trades: trades.length };

  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let totalR = 0;
  let best: number | null = null;
  let worst: number | null = null;

  // Drawdown walks the trades in the order given, which is why the caller must
  // pass them oldest-first for this number to mean anything.
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (const t of closed) {
    const r = t.rMultiple!;
    totalR += r;

    if (t.outcome === 'be' || r === 0) breakeven++;
    else if (r > 0) {
      wins++;
      grossWin += r;
    } else {
      losses++;
      grossLoss += Math.abs(r);
    }

    if (best === null || r > best) best = r;
    if (worst === null || r < worst) worst = r;

    cumulative += r;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const decided = wins + losses;

  return {
    trades: trades.length,
    closed: closed.length,
    wins,
    losses,
    breakeven,
    // Breakevens are excluded from the denominator: a scratch is neither a win
    // nor a loss, so counting it as a non-win understates the edge.
    winRatePct: decided === 0 ? null : (wins / decided) * 100,
    averageR: totalR / closed.length,
    totalR,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Infinity : null) : grossWin / grossLoss,
    maxDrawdownR: maxDrawdown,
    bestR: best,
    worstR: worst,
    reliable: closed.length >= MIN_RELIABLE_TRADES,
  };
}

/** Group by a key, then measure each group. Empty groups are dropped. */
export function groupBy(trades: readonly MeasuredTrade[], key: (t: MeasuredTrade) => string): Group[] {
  const buckets = new Map<string, MeasuredTrade[]>();
  for (const t of trades) {
    const k = key(t);
    const list = buckets.get(k) ?? [];
    list.push(t);
    buckets.set(k, list);
  }
  return [...buckets.entries()]
    .map(([k, list]) => ({ key: k, ...computeMetrics(list) }))
    .sort((a, b) => b.closed - a.closed || a.key.localeCompare(b.key));
}

/**
 * Collapse the seven regimes into the distinction the strategy rests on.
 *
 * The premise is that a pullback into confluence works in a trend and not in
 * chop. Splitting results this way is the most direct test of that claim: if
 * the ranging bucket performs as well as the trending one, the regime filter
 * is not earning its place.
 */
export function regimeFamily(condition: string): string {
  if (condition === 'TRENDING_BULLISH' || condition === 'TRENDING_BEARISH') return 'Trending';
  if (condition === 'RANGING') return 'Ranging';
  if (condition === 'CHOPPY') return 'Choppy';
  if (condition === 'TRANSITION') return 'Transition';
  if (condition === 'OVEREXTENDED') return 'Overextended';
  return 'Unknown';
}

/** Strong vs ordinary, ignoring direction — the question is grade, not side. */
export function signalStrength(signal: string): string {
  if (signal.startsWith('STRONG_')) return 'Strong';
  if (signal === 'LONG' || signal === 'SHORT') return 'Standard';
  if (signal.startsWith('WATCH_')) return 'Watch';
  return 'Other';
}

export function buildReport(trades: readonly MeasuredTrade[]): PerformanceReport {
  return {
    overall: computeMetrics(trades),
    byMarketCondition: groupBy(trades, (t) => t.marketCondition),
    bySignalStrength: groupBy(trades, (t) => signalStrength(t.signal)),
    byTimeframe: groupBy(trades, (t) => t.timeframe),
    byDirection: groupBy(trades, (t) => (t.direction === 'long' ? 'Long' : 'Short')),
    bySymbol: groupBy(trades, (t) => t.symbol),
    byRegimeFamily: groupBy(trades, (t) => regimeFamily(t.marketCondition)),
  };
}
