/**
 * Backtest engine for the EMA50 touch strategy — pure, no I/O.
 *
 * It reuses the live detector, so a backtested trade and a live signal come
 * from exactly the same code. That is the point of keeping
 * `analyseEma50Touch` and `planFromTouch` free of side effects.
 *
 *   candles ──▶ analyseEma50Touch()  ──▶ touches (causal: bar i uses bars ≤ i)
 *                      │
 *                      ├─ filter to the requested date range
 *                      ├─ drop touches while a position is open
 *                      ├─ optional: Ichimoku-confluent only
 *                      ▼
 *              planFromTouch(running balance)  ──▶ entry / stop / target / lots
 *                      │
 *                      ▼
 *              walk bars forward ──▶ first bar touching stop or target
 *                      │
 *                      └─ still open at the last bar ─▶ marked 'open', no P&L
 *
 * NO LOOKAHEAD
 * ────────────
 * Every indicator the detector uses is causal: EMA, ATR, Tenkan/Kijun and the
 * DISPLACED Senkou spans all read bars at or before `i`, and the Chikou check
 * compares the current close to candles 26 bars BACK. Nothing reads a future
 * bar. Entry is the EMA level on the touch bar itself — the bar's range did
 * reach it, so a resting limit order would have filled.
 *
 * THE ENTRY BAR IS NOT AN EXIT BAR
 * ────────────────────────────────
 * Exits are searched from the bar AFTER the entry. The entry bar's own range
 * mostly happened BEFORE price reached the EMA — on a pullback bar the high
 * sits where the move started, so counting it would book a target the trade
 * never had the chance to reach. OHLC cannot say what price did after the
 * fill inside that bar, so the bar is not used for exits at all.
 *
 * SAME-BAR AMBIGUITY
 * ──────────────────
 * When one later bar's range covers both the stop and the target, intrabar
 * order is unknowable from OHLC, so the STOP is taken. That is the
 * pessimistic convention: it under-reports rather than inventing wins.
 */
import type { Timeframe } from '../../config/timeframes';
import { TIMEFRAME_SECONDS } from '../../config/timeframes';
import { EMA50_TOUCH, TRADE_PLAN, type Ema50TouchConfig, type TradePlanConfig } from '../../config/strategy';
import { pipSize } from '../../lib/pips';
import type { RateLookup } from '../../lib/positionSize';
import type { Candle } from '../marketData';
import { analyseEma50Touch } from './ema50Touch';
import { planFromTouch } from './tradePlan';

export type ExitReason = 'target' | 'stop' | 'open';

export interface BacktestTrade {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  /** Bar that produced the touch (UNIX seconds). */
  entryTime: number;
  entryPrice: number;
  stop: number;
  target: number;
  exitTime: number | null;
  exitPrice: number | null;
  exitReason: ExitReason;
  /** Bars the position was held. */
  barsHeld: number;
  lots: number;
  pips: number | null;
  pnl: number | null;
  /** Balance once this trade closed. */
  balanceAfter: number;
  /** Result in multiples of the risked amount: +2 on a target, −1 on a stop. */
  rMultiple: number | null;
  ichimokuScore: number | null;
  counterTrend: boolean;
}

export interface BacktestStats {
  trades: number;
  closed: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  netProfit: number;
  returnPct: number;
  profitFactor: number | null;
  /** Largest peak-to-trough fall in balance, as a percentage of the peak. */
  maxDrawdownPct: number;
  maxDrawdown: number;
  averageR: number | null;
  /** Average P&L per closed trade. */
  expectancy: number | null;
  grossProfit: number;
  grossLoss: number;
  bestTrade: number | null;
  worstTrade: number | null;
  startingBalance: number;
  endingBalance: number;
}

export interface BacktestResult {
  symbol: string;
  timeframe: Timeframe;
  trades: BacktestTrade[];
  /** Balance after each closed trade, starting at the opening balance. */
  equity: { time: number; balance: number }[];
  stats: BacktestStats;
  /** Bars actually used, and how many were only indicator warm-up. */
  barsAnalysed: number;
  warmupBars: number;
  /** Touches found but not traded, and why. */
  skipped: { positionOpen: number; notConfluent: number; unsizable: number };
  /** Honest notes about data coverage and assumptions. */
  warnings: string[];
  rangeStart: number | null;
  rangeEnd: number | null;
}

