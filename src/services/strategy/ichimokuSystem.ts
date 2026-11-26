/**
 * The Ichimoku system, from OANDA's Ichimoku Cloud trading guide.
 *
 * Four approaches that "work together", as one detector:
 *
 *   entry A   Kumo breakout — a trend CHANGE after consolidation
 *   entry B   Tenkan/Kijun pullback — a trend CONTINUATION
 *   filter    Chikou against its prior 26-period price, on both
 *   geometry  the Kumo and Kijun as support and resistance, which is where
 *             the stop goes
 *
 *                   price vs the Kumo
 *                          |
 *          +---------------+---------------+
 *          |                               |
 *      crossed it                    already clear of it
 *          |                               |
 *     cloud ahead turns             Tenkan on the trade's side
 *     the same way                         |
 *          |                         pullback reaches Tenkan or Kijun
 *          |                               |
 *          |                         closes back through Kijun on a
 *          |                         candle of the trade's own colour
 *          |                               |
 *          +---------------+---------------+
 *                          |
 *                  Chikou clear of its prior 26-period close
 *                          |
 *                       SIGNAL
 *                          |
 *          stop beyond the structure the entry relied on:
 *            breakout -> the far cloud edge
 *            pullback -> Kijun-sen
 *
 * THE RULES, QUOTED
 * ─────────────────
 * Breakout: "Price breaks above the cloud." / "Cloud is turning bullish
 * (Span A crossing above span B)". Bearish is the mirror.
 *
 * Pullback, bullish: "Price above the Cloud (green coloured)." —
 *   "Tenkan-sen (Conversion line) is above Kijun-sen (Base line)."
 *   "Pullback touches or dips slightly below Tenkan-sen (Conversion line) or
 *    Kijun-sen (Base line)."
 *   "Price closes above Kijun-sen (Base line) with a bullish candlestick."
 * Bearish: price below the Cloud, Tenkan below Kijun, pullback touches or
 * rebounds slightly above either line, close below Kijun on a bearish candle.
 *
 * Chikou: "the lagging span is being used as a trend confirmation tool to
 * filter out false breakouts from prior consolidation/sideways ranges."
 * Bullish needs it "above its prior 26-period price", bearish below.
 *
 * TWO THINGS THAT LOOK LIKE DETAILS AND ARE NOT
 * ────────────────────────────────────────────
 * 1. BOTH ENTRIES ARE TWO-STAGE. A breakout waits for the span twist and a
 *    pullback waits for its confirming close, and in the article's own
 *    examples the second event arrives hours or a day later — AUD/USD broke
 *    at 1am SGT and Span A crossed at 4am; NZD/USD broke down on 18 November
 *    and crossed on the 19th. An implementation that tested both conditions
 *    on one bar would reject every illustration in the article it claims to
 *    follow.
 *
 * 2. CHIKOU IS AGAINST THAT BAR'S CLOSE. OANDA compares the lagging span with
 *    "its prior 26-period PRICE". A stricter test against the whole bar's
 *    range is defensible and is a different rule, so it is not used here.
 */
import { ICHIMOKU, type EntryType, type IchimokuConfig } from '../../config/ichimokuStrategy';
import type { Timeframe } from '../../config/timeframes';
import type { IchimokuSeries } from '../../lib/indicators';
import type { Candle } from '../marketData';
import { bearishCandle, bullishCandle, ichimokuContext, minBarsFor, px, rangeOver, type BarFacts } from './ichimokuBars';
import { buildSignal, openExit, signalId, signalTimeMs, stepExit, type ExitRules, type ExitState } from './signalTicket';
import type { Direction, IchimokuLevel, IchimokuSignal, SignalCheck } from './types';

export const STRATEGY = 'ichimoku' as const;

export { rangeOver, signalTimeMs };
export type { Direction, IchimokuLevel, IchimokuSignal } from './types';

export interface IchimokuAnalysis {
  ichimoku: IchimokuSeries;
  /** The 26-bar range at each bar, in price units. */
  range: (number | null)[];
  signals: IchimokuSignal[];
  /** What the newest bar leaves the pair sitting in, for the live watcher. */
  level: IchimokuLevel | null;
  reason: 'ok' | 'not-enough-bars';
}

