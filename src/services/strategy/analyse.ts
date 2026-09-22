/**
 * The strategy: multi-timeframe confluence over structure, levels, patterns,
 * EMA50 and Ichimoku.
 *
 * HOW A SIGNAL IS MADE
 * ────────────────────
 *   candles ─▶ indicators (EMA50, ATR, Ichimoku)
 *           ─▶ structure   (swings, trend, BOS, CHoCH)
 *           ─▶ levels      (S/R zones, breakout, retest)
 *           ─▶ patterns    (chart + candlestick)
 *                  │
 *                  ├─▶ score BULLISH case ──┐
 *                  └─▶ score BEARISH case ──┴─▶ better side wins
 *                                                    │
 *                                        tier = band(score)
 *                                                    │
 *                                     actionable? ─▶ build ticket
 *                                                    │
 *                                        RR gate ─▶ signal or demote
 *
 * BOTH SIDES ARE SCORED, EVERY TIME
 * ─────────────────────────────────
 * Deciding the direction first and then looking for evidence is how an engine
 * talks itself into trades. Scoring both cases independently and taking the
 * better one means a bearish setup in a nominally bullish market is found
 * rather than argued away — and when the two scores are close, that itself is
 * information: the market is undecided, and the margin damps the result.
 *
 * WHY THE TICKET CAN DEMOTE A SIGNAL
 * ──────────────────────────────────
 * Confluence says the idea is good; the ticket says whether it is tradeable.
 * A 90-score setup with 0.6R of room to the next resistance is not a trade,
 * so a failed reward/risk gate drops an actionable tier to EARLY rather than
 * emitting it. The reason is recorded, because "the setup is right but the
 * price is wrong" is genuinely useful and usually means wait for a pullback.
 */
import { atr as atrSeries } from '../../lib/indicators/atr';
import { emaOfCloses } from '../../lib/indicators/ema';
import { ichimoku } from '../../lib/indicators/ichimoku';
import { pipSize } from '../../lib/pips';
import type { Candle } from '../marketData/types';
import { tierFor, type AnalyseOptions, type Direction, type SignalTier, type StrategyAnalysis } from './contract';
import { readCandles, strongestFor } from './engine/candles';
import { bestPatternFor, neutralPattern, readChartPatterns } from './engine/chartPatterns';
import { ENGINE, type EngineConfig } from './engine/config';
import { readLevels } from './engine/levels';
import { buildTicket } from './engine/risk';
import { scoreSetup } from './engine/scoring';
import { readStructure, swingsOf } from './engine/structure';
import { readEma, readIchimoku, readMomentum } from './engine/trendTools';

export const MIN_BARS = ENGINE.minBars;

export const NO_STRATEGY_REASON = 'Not enough history to analyse.';

/** True once there is enough history for `analyse` to say anything. */
export const hasEnoughBars = (candles: readonly Candle[]): boolean => candles.length >= MIN_BARS;

export interface AnalyseConfigOptions extends AnalyseOptions {
  /** Override the tuning. The scanner and backtest both use the default. */
  config?: EngineConfig;
}

function refusal(options: AnalyseOptions, candles: readonly Candle[], i: number, why: string): StrategyAnalysis {
  const last = candles[i];
  return {
    symbol: options.symbol,
    timeframe: options.timeframe,
    barTime: last?.time ?? 0,
    barClosed: options.lastBarClosed ?? true,
    direction: 'none',
    signal: 'NO_TRADE',
    confidence: 0,
    marketCondition: 'INSUFFICIENT_DATA',
    status: 'FORMING',
    price: last?.close ?? 0,
    risk: { entry: null, stop: null, targets: [], stopPips: null, invalidation: null },
    anchor: null,
    reasons: [],
    warnings: [why],
    detail: { bars: candles.length },
  };
}