export interface BacktestOptions {
  startingBalance: number;
  riskPct: number;
  /** Inclusive UNIX-second bounds on which touches may be traded. */
  from?: number;
  to?: number;
  /** Only trade touches Ichimoku agrees with. */
  confluentOnly?: boolean;
  /** USD conversion for crosses; a backtest has no live quotes by default. */
  lookup?: RateLookup;
  touchConfig?: Ema50TouchConfig;
  planConfig?: TradePlanConfig;
}

const emptyStats = (startingBalance: number): BacktestStats => ({
  trades: 0,
  closed: 0,
  wins: 0,
  losses: 0,
  winRatePct: null,
  netProfit: 0,
  returnPct: 0,
  profitFactor: null,
  maxDrawdownPct: 0,
  maxDrawdown: 0,
  averageR: null,
  expectancy: null,
  grossProfit: 0,
  grossLoss: 0,
  bestTrade: null,
  worstTrade: null,
  startingBalance,
  endingBalance: startingBalance,
});

/**
 * First bar at or after `fromIndex` whose range reaches the stop or the
 * target. Returns null when neither is touched before the data runs out.
 */
function findExit(
  candles: readonly Candle[],
  fromIndex: number,
  direction: 'LONG' | 'SHORT',
  stop: number,
  target: number,
): { index: number; price: number; reason: 'stop' | 'target' } | null {
  for (let i = fromIndex; i < candles.length; i++) {
    const bar = candles[i]!;
    const hitStop = direction === 'LONG' ? bar.low <= stop : bar.high >= stop;
    const hitTarget = direction === 'LONG' ? bar.high >= target : bar.low <= target;
    // Pessimistic: a bar covering both is treated as the stop.
    if (hitStop) return { index: i, price: stop, reason: 'stop' };
    if (hitTarget) return { index: i, price: target, reason: 'target' };
  }
  return null;
}

export function runBacktest(
  candles: readonly Candle[],
  symbol: string,
  timeframe: Timeframe,
  opts: BacktestOptions,
): BacktestResult {
  const touchConfig = opts.touchConfig ?? EMA50_TOUCH;
  const planConfig = opts.planConfig ?? TRADE_PLAN;
  const warnings: string[] = [];
  const pip = pipSize(symbol);

  const base: BacktestResult = {
    symbol,
    timeframe,
    trades: [],
    equity: [],
    stats: emptyStats(opts.startingBalance),
    barsAnalysed: candles.length,
    warmupBars: Math.min(candles.length, touchConfig.minBars),
    skipped: { positionOpen: 0, notConfluent: 0, unsizable: 0 },
    warnings,
    rangeStart: candles[0]?.time ?? null,
    rangeEnd: candles.at(-1)?.time ?? null,
  };

  if (candles.length < touchConfig.minBars) {
    warnings.push(`Needs at least ${touchConfig.minBars} ${timeframe} candles to warm the indicators up; got ${candles.length}.`);
    return base;
  }

  const from = opts.from ?? candles[0]!.time;
  const to = opts.to ?? candles.at(-1)!.time;

  // Indicators run over EVERY fetched bar (they need history before the first
  // tradable one), but only touches inside the range may be traded.
  const { signals } = analyseEma50Touch(candles, symbol, timeframe, touchConfig);
  const indexByTime = new Map(candles.map((c, i) => [c.time, i]));

  const tradable = signals.filter((s) => s.barTime >= from && s.barTime <= to);
  if (tradable.length === 0) {
    warnings.push('No EMA50 touches in this range.');
  }

  let balance = opts.startingBalance;
  const trades: BacktestTrade[] = [];
  const equity: { time: number; balance: number }[] = [{ time: from, balance }];
  let openUntilIndex = -1; // one position at a time, as a live trader would

  for (const signal of tradable) {
    const entryIndex = indexByTime.get(signal.barTime);
    if (entryIndex === undefined) continue;

    if (entryIndex <= openUntilIndex) {
      base.skipped.positionOpen++;
      continue;
    }
    if (opts.confluentOnly && !signal.ichimoku?.agrees) {
      base.skipped.notConfluent++;
      continue;
    }

    // Size off the RUNNING balance, so results compound like a real account.
    const plan = planFromTouch(signal, { balance, riskPct: opts.riskPct }, opts.lookup ?? (() => null), planConfig);
    if (!plan || plan.lots === null || plan.lots <= 0) {
      base.skipped.unsizable++;
      continue;
    }

    // From the NEXT bar: see "THE ENTRY BAR IS NOT AN EXIT BAR" above.
    const exit = findExit(candles, entryIndex + 1, plan.direction, plan.stop, plan.target);
    const pipValuePerLot = plan.potentialLoss !== null && plan.stopPips > 0 ? plan.potentialLoss / (plan.stopPips * plan.lots) : null;

    if (!exit) {
      // Still open when the data ends: reported, but contributes no P&L.
      trades.push({
        id: `${signal.id}|bt`,
        symbol,
        direction: plan.direction,
        entryTime: signal.barTime,
        entryPrice: plan.entry,
        stop: plan.stop,
        target: plan.target,
        exitTime: null,
        exitPrice: null,
        exitReason: 'open',
        barsHeld: candles.length - 1 - entryIndex,
        lots: plan.lots,
        pips: null,
        pnl: null,
        balanceAfter: balance,
        rMultiple: null,
        ichimokuScore: signal.ichimoku?.score ?? null,
        counterTrend: signal.counterTrend,
      });
      openUntilIndex = candles.length - 1;
      continue;
    }

    const pips = (plan.direction === 'LONG' ? exit.price - plan.entry : plan.entry - exit.price) / pip;
    const pnl = pipValuePerLot === null ? 0 : pips * pipValuePerLot * plan.lots;
    const risked = plan.potentialLoss ?? 0;
    balance += pnl;

    trades.push({
      id: `${signal.id}|bt`,
      symbol,
      direction: plan.direction,
      entryTime: signal.barTime,
      entryPrice: plan.entry,
      stop: plan.stop,
      target: plan.target,
      exitTime: candles[exit.index]!.time,
      exitPrice: exit.price,
      exitReason: exit.reason,
      barsHeld: exit.index - entryIndex,
      lots: plan.lots,
      pips,
      pnl,
      balanceAfter: balance,
      rMultiple: risked > 0 ? pnl / risked : null,
      ichimokuScore: signal.ichimoku?.score ?? null,
      counterTrend: signal.counterTrend,
    });
    equity.push({ time: candles[exit.index]!.time, balance });
    openUntilIndex = exit.index;
  }

  if (trades.some((t) => t.exitReason === 'open')) {
    warnings.push('The last trade was still open when the data ended; it is listed but excluded from the statistics.');
  }
  const span = (to - from) / TIMEFRAME_SECONDS[timeframe];
  if (candles.length < span * 0.9) {
    warnings.push(
      `The provider returned ${candles.length} candles for a range needing about ${Math.round(span)} — ` +
        'the test covers less history than requested.',
    );
  }

  return { ...base, trades, equity, stats: summarise(trades, opts.startingBalance, balance) };
}