export const ichimokuSignalId = (symbol: string, timeframe: Timeframe, barTime: number) =>
  signalId(STRATEGY, symbol, timeframe, barTime);

export const minBars = (config: IchimokuConfig = ICHIMOKU): number => minBarsFor(config.rangePeriod);

/** OANDA's Chikou test: the lagging span against its prior 26-period close. */
function chikouClear(f: BarFacts, long: boolean): boolean | null {
  if (!f.back) return null;
  return long ? f.bar.close > f.back.close : f.bar.close < f.back.close;
}

/** Is the cloud being drawn 26 ahead the trade's colour? */
function twisted(f: BarFacts, long: boolean): boolean | null {
  if (f.aheadA === null || f.aheadB === null) return null;
  return long ? f.aheadA > f.aheadB : f.aheadA < f.aheadB;
}

/**
 * "Pullback touches or dips slightly below Tenkan-sen or Kijun-sen."
 *
 * With Tenkan on the trade's side — which the setup requires — Tenkan is the
 * nearer line, so reaching either means the low (or high) got to Tenkan.
 * Which line it actually reached is reported, because a dip to Kijun is a
 * deeper pullback than a dip to Tenkan and a reader should see which.
 */
function pullbackLine(bar: Candle, tenkan: number | null, kijun: number, long: boolean): 'tenkan' | 'kijun' | null {
  if (long) {
    if (bar.low <= kijun) return 'kijun';
    if (tenkan !== null && bar.low <= tenkan) return 'tenkan';
    return null;
  }
  if (bar.high >= kijun) return 'kijun';
  if (tenkan !== null && bar.high >= tenkan) return 'tenkan';
  return null;
}

/** The pullback's two standing conditions: clear of the cloud, Tenkan agreeing. */
function pullbackSetupHolds(f: BarFacts, long: boolean): boolean {
  if (long ? f.side !== 'above' : f.side !== 'below') return false;
  if (f.tenkan === null) return false;
  return long ? f.tenkan > f.kijun : f.tenkan < f.kijun;
}

/**
 * Where the stop goes: beyond whatever the entry relied on.
 *
 * This is the article's own geometry, not a number chosen to make the
 * backtest look better. Kijun "acts as dynamic support/resistance"; the Kumo
 * is "a potential future support zone if price is above the Cloud". A
 * pullback is a bet that the base line holds, so its stop sits beyond the
 * base line. A breakout is a bet that price has left the zone, so its stop
 * sits beyond the far edge of that zone — a stop inside the cloud would be
 * taken out by the cloud the trade just crossed.
 *
 * The buffer is ours: a stop exactly on the line is taken out by the wick
 * that retests it.
 */
function stopFor(f: BarFacts, entry: EntryType, long: boolean, config: IchimokuConfig): { stop: number; level: number } {
  const buffer = f.range * config.stopBuffer;
  const level =
    entry === 'pullback' ? f.kijun : long ? Math.min(f.senkouA, f.senkouB) : Math.max(f.senkouA, f.senkouB);
  return { stop: long ? level - buffer : level + buffer, level };
}

/**
 * A position this pair is holding, and the reason it stays quiet.
 *
 * ONE TRADE PER PAIR, AND THE DETECTOR IS WHERE THAT LIVES
 * ───────────────────────────────────────────────────────
 * A signal is an instruction to open a trade. While that trade is running,
 * another signal on the same pair is not a second opportunity — it is the
 * same money, already committed. So the pair goes quiet from the moment a
 * signal fires until price touches its stop or its target.
 *
 * This belongs HERE rather than in each consumer, and that is the whole
 * point. The backtest enforced it (`skippedWhileOpen`) and the live scanner
 * did not: it wrote every signal in its lookback window as a separate open
 * trade, so one pair could hold eight at once. The two then measured
 * different strategies — the backtest reporting one trade where the stored
 * history reported eight — and nothing in the code said which was right.
 * With the rule inside the detector, every caller gets it by construction:
 * the backtest, the live engine in the browser, and the scanner that writes
 * the database all run this same function.
 *
 * It costs signal volume, and a lot of it: around 89% of what the raw rules
 * produced was a signal the account could not have acted on.
 */
