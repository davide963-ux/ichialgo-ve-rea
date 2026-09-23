/**
 * Market structure: swings, trend, and the two break events.
 *
 * BOS vs CHoCH — THE DISTINCTION THAT MATTERS
 * ───────────────────────────────────────────
 * Both are "price broke a swing level". What separates them is the trend that
 * was in force when it happened:
 *
 *   uptrend + break of the last swing HIGH  → BOS   (continuation)
 *   uptrend + break of the last swing LOW   → CHoCH (character change)
 *   downtrend + break of the last swing LOW → BOS   (continuation)
 *   downtrend + break of the last swing HIGH→ CHoCH (character change)
 *
 * So the SAME price action is a BOS or a CHoCH depending on context, and an
 * engine that detects "a swing broke" without asking which way the trend was
 * running cannot tell continuation from reversal. They are never required
 * together: a BOS confirms what is already happening, a CHoCH warns that it
 * may be ending. A CHoCH followed by a BOS in the NEW direction is the
 * strongest reversal evidence available, and is reported as such.
 *
 * WHY BREAKS NEED A BUFFER
 * ────────────────────────
 * A break is a CLOSE beyond the level plus a buffer in typical range. Using the wick
 * makes every stop-hunt a structural event, and using a bare close makes a
 * one-pip overshoot a signal. The buffer scales with volatility so the same
 * rule works on EUR/CHF and GBP/JPY.
 */
import { analyseStructure, findSwings, type MarketStructure, type Swing } from '../../../lib/indicators/marketStructure';
import type { Candle } from '../../marketData/types';
import type { EngineConfig } from './config';

export type BreakKind = 'BOS' | 'CHoCH';

export interface BreakEvent {
  kind: BreakKind;
  direction: 'bullish' | 'bearish';
  /** Bar index the break closed on. */
  index: number;
  /** Bars ago, relative to the bar being analysed. */
  barsAgo: number;
  /** The swing level that was broken. */
  level: number;
  /** How far beyond the level it closed, in typical range. */
  strengthRatio: number;
}

export interface StructureRead {
  /** The underlying HH/HL/LH/LL reading. */
  base: MarketStructure;
  /** Plain trend label used everywhere downstream. */
  trend: 'bullish' | 'bearish' | 'ranging' | 'unclear';
  /** Most recent BOS, if one happened inside the freshness window. */
  bos: BreakEvent | null;
  /** Most recent CHoCH, same window. */
  choch: BreakEvent | null;
  /**
   * True when a CHoCH was followed by a BOS in the NEW direction.
   * The strongest reversal evidence the structure layer can produce.
   */
  reversalConfirmed: boolean;
  /** Every break found in the window, newest last. Useful for explanations. */
  events: BreakEvent[];
  lastSwingHigh: Swing | null;
  lastSwingLow: Swing | null;
}

const trendOf = (m: MarketStructure): StructureRead['trend'] =>
  m.direction === 'up' ? 'bullish' : m.direction === 'down' ? 'bearish' : m.direction === 'range' ? 'ranging' : 'unclear';

/**
 * Walk forward through the swings, deciding what each break was AT THE TIME.
 *
 * The trend is recomputed as it goes rather than taken from the end of the
 * series. Classifying a break that happened forty bars ago using today's trend
 * is hindsight, and it systematically relabels the CHoCH that STARTED the
 * current trend as a BOS — erasing exactly the reversal the engine is looking
 * for.
 */
export function readStructure(
  candles: readonly Candle[],
  end: number,
  config: EngineConfig,
  scaleAt: number | null,
): StructureRead {
  const opts = {
    fractalWings: config.structure.fractalWings,
    swingLookback: config.structure.swingLookback,
    maxBars: config.structure.maxBars,
    minSwingAtr: config.structure.minSwingRange,
  };
  const base = analyseStructure(candles, end, opts, scaleAt);
  const scale = scaleAt !== null && scaleAt > 0 ? scaleAt : null;
  const buffer = scale === null ? 0 : scale * config.structure.breakBufferRange;

  const events: BreakEvent[] = [];
  const swings = base.swings;

  if (scale !== null && swings.length >= 2) {
    const first = swings[0]!.index;
    // The trend as it stood before each break, rebuilt bar by bar.
    for (let i = first + 1; i <= end; i++) {
      const bar = candles[i];
      if (!bar) continue;

      // Swings CONFIRMED before this bar — a fractal needs its right wing, so
      // a swing is only knowable `fractalWings` bars after it printed.
      const known = swings.filter((s) => s.index + config.structure.fractalWings < i);
      if (known.length < 2) continue;

      const highs = known.filter((s) => s.kind === 'high');
      const lows = known.filter((s) => s.kind === 'low');
      const lastHigh = highs[highs.length - 1];
      const lastLow = lows[lows.length - 1];

      // Trend in force at bar i, from the swings known by then.
      const priorTrend = trendOf(analyseStructure(candles, i - 1, opts, scale));

      if (lastHigh && bar.close > lastHigh.price + buffer) {
        const kind: BreakKind = priorTrend === 'bearish' ? 'CHoCH' : 'BOS';
        events.push({
          kind,
          direction: 'bullish',
          index: i,
          barsAgo: end - i,
          level: lastHigh.price,
          strengthRatio: (bar.close - lastHigh.price) / scale,
        });
      } else if (lastLow && bar.close < lastLow.price - buffer) {
        const kind: BreakKind = priorTrend === 'bullish' ? 'CHoCH' : 'BOS';
        events.push({
          kind,
          direction: 'bearish',
          index: i,
          barsAgo: end - i,
          level: lastLow.price,
          strengthRatio: (lastLow.price - bar.close) / scale,
        });
      }
    }
  }

  // Collapse runs: one trend leg produces a break on every bar that keeps
  // extending, and reporting forty of them would drown the explanation.
  const deduped: BreakEvent[] = [];
  for (const e of events) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.kind === e.kind && prev.direction === e.direction && e.index - prev.index <= 2) {
      deduped[deduped.length - 1] = e;
    } else {
      deduped.push(e);
    }
  }

  const fresh = deduped.filter((e) => e.barsAgo <= config.structure.freshnessBars);
  const bos = [...fresh].reverse().find((e) => e.kind === 'BOS') ?? null;
  const choch = [...fresh].reverse().find((e) => e.kind === 'CHoCH') ?? null;

  // CHoCH first, then a BOS in the SAME direction as the CHoCH. A BOS the
  // other way is the old trend resuming, which is the opposite of confirmation.
  const lastChoch = [...deduped].reverse().find((e) => e.kind === 'CHoCH') ?? null;
  const reversalConfirmed =
    lastChoch !== null &&
    deduped.some(
      (e) => e.kind === 'BOS' && e.index > lastChoch.index && e.direction === lastChoch.direction,
    ) &&
    end - lastChoch.index <= config.structure.freshnessBars * 3;

  return {
    base,
    trend: trendOf(base),
    bos,
    choch,
    reversalConfirmed,
    events: deduped,
    lastSwingHigh: base.lastSwingHigh,
    lastSwingLow: base.lastSwingLow,
  };
}

/** Swings only, for callers that need levels without the break analysis. */
export function swingsOf(candles: readonly Candle[], end: number, config: EngineConfig, scaleAt: number | null): Swing[] {
  return findSwings(
    candles,
    end,
    {
      fractalWings: config.structure.fractalWings,
      swingLookback: config.structure.swingLookback,
      maxBars: config.structure.maxBars,
      minSwingAtr: config.structure.minSwingRange,
    },
    scaleAt,
  );
}