export function analyse(candles: readonly Candle[], options: AnalyseConfigOptions): StrategyAnalysis {
  const config = options.config ?? ENGINE;
  const i = options.index ?? candles.length - 1;
  const bar = candles[i];

  if (!bar) return refusal(options, candles, i, 'No candles available.');
  if (i + 1 < config.minBars) {
    return refusal(options, candles, i, `Needs ${config.minBars} bars, has ${i + 1}.`);
  }

  // Everything is computed over the slice ending at `i`, so the backtest sees
  // exactly what the scanner would have seen on that bar and no more.
  const view = candles.slice(0, i + 1);
  const end = view.length - 1;

  const atrs = atrSeries(view, config.atrPeriod);
  const atr = atrs[end];
  if (atr === null || atr === undefined || atr <= 0) {
    return refusal(options, candles, i, 'ATR not yet defined.');
  }

  const ema = emaOfCloses(view, config.emaPeriod);
  const kumo = ichimoku(view);

  const structure = readStructure(view, end, config, atr);
  const swings = swingsOf(view, end, config, atr);
  const levels = readLevels(view, end, swings, atr, config);
  const chartPatterns = readChartPatterns(view, end, swings, atr, config);
  const candlePatterns = readCandles(view, end, config);
  const emaRead = readEma(view, ema, end, atr, config);
  const ichiRead = readIchimoku(view, kumo, end, atr, config);
  const momentum = readMomentum(view, end, atr);
  const neutral = neutralPattern(chartPatterns);

  const higherTrend = options.higherTimeframeBias ?? 'none';
  const entryConfirmation = options.entryConfirmation ?? 'none';

  const scoreFor = (side: 'bullish' | 'bearish') =>
    scoreSetup({
      side,
      structure,
      levels,
      chartPattern: bestPatternFor(chartPatterns, side),
      neutralPattern: neutral,
      candle: strongestFor(candlePatterns, side),
      ema: emaRead,
      ichimoku: ichiRead,
      momentum,
      higherTrend,
      entryConfirmation,
      config,
    });

  const bullish = scoreFor('bullish');
  const bearish = scoreFor('bearish');

  const bullWins = bullish.score >= bearish.score;
  const best = bullWins ? bullish : bearish;
  const side = bullWins ? ('bullish' as const) : ('bearish' as const);
  const direction: Direction = bullWins ? 'long' : 'short';

  // A near-tie means the evidence points both ways at once. Damping by the
  // margin stops a market that is genuinely undecided from producing a
  // confident-looking signal just because one side edged ahead by a point.
  const margin = Math.abs(bullish.score - bearish.score);
  const damped = margin >= 12 ? best.score : Math.round(best.score - (12 - margin) * 1.2);
  const score = Math.max(0, Math.min(100, damped));

  const warnings = [...best.warnings];
  if (margin < 12) warnings.push('Bullish and bearish cases are close — the market has not picked a side.');
  if (options.lastBarClosed === false) warnings.push('Last candle is still forming; entry is unconfirmed until it closes.');

  let tier = tierFor(score, score >= 52 ? direction : 'none');

  // ── The ticket ─────────────────────────────────────────────────────────
  const pattern = bestPatternFor(chartPatterns, side);
  const { ticket, reject } = buildTicket({ side, price: bar.close, atr, structure, levels, pattern, config });

  const actionable = tier === 'LONG' || tier === 'SHORT' || tier === 'STRONG_LONG' || tier === 'STRONG_SHORT';
  if (actionable && ticket === null) {
    // Good idea, wrong price. Demote rather than emit, and say why.
    tier = direction === 'long' ? 'EARLY_LONG' : 'EARLY_SHORT';
    if (reject) warnings.push(reject);
  }

  const pip = pipSize(options.symbol);
  const status = deriveStatus(tier, options.lastBarClosed ?? true);

  const reasons = best.reasons
    .filter((r) => r.points > 0)
    .slice(0, 8)
    .map((r) => `${r.label} (+${r.points})`);

  if (ticket) reasons.push(`Stop ${ticket.stopBasis}; first target at ${ticket.targetBasis} (${ticket.rewardRisk.toFixed(1)}R).`);

  return {
    symbol: options.symbol,
    timeframe: options.timeframe,
    barTime: bar.time,
    barClosed: options.lastBarClosed ?? true,
    direction: score >= 52 ? direction : 'none',
    signal: tier,
    confidence: score,
    marketCondition: marketCondition(structure, neutral !== null),
    status,
    price: bar.close,
    risk: ticket
      ? {
          entry: ticket.entry,
          stop: ticket.stop,
          targets: ticket.targets,
          stopPips: ticket.stopDistance / pip,
          invalidation: `Close beyond ${ticket.stop.toFixed(5)} — ${ticket.stopBasis}.`,
        }
      : { entry: null, stop: null, targets: [], stopPips: null, invalidation: null },
    // The setup's identity: the swing the move is working from. A different
    // origin is a different opportunity, not an update to this one.
    anchor: (side === 'bullish' ? structure.lastSwingLow?.price : structure.lastSwingHigh?.price) ?? null,
    reasons,
    warnings,
    detail: buildDetail({
      bullish: bullish.score,
      bearish: bearish.score,
      margin,
      structure,
      levels,
      chartPatterns,
      candlePatterns,
      emaRead,
      ichiRead,
      momentum,
      higherTrend,
      entryConfirmation,
      ticket,
      atr,
      breakdown: best.reasons,
    }),
  };
}