interface OpenPosition {
  /** The levels the trade opened with, break-even trigger included. */
  rules: ExitRules;
  /** How far through those rules it has got — the stop may have moved. */
  state: ExitState;
  /** Bar index of the fill, so the entry bar itself cannot close the trade. */
  at: number;
  barTime: number;
  kind: EntryType;
}

/** What the detector is waiting for between the two bars of a setup. */
interface Pending {
  kind: EntryType;
  direction: Direction;
  at: number;
  /** For a breakout: the close that crossed. For a pullback: the extreme reached. */
  price: number;
  line?: 'tenkan' | 'kijun';
  cloudPips?: number;
}

/**
 * The pair's current state, as the dashboard and the pair page read it.
 *
 * Built in two places — a bar the detector worked through, and a bar it
 * skipped because a trade was running — so it is a function rather than a
 * literal. The two differ only in what is passed for `pending` and
 * `position`, and a pair cannot be both: a setup is what you have before a
 * trade, a position is what you have after it.
 */
function levelAt(
  f: BarFacts,
  symbol: string,
  timeframe: Timeframe,
  detectedAt: number,
  clear: boolean,
  long: boolean,
  pending: Pending | null,
  position: OpenPosition | null,
): IchimokuLevel {
  return {
    symbol,
    timeframe,
    kijun: f.kijun,
    tenkan: f.tenkan,
    band: f.tenkan === null ? Math.abs(f.senkouA - f.senkouB) : Math.abs(f.tenkan - f.kijun),
    range: f.range,
    direction: clear ? (long ? 'LONG' : 'SHORT') : null,
    side: f.side,
    // Armed means "able to take a setup": not already in one, and not
    // already in a trade.
    armed: pending === null && position === null,
    pending: pending?.kind ?? null,
    inBand: pending !== null,
    openTrade: position
      ? {
          direction: position.rules.direction,
          entryType: position.kind,
          entry: position.rules.entry,
          // The stop as it stands NOW, which is the entry once break-even has
          // armed — showing the original would misstate the live risk.
          stop: position.state.stop,
          target: position.rules.target,
          movedToBreakEven: position.state.movedToBreakEven,
          barTime: position.barTime,
        }
      : null,
    barTime: f.bar.time,
    updatedAt: detectedAt,
    senkouA: f.senkouA,
    senkouB: f.senkouB,
    senkouAheadA: f.aheadA,
    senkouAheadB: f.aheadB,
    cloudBullish: f.cloudBullish,
    tenkanAgrees: f.tenkan === null ? false : long ? f.tenkan > f.kijun : f.tenkan < f.kijun,
    backHigh: f.back?.high ?? null,
    backLow: f.back?.low ?? null,
    backClose: f.back?.close ?? null,
  };
}

