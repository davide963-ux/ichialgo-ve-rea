/**
 * Our own strategy: a Kijun pullback behind a four-of-four Ichimoku gate.
 *
 * Pure Ichimoku. No moving average, no volatility measure from outside the
 * cloud, no other indicator anywhere in this file. A test reads this source
 * and fails if one ever appears.
 *
 * HOW IT DIFFERS FROM OANDA'S PULLBACK, WHICH IS ALSO IMPLEMENTED
 * ──────────────────────────────────────────────────────────────
 * Both trade a pullback to Kijun inside a trend the cloud established, and
 * they are not the same rule. Theirs requires Tenkan on the trade's side and
 * a confirming close back through Kijun on a bullish candle, and looks at
 * nothing else. Ours fires on the touch itself and demands four conditions —
 * cloud colour, the cloud 26 ahead, Chikou and Tenkan — of which only the
 * last appears in their rules at all. See oandaPullback.ts.
 *
 * THE TRADE
 * ─────────
 * Price is clear of the Kumo, so the cloud has a direction. Price pulls back
 * to Kijun-sen and is caught there.
 *
 *     price above the Kumo          <- the cloud sets the direction
 *          |
 *          +- pulls back to Kijun   <- the trigger
 *          |
 *          +- 4 confirmations       <- the gate, not a label
 *
 * WHAT DECIDES WHAT
 * ─────────────────
 *   direction   the Kumo. Above the cloud is long, below is short. NOT which
 *               way price approached the line — that was the old strategy's
 *               mistake, and it meant a pullback in a downtrend became a long.
 *   distance    the 26-bar high-low range. Kijun is that range's midpoint, so
 *               its width is a volatility measure Ichimoku already contains.
 *               This is what replaced the average true range.
 *   gate        four confirmations, all Ichimoku's own. A signal below the
 *               threshold is not produced at all.
 *
 * TWO WAYS A SIGNAL ARRIVES
 * ─────────────────────────
 *   `analyseIchimoku`  walks closed bars and reports every pullback in them,
 *                      plus the band the newest bar leaves price sitting in.
 *   `checkLiveTouch`   takes that band and one quote. It fires the moment
 *                      price reaches the zone, between scans, for no extra
 *                      provider credits — the quote stream is already running.
 *
 * WHAT THIS IS MEASURED TO DO, STATED PLAINLY
 * ───────────────────────────────────────────
 * On the five traded pairs' 1H fixtures, at one pip of cost, the default
 * settings average +3.89 pips over 369 trades, 95% interval -1.63 to +9.40.
 * The interval spans zero, so that is not a profitability claim.
 *
 * It should be trusted even less than the interval suggests. Split by time it
 * is +0.66 on the older 60% and +10.68 on the newer 40%, and EVERY variant
 * tested — including rules with no edge at all — improves by a similar amount
 * across that boundary. The second period was simply kinder. The honest
 * summary is "around break-even on hard data, good on easy data".
 * AUD/USD loses outright, -5.02 pips over 78 trades.
 *
 * The gate is the one setting with evidence behind it, and the evidence is
 * narrower than it first looked. Over the whole sample it improves the result
 * monotonically: +0.33, +1.15, +1.43, +3.89 pips at 1, 2, 3 and 4 of 4. But
 * the gain is concentrated in the HARD half -- on the first 60% it turns -4.00
 * into +0.66, while on the kinder last 40% it is a wash and slightly negative
 * (+11.26 at 2, +10.68 at 4). So 4 buys robustness when conditions are poor
 * rather than more upside when they are good, which is the trade worth
 * making but is not the same claim as "a tighter gate is simply better".
 */
import { ICHIMOKU_SIGNAL_CHECKS, ICHIMOKU_STRATEGY, type IchimokuStrategyConfig } from '../../config/ichimokuStrategy';
import type { Timeframe } from '../../config/timeframes';
import type { IchimokuSeries } from '../../lib/indicators';
import { pipSize } from '../../lib/pips';
import type { Candle } from '../marketData';
import { ichimokuContext, minBarsFor, px, rangeOver, type BarFacts } from './ichimokuBars';
import { buildSignal, signalId, signalTimeMs } from './signalTicket';
import type { Direction, IchimokuLevel, IchimokuSignal, SignalCheck } from './types';

export const STRATEGY = 'ichimoku-kijun' as const;

export { rangeOver, signalTimeMs };
export type { Direction, IchimokuLevel, IchimokuSignal } from './types';

export interface IchimokuAnalysis {
  ichimoku: IchimokuSeries;
  /** The 26-bar range at each bar, in price units. */
  range: (number | null)[];
  signals: IchimokuSignal[];
  /** The band the live watcher follows, from the most recent bar. */
  level: IchimokuLevel | null;
  reason: 'ok' | 'not-enough-bars';
}