/**
 * Lifecycle status from the tier.
 *
 * Only an actionable tier on a CLOSED bar is CONFIRMED — that is what the
 * tracker emits on. EARLY and WATCH are visible but never recorded as trades,
 * which is the whole reason those tiers exist.
 */
function deriveStatus(tier: SignalTier, barClosed: boolean): StrategyAnalysis['status'] {
  const actionable = tier === 'LONG' || tier === 'SHORT' || tier === 'STRONG_LONG' || tier === 'STRONG_SHORT';
  if (actionable) return barClosed ? 'CONFIRMED' : 'CONFIRMING';
  if (tier === 'EARLY_LONG' || tier === 'EARLY_SHORT') return 'CONFIRMING';
  return 'FORMING';
}

/**
 * A short, stable label for the performance breakdowns to group by.
 *
 * STRUCTURE FIRST, NOT EXTENSION
 * ──────────────────────────────
 * An earlier version returned OVEREXTENDED ahead of everything else, so any
 * bar more than 3 ATR from the EMA50 was filed under that regardless of what
 * the market was doing. In a trending sample that swallowed most bars and left
 * the regime breakdown unable to answer the one question it exists for —
 * does this strategy do better in a trend than in chop?
 *
 * Extension is a property of the ENTRY, not of the market, and it is already
 * reported where it belongs: as a scoring penalty in the EMA family, as a
 * warning on the signal, and as `ema50.overextended` in the stored detail.
 */
function marketCondition(structure: ReturnType<typeof readStructure>, hasNeutralPattern: boolean): string {
  if (structure.reversalConfirmed) return 'REVERSAL';
  if (structure.trend === 'bullish') return 'TRENDING_BULLISH';
  if (structure.trend === 'bearish') return 'TRENDING_BEARISH';
  if (hasNeutralPattern) return 'COMPRESSION';
  if (structure.trend === 'ranging') return 'RANGING';
  return 'UNCLEAR';
}

/**
 * The full structured read, stored verbatim as the `analysis` JSON column.
 *
 * Every field the spec's final-output list asks for lives here: 4H trend, 1H
 * structure, 15M entry context, BOS, CHoCH, patterns, S/R context, EMA and
 * Ichimoku status, and the score breakdown. Nothing outside the strategy
 * interprets it, so it costs nothing and makes every past decision auditable.
 */
function buildDetail(x: {
  bullish: number;
  bearish: number;
  margin: number;
  structure: ReturnType<typeof readStructure>;
  levels: ReturnType<typeof readLevels>;
  chartPatterns: ReturnType<typeof readChartPatterns>;
  candlePatterns: ReturnType<typeof readCandles>;
  emaRead: ReturnType<typeof readEma>;
  ichiRead: ReturnType<typeof readIchimoku>;
  momentum: number;
  higherTrend: Direction;
  entryConfirmation: Direction;
  ticket: ReturnType<typeof buildTicket>['ticket'];
  atr: number;
  breakdown: { family: string; label: string; points: number }[];
}): Record<string, unknown> {
  return {
    atr: x.atr,
    scores: { bullish: x.bullish, bearish: x.bearish, margin: x.margin },
    higherTimeframeTrend: x.higherTrend,
    entryTimeframeConfirmation: x.entryConfirmation,
    structure: {
      trend: x.structure.trend,
      strength: x.structure.base.strength,
      higherHighs: x.structure.base.higherHighs,
      higherLows: x.structure.base.higherLows,
      lowerHighs: x.structure.base.lowerHighs,
      lowerLows: x.structure.base.lowerLows,
      lastSwingHigh: x.structure.lastSwingHigh?.price ?? null,
      lastSwingLow: x.structure.lastSwingLow?.price ?? null,
    },
    bos: x.structure.bos,
    choch: x.structure.choch,
    reversalConfirmed: x.structure.reversalConfirmed,
    levels: {
      support: x.levels.support?.price ?? null,
      supportTouches: x.levels.support?.touches ?? null,
      resistance: x.levels.resistance?.price ?? null,
      resistanceTouches: x.levels.resistance?.touches ?? null,
      atSupport: x.levels.atSupport,
      atResistance: x.levels.atResistance,
      previousHigh: x.levels.previousHigh,
      previousLow: x.levels.previousLow,
      breakout: x.levels.breakout,
    },
    chartPattern: x.chartPatterns[0] ?? null,
    chartPatterns: x.chartPatterns.slice(0, 4),
    candlePattern: x.candlePatterns[0] ?? null,
    candlePatterns: x.candlePatterns.slice(0, 4),
    ema50: x.emaRead,
    ichimoku: x.ichiRead,
    momentum: x.momentum,
    ticket: x.ticket,
    scoreBreakdown: x.breakdown,
  };
}