export function analyseIchimoku(
  candles: readonly Candle[],
  symbol: string,
  timeframe: Timeframe,
  config: IchimokuConfig = ICHIMOKU,
  detectedAt = Date.now(),
): IchimokuAnalysis {
  const ctx = ichimokuContext(candles, symbol, config.rangePeriod);

  if (candles.length < minBars(config)) {
    return { ichimoku: ctx.series, range: ctx.range, signals: [], level: null, reason: 'not-enough-bars' };
  }

  const signals: IchimokuSignal[] = [];
  let pending: Pending | null = null;
  let position: OpenPosition | null = null;
  let prevSide: BarFacts['side'] | null = null;
  let level: IchimokuLevel | null = null;

  /**
   * Record the signal and return the position it opens, or null if the
   * ticket is unusable.
   *
   * It RETURNS the position rather than assigning it, so the one place a
   * pair becomes committed is visible at the call site. (TypeScript also
   * cannot narrow a variable written only inside a closure, so the hidden
   * version made `position` read as `never` further down — a good sign that
   * the side effect was in the wrong place.)
   */
  const emit = (f: BarFacts, kind: EntryType, direction: Direction, checks: SignalCheck[]): OpenPosition | null => {
    const long = direction === 'LONG';
    const { stop, level: stopLevel } = stopFor(f, kind, long, config);
    const entry = f.bar.close;
    const risk = Math.abs(entry - stop);
    if (risk <= 0) return null;
    const target = long ? entry + risk * config.rewardMultiple : entry - risk * config.rewardMultiple;
    /**
     * Break-even arms a fixed number of pips into profit and moves the stop
     * a smaller fixed number the same way — far enough past the entry that
     * the scratch covers the spread rather than paying it. Null when off.
     */
    const ahead = (pips: number) => (long ? entry + pips * f.pip : entry - pips * f.pip);
    const breakEven =
      config.breakEvenAtPips > 0
        ? { trigger: ahead(config.breakEvenAtPips), stop: ahead(config.breakEvenLockPips) }
        : null;

    signals.push(
      buildSignal(
        {
          strategy: STRATEGY,
          symbol,
          timeframe,
          facts: f,
          detectedAt,
          source: 'candle',
          direction,
          entry,
          checks,
        },
        {
          stop,
          target,
          stopLevel,
          entryType: kind,
          breakEven: breakEven?.trigger ?? null,
          breakEvenStop: breakEven?.stop ?? null,
        },
      ),
    );
    // The pair is now committed, and stays that way until price decides.
    const rules: ExitRules = { direction, entry, stop, target, breakEven };
    return { rules, state: openExit(rules), at: f.i, barTime: f.bar.time, kind };
  };

  for (let i = 1; i < candles.length; i++) {
    const f = ctx.at(i);
    const last = i === candles.length - 1;
    if (!f) {
      continue;
    }

    const long = f.side === 'above';
    const short = f.side === 'below';
    const clear = long || short;

    // ── a position in progress holds the pair ────────────────────────────
    // Checked before anything else, because while a trade is running there
    // is nothing to arm and nothing to confirm: the next thing that happens
    // on this pair is its stop or its target.
    if (position) {
      // The fill was at the entry bar's CLOSE, so everything that bar did is
      // already behind the position — letting it resolve the trade would be
      // deciding it against a bar it never held.
      if (i > position.at) {
        const held = position;
        const { exit, state } = stepExit(f.bar, held.rules, held.state);
        // A break-even exit frees the pair exactly as a stop or target does:
        // the money is no longer committed, whatever the outcome was called.
        if (exit !== null) position = null;
        else held.state = state;
      }

      if (position) {
        /**
         * prevSide is updated even though this bar is skipped, and that is
         * load-bearing. Leaving it stale would make the first bar after the
         * exit compare against the cloud side from BEFORE the trade, and a
         * pair that crossed the cloud mid-trade would then report a "break"
         * on a bar where nothing crossed. The break happened while we were
         * committed elsewhere; it is not ours to take afterwards.
         */
        prevSide = f.side;
        if (last) level = levelAt(f, symbol, timeframe, detectedAt, clear, long, null, position);
        continue;
      }
    }

    // ── a cloud break ARMS the breakout setup ────────────────────────────
    // A break is a TRANSITION. Price that has been above the cloud for fifty
    // bars has not "broken above" it, and testing the state instead would
    // fire continuously through every trend.
    if (prevSide !== null && f.side !== prevSide && clear) {
      pending = {
        kind: 'breakout',
        direction: long ? 'LONG' : 'SHORT',
        at: i,
        price: f.bar.close,
        cloudPips: f.cloudPips,
      };
    }
    prevSide = f.side;

    // ── expire a setup whose own conditions have gone ────────────────────
    if (pending) {
      const wantLong = pending.direction === 'LONG';
      const stillClear = wantLong ? long : short;
      const limit = pending.kind === 'breakout' ? config.twistWithinBars : config.confirmWithinBars;
      if (!stillClear || i - pending.at > limit) pending = null;
      else if (pending.kind === 'pullback' && !pullbackSetupHolds(f, wantLong)) pending = null;
    }

    if (last) level = levelAt(f, symbol, timeframe, detectedAt, clear, long, pending, position);

    if (!clear) continue; // inside the cloud: no trend either to start or resume
    const direction: Direction = long ? 'LONG' : 'SHORT';
    const chikou = chikouClear(f, long);

    // ── entry A: the breakout completes when the cloud ahead turns ───────
    // Taken first: a cloud break is the rarer and more significant event, and
    // a bar that is both a break confirmation and a pullback confirmation is
    // the start of a trend rather than the resumption of one.
    if (pending?.kind === 'breakout' && pending.direction === direction) {
      const twist = twisted(f, long);
      if (twist === true && (chikou === true)) {
        const bars = i - pending.at;
        const opened = emit(f, 'breakout', direction, [
          {
            label: `Price broke ${long ? 'above' : 'below'} the Cloud`,
            pass: true,
            detail: bars === 0 ? `on this bar, close ${px(pending.price)}` : `${bars} bar${bars === 1 ? '' : 's'} ago, close ${px(pending.price)}`,
            required: true,
          },
          {
            label: `Cloud turning ${long ? 'bullish' : 'bearish'}`,
            pass: true,
            detail: `Span A ${px(f.aheadA)} ${long ? '>' : '<'} Span B ${px(f.aheadB)}, 26 bars ahead`,
            required: true,
          },
          {
            label: 'Chikou clear of its prior 26-period price',
            pass: true,
            detail: `close ${px(f.bar.close)} vs ${px(f.back?.close)} 26 bars back`,
            required: true,
          },
          {
            /**
             * Not a gate. OANDA: "price breakouts and breakdowns through a
             * thick Cloud are considered more significant." A thin-cloud
             * break is still a break, just a weaker one — and it already
             * costs less, because the stop sits beyond a thinner zone.
             */
            label: 'Broke through a thick Cloud',
            pass: (pending.cloudPips ?? 0) >= (f.range / f.pip) * 0.15,
            detail: `cloud was ${(pending.cloudPips ?? 0).toFixed(1)} pips thick at the break`,
            required: false,
          },
        ]);
        if (opened) {
          position = opened;
          pending = null;
          continue;
        }
      }
    }

    // ── entry B: the pullback completes on its confirming close ──────────
    if (pullbackSetupHolds(f, long)) {
      if (pending?.kind === 'pullback' && pending.direction === direction && i > pending.at) {
        const closedThrough = long ? f.bar.close > f.kijun : f.bar.close < f.kijun;
        const candleAgrees = long ? bullishCandle(f.bar) : bearishCandle(f.bar);
        const chikouOk = !config.chikouFiltersPullback || chikou === true;

        if (closedThrough && candleAgrees && chikouOk) {
          const bars = i - pending.at;
            const opened = emit(f, 'pullback', direction, [
            {
              label: `Price ${long ? 'above' : 'below'} the Cloud`,
              pass: true,
              detail: `close ${px(f.bar.close)} is ${f.side} the Kumo (${px(f.senkouA)} / ${px(f.senkouB)})`,
              required: true,
            },
            {
              label: `Tenkan ${long ? 'above' : 'below'} Kijun`,
              pass: true,
              detail: `${px(f.tenkan)} vs ${px(f.kijun)}`,
              required: true,
            },
            {
              label: `Pullback reached ${pending.line === 'kijun' ? 'Kijun-sen' : 'Tenkan-sen'}`,
              pass: true,
              detail: `${bars} bar${bars === 1 ? '' : 's'} ago, ${long ? 'low' : 'high'} ${px(pending.price)}`,
              required: true,
            },
            {
              label: `Closed ${long ? 'above' : 'below'} Kijun with a ${long ? 'bullish' : 'bearish'} candle`,
              pass: true,
              detail: `open ${px(f.bar.open)} -> close ${px(f.bar.close)}, Kijun ${px(f.kijun)}`,
              required: true,
            },
            {
              label: 'Chikou clear of its prior 26-period price',
              pass: chikou,
              detail:
                chikou === null
                  ? 'fewer than 26 bars behind this one'
                  : `close ${px(f.bar.close)} vs ${px(f.back?.close)} 26 bars back`,
              required: config.chikouFiltersPullback,
            },
          ]);
          if (opened) {
            position = opened;
            pending = null;
            continue;
          }
        }
      }

      // A touch arms (or re-arms) the pullback — but never over a breakout
      // that is still waiting for its twist, which is the bigger event.
      const line = pullbackLine(f.bar, f.tenkan, f.kijun, long);
      if (line && pending?.kind !== 'breakout') {
        pending = { kind: 'pullback', direction, at: i, price: long ? f.bar.low : f.bar.high, line };
      }
    }
  }

  return { ichimoku: ctx.series, range: ctx.range, signals, level, reason: 'ok' };
}