export const ichimokuSignalId = (symbol: string, timeframe: Timeframe, barTime: number) =>
  signalId(STRATEGY, symbol, timeframe, barTime);

export function minBars(config: IchimokuStrategyConfig = ICHIMOKU_STRATEGY): number {
  return minBarsFor(config.rangePeriod);
}

/**
 * The four confirmations, in the direction being traded.
 *
 * Written as a list rather than four booleans so the panel that renders them
 * does not have to know what they are — the same panel shows OANDA's rules,
 * which are different checks entirely.
 */
function checksFor(
  f: Pick<BarFacts, 'tenkan' | 'kijun' | 'senkouA' | 'senkouB' | 'aheadA' | 'aheadB' | 'back' | 'bar' | 'cloudBullish'>,
  long: boolean,
  chikouFree: boolean | null,
): SignalCheck[] {
  const futureBullish = f.aheadA === null || f.aheadB === null ? null : f.aheadA > f.aheadB;
  const tenkanAgrees = f.tenkan === null ? false : long ? f.tenkan > f.kijun : f.tenkan < f.kijun;

  return [
    {
      label: `Cloud in effect ${long ? 'bullish' : 'bearish'}`,
      pass: long ? f.cloudBullish : !f.cloudBullish,
      detail: `Senkou A ${px(f.senkouA)} vs B ${px(f.senkouB)}`,
      required: true,
    },
    {
      label: `Cloud 26 bars ahead ${long ? 'bullish' : 'bearish'}`,
      pass: futureBullish === null ? null : long ? futureBullish : !futureBullish,
      detail:
        futureBullish === null
          ? 'the leading cloud is not determined at this bar'
          : `Span A ${px(f.aheadA)} vs B ${px(f.aheadB)}`,
      required: true,
    },
    {
      label: 'Chikou free',
      pass: chikouFree,
      detail:
        chikouFree === null
          ? 'fewer than 26 bars behind this one'
          : `close ${px(f.bar.close)} vs the ${long ? 'high' : 'low'} ${px(long ? f.back?.high : f.back?.low)} 26 bars back`,
      required: true,
    },
    {
      label: `Tenkan ${long ? 'above' : 'below'} Kijun`,
      pass: tenkanAgrees,
      detail: `${px(f.tenkan)} vs ${px(f.kijun)}`,
      required: true,
    },
  ];
}

export function analyseIchimoku(
  candles: readonly Candle[],
  symbol: string,
  timeframe: Timeframe,
  config: IchimokuStrategyConfig = ICHIMOKU_STRATEGY,
  detectedAt = Date.now(),
): IchimokuAnalysis {
  const ctx = ichimokuContext(candles, symbol, config.rangePeriod);

  if (candles.length < minBars(config)) {
    return { ichimoku: ctx.series, range: ctx.range, signals: [], level: null, reason: 'not-enough-bars' };
  }

  const signals: IchimokuSignal[] = [];
  let armed = true;
  let level: IchimokuLevel | null = null;

  for (let i = 1; i < candles.length; i++) {
    const f = ctx.at(i);
    if (!f) continue;

    const band = f.range * config.touchBand;
    const long = f.side === 'above';
    const last = i === candles.length - 1;
    const touched = f.bar.low <= f.kijun + band && f.bar.high >= f.kijun - band;

    const publish = (): IchimokuLevel => ({
      symbol,
      timeframe,
      strategy: STRATEGY,
      kijun: f.kijun,
      tenkan: f.tenkan,
      band,
      range: f.range,
      direction: f.side === 'inside' ? null : long ? 'LONG' : 'SHORT',
      side: f.side,
      armed,
      inBand: touched,
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
    });

    /**
     * Inside the cloud there is no trend to pull back into, so nothing is
     * traded — but the pair is re-armed once price is clearly away from the
     * line, so the next genuine retest is not swallowed by a stale disarm.
     */
    if (f.side === 'inside') {
      if (Math.abs(f.bar.close - f.kijun) > band * config.rearmBands) armed = true;
      if (last) level = publish();
      continue;
    }

    const direction: Direction = long ? 'LONG' : 'SHORT';

    if (touched && armed) {
      const chikouFree = f.back ? (long ? f.bar.close > f.back.high : f.bar.close < f.back.low) : null;
      const checks = checksFor(f, long, chikouFree);
      const score = checks.filter((c) => c.pass === true).length;
      armed = false;

      // The gate. Below the threshold no signal exists — it is not produced
      // and flagged, which is the mistake the previous strategy made.
      if (score >= config.minScore) {
        signals.push(
          buildSignal({
            strategy: STRATEGY,
            symbol,
            timeframe,
            facts: f,
            detectedAt,
            source: 'candle',
            direction,
            entry: f.bar.close,
            checks,
          }),
        );
      }
    }

    if (!armed && Math.abs(f.bar.close - f.kijun) > band * config.rearmBands) armed = true;
    if (last) level = publish();
  }

  return { ichimoku: ctx.series, range: ctx.range, signals, level, reason: 'ok' };
}