export function summarise(trades: readonly BacktestTrade[], startingBalance: number, endingBalance: number): BacktestStats {
  const closed = trades.filter((t) => t.pnl !== null);
  const stats = emptyStats(startingBalance);
  stats.trades = trades.length;
  stats.closed = closed.length;
  stats.endingBalance = endingBalance;
  stats.netProfit = endingBalance - startingBalance;
  stats.returnPct = startingBalance > 0 ? (stats.netProfit / startingBalance) * 100 : 0;
  if (closed.length === 0) return stats;

  for (const t of closed) {
    const pnl = t.pnl!;
    if (pnl >= 0) {
      stats.wins++;
      stats.grossProfit += pnl;
    } else {
      stats.losses++;
      stats.grossLoss += -pnl;
    }
  }
  stats.winRatePct = (stats.wins / closed.length) * 100;
  stats.profitFactor = stats.grossLoss > 0 ? stats.grossProfit / stats.grossLoss : null;
  stats.expectancy = (stats.grossProfit - stats.grossLoss) / closed.length;

  const rs = closed.map((t) => t.rMultiple).filter((r): r is number => r !== null);
  stats.averageR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;

  const pnls = closed.map((t) => t.pnl!);
  stats.bestTrade = Math.max(...pnls);
  stats.worstTrade = Math.min(...pnls);

  // Drawdown over the balance path, peak to trough.
  let peak = startingBalance;
  let worst = 0;
  let worstPct = 0;
  let running = startingBalance;
  for (const t of closed) {
    running = t.balanceAfter;
    if (running > peak) peak = running;
    const fall = peak - running;
    if (fall > worst) worst = fall;
    const pct = peak > 0 ? (fall / peak) * 100 : 0;
    if (pct > worstPct) worstPct = pct;
  }
  stats.maxDrawdown = worst;
  stats.maxDrawdownPct = worstPct;
  return stats;
}