/**
 * One quote against one pair's Kijun band.
 *
 * Returns the signal if the tick reached an armed zone AND the four
 * confirmations clear the gate, plus the level as it now stands — the caller
 * stores that back, because arming state is what stops a price sitting on the
 * line from firing on every tick.
 *
 * Chikou is judged against the QUOTE rather than against the last close: the
 * question the check asks is whether the price being traded now is clear of
 * where the market was 26 bars ago, and the close of a bar that has already
 * finished cannot answer that for a tick arriving inside the next one.
 *
 * The level's cloud is the one in effect on the newest bar. It is displaced
 * 26 bars, so it cannot change within a bar and inheriting it costs nothing
 * in accuracy. Tenkan and Kijun do drift as the forming bar moves; they are
 * inherited anyway rather than recomputed, because recomputing them from a
 * half-finished bar would make the live level disagree with the one the next
 * scan publishes for the same bar.
 */
export function checkLiveTouch(
  level: IchimokuLevel,
  price: number,
  at: number,
  config: IchimokuStrategyConfig = ICHIMOKU_STRATEGY,
): { signal: IchimokuSignal | null; level: IchimokuLevel } {
  if (level.strategy !== STRATEGY) return { signal: null, level };

  const distance = Math.abs(price - level.kijun);
  const inBand = distance <= level.band;
  const clear = distance > level.band * config.rearmBands;

  /**
   * `inBand` follows the quote on every tick, whatever else happens, so the
   * UI's "a pullback is in progress" state is live rather than as of the last
   * closed bar.
   */
  const track = (patch: Partial<IchimokuLevel> = {}): IchimokuLevel =>
    level.inBand === inBand && Object.keys(patch).length === 0
      ? level
      : { ...level, inBand, updatedAt: at, ...patch };

  // Inside the cloud there is no trend to pull back into. Arming still has to
  // be maintained, or the pair comes out of the cloud permanently disarmed.
  if (level.direction === null) {
    return { signal: null, level: track(!level.armed && clear ? { armed: true } : {}) };
  }
  if (!inBand) {
    return { signal: null, level: track(!level.armed && clear ? { armed: true } : {}) };
  }
  if (!level.armed) return { signal: null, level: track() };

  const long = level.direction === 'LONG';
  const edge = long ? level.backHigh : level.backLow;
  const chikouFree = edge === null ? null : long ? price > edge : price < edge;

  const checks = checksFor(
    {
      tenkan: level.tenkan,
      kijun: level.kijun,
      senkouA: level.senkouA,
      senkouB: level.senkouB,
      aheadA: level.senkouAheadA,
      aheadB: level.senkouAheadB,
      back: level.backHigh === null ? undefined : ({ high: level.backHigh, low: level.backLow } as Candle),
      bar: { close: price } as Candle,
      cloudBullish: level.cloudBullish,
    },
    long,
    chikouFree,
  );
  const score = checks.filter((c) => c.pass === true).length;

  // Disarm whether or not it scored: the pullback has happened, and a rule
  // that kept firing until one tick happened to pass the gate would turn the
  // gate into "wait for the noisiest moment".
  const next: IchimokuLevel = { ...level, armed: false, inBand: true, updatedAt: at };
  if (score < config.minScore) return { signal: null, level: next };

  const pip = pipSize(level.symbol);
  return {
    signal: buildSignal({
      strategy: STRATEGY,
      symbol: level.symbol,
      timeframe: level.timeframe,
      facts: {
        i: -1,
        bar: { time: level.barTime, open: price, high: price, low: price, close: price, volume: null, complete: false },
        tenkan: level.tenkan,
        kijun: level.kijun,
        senkouA: level.senkouA,
        senkouB: level.senkouB,
        aheadA: level.senkouAheadA,
        aheadB: level.senkouAheadB,
        range: level.range,
        side: long ? 'above' : 'below',
        cloudBullish: level.cloudBullish,
        cloudPips: Math.abs(level.senkouA - level.senkouB) / pip,
        back: undefined,
        pip,
      },
      detectedAt: at,
      source: 'live',
      direction: level.direction,
      entry: price,
      checks,
      barTime: level.barTime,
    }),
    level: next,
  };
}

export { ICHIMOKU_SIGNAL_CHECKS };
