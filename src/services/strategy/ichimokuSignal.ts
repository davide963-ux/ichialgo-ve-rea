/**
 * Pure Ichimoku. No moving average, no volatility measure from outside the
 * cloud, no other indicator anywhere in this file. A test reads this source
 * and fails if one ever appears.
 *
 * THE TRADE
 * ─────────
 * Price is clear of the Kumo, so the cloud has a direction. Price pulls back
 * to Kijun-sen and is caught there. That is the whole setup: a retest of the
 * base line inside a trend the cloud already established.
 *
 *     price above the Kumo          ← the cloud sets the direction
 *          │
 *          ├─ pulls back to Kijun   ← the trigger
 *          │
 *          └─ 4 confirmations       ← the gate, not a label
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
 * Both produce the same shape, scored by the same four checks against the
 * same gate, and share an id per bar, so the closed bar's version replaces
 * the live one rather than adding a second row.
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
 * the gain is concentrated in the HARD half — on the first 60% it turns -4.00
 * into +0.66, while on the kinder last 40% it is a wash and slightly negative
 * (+11.26 at 2, +10.68 at 4). So 4 buys robustness when conditions are poor
 * rather than more upside when they are good, which is the trade worth
 * making but is not the same claim as "a tighter gate is simply better".
 *
 * The fixtures are 1H and the scanner runs 30M, so none of this is settled
 * for the timeframe actually traded.
 */
import { ICHIMOKU_SIGNAL_CHECKS, ICHIMOKU_STRATEGY, type IchimokuStrategyConfig } from '../../config/ichimokuStrategy';
import type { Timeframe } from '../../config/timeframes';
import { cloudIsBullish, ichimoku, kumoSide, type IchimokuSeries } from '../../lib/indicators';
import { pipSize } from '../../lib/pips';
import type { Candle } from '../marketData';
import type { Direction, IchimokuLevel, IchimokuSignal } from './types';

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
  `ichimoku-kijun|${symbol}|${timeframe}|${barTime}`;

/**
 * When a signal happened, in ms.
 *
 * A live signal happened when the tick arrived; a closed-bar one happened on
 * its bar. Sorting the log by `detectedAt` alone would put a bar that closed
 * an hour ago above a tick from a second ago whenever a scan ran in between.
 */
export const signalTimeMs = (s: Pick<IchimokuSignal, 'source' | 'barTime' | 'detectedAt'>): number =>
  s.source === 'live' ? s.detectedAt : s.barTime * 1000;

/**
 * Highest high minus lowest low over `period` bars ending at each index.
 *
 * This is the strategy's entire notion of distance. It is not a new
 * indicator: Kijun-sen is the midpoint of exactly this window, so the range
 * is already implied by the line being traded.
 */
export function rangeOver(candles: readonly Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (period < 1) return out;
  for (let i = period - 1; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      const c = candles[j]!;
      if (c.high > hi) hi = c.high;
      if (c.low < lo) lo = c.low;
    }
    out[i] = hi - lo;
  }
  return out;
}

/**
 * Bars needed before anything is reported: Senkou B's 52 plus the 26-bar
 * displacement, so a cloud is actually in effect at the bar being judged,
 * plus the range window.
 */
export function minBars(config = ICHIMOKU_STRATEGY): number {
  return 52 + 26 + config.rangePeriod;
}

/** The four confirmations, in the direction being traded. */
function scoreChecks(
  long: boolean,
  cloudBullish: boolean,
  futureCloudBullish: boolean | null,
  chikouFree: boolean | null,
  tenkanAgrees: boolean,
): number {
  const checks = [
    long ? cloudBullish : !cloudBullish,
    futureCloudBullish === null ? false : long ? futureCloudBullish : !futureCloudBullish,
    chikouFree === true,
    tenkanAgrees,
  ];
  return checks.filter(Boolean).length;
}

export function analyseIchimoku(
  candles: readonly Candle[],
  symbol: string,
  timeframe: Timeframe,
  config: IchimokuStrategyConfig = ICHIMOKU_STRATEGY,
  detectedAt = Date.now(),
): IchimokuAnalysis {
  const series = ichimoku(candles);
  const range = rangeOver(candles, config.rangePeriod);

  if (candles.length < minBars(config)) {
    return { ichimoku: series, range, signals: [], level: null, reason: 'not-enough-bars' };
  }

  const pip = pipSize(symbol);
  const shift = series.config.displacement;
  const signals: IchimokuSignal[] = [];
  let armed = true;
  let level: IchimokuLevel | null = null;

  for (let i = 1; i < candles.length; i++) {
    const bar = candles[i]!;
    const kijun = series.kijun[i];
    const senkouA = series.senkouA[i];
    const senkouB = series.senkouB[i];
    const r = range[i];
    if (kijun == null || senkouA == null || senkouB == null || r == null || r <= 0) continue;

    const side = kumoSide(series, i, bar.close);
    const bullish = cloudIsBullish(series, i);
    if (side === null || bullish === null) continue;

    const band = r * config.touchBand;
    const long = side === 'above';
    const tenkan = series.tenkan[i] ?? null;
    const tenkanAgrees = tenkan === null ? false : long ? tenkan > kijun : tenkan < kijun;

    // The cloud 26 bars ahead: known today, and what the trend walks into.
    const aheadA = series.senkouARaw[i] ?? null;
    const aheadB = series.senkouBRaw[i] ?? null;
    const futureCloudBullish = aheadA === null || aheadB === null ? null : aheadA > aheadB;

    const back = candles[i - shift];
    const last = i === candles.length - 1;
    const touched = bar.low <= kijun + band && bar.high >= kijun - band;

    const publish = (): IchimokuLevel => ({
      symbol,
      timeframe,
      kijun,
      band,
      range: r,
      direction: side === 'inside' ? null : long ? 'LONG' : 'SHORT',
      side,
      armed,
      inBand: touched,
      barTime: bar.time,
      updatedAt: detectedAt,
      tenkan,
      senkouA,
      senkouB,
      cloudBullish: bullish,
      futureCloudBullish,
      tenkanAgrees,
      backHigh: back?.high ?? null,
      backLow: back?.low ?? null,
    });

    /**
     * Inside the cloud there is no trend to pull back into, so nothing is
     * traded — but the pair is re-armed once price is clearly away from the
     * line, so the next genuine retest is not swallowed by a stale disarm.
     */
    if (side === 'inside') {
      if (Math.abs(bar.close - kijun) > band * config.rearmBands) armed = true;
      if (last) level = publish();
      continue;
    }

    const direction: Direction = long ? 'LONG' : 'SHORT';

    if (touched && armed) {
      const chikouFree = back ? (long ? bar.close > back.high : bar.close < back.low) : null;
      const score = scoreChecks(long, bullish, futureCloudBullish, chikouFree, tenkanAgrees);
      armed = false;

      // The gate. Below the threshold no signal exists — it is not produced
      // and flagged, which is the mistake the previous strategy made.
      if (score >= config.minScore) {
        const entry = bar.close;
        const risk = r * config.stopRange;
        signals.push({
          id: ichimokuSignalId(symbol, timeframe, bar.time),
          strategy: 'ichimoku-kijun',
          symbol,
          timeframe,
          barTime: bar.time,
          detectedAt,
          source: 'candle',
          direction,
          kumo: long ? 'above' : 'below',
          entry,
          stop: long ? entry - risk : entry + risk,
          target: long ? entry + risk * config.rewardMultiple : entry - risk * config.rewardMultiple,
          stopPips: risk / pip,
          rangePips: r / pip,
          tenkan,
          kijun,
          senkouA,
          senkouB,
          distancePips: Math.abs(entry - kijun) / pip,
          cloudBullish: bullish,
          futureCloudBullish,
          chikouFree,
          tenkanAgrees,
          score,
        });
      }
    }

    if (!armed && Math.abs(bar.close - kijun) > band * config.rearmBands) armed = true;
    if (last) level = publish();
  }

  return { ichimoku: series, range, signals, level, reason: 'ok' };
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
  const distance = Math.abs(price - level.kijun);
  const inBand = distance <= level.band;
  const clear = distance > level.band * config.rearmBands;

  /**
   * `inBand` follows the quote on every tick, whatever else happens, so the
   * UI's "a pullback is in progress" state is live rather than as of the last
   * closed bar. `touched` is only ever compared, never written back, so this
   * is the one thing the live path updates unconditionally.
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
  const score = scoreChecks(long, level.cloudBullish, level.futureCloudBullish, chikouFree, level.tenkanAgrees);

  // Disarm whether or not it scored: the pullback has happened, and a rule
  // that kept firing until one tick happened to pass the gate would turn the
  // gate into "wait for the noisiest moment".
  const next: IchimokuLevel = { ...level, armed: false, inBand: true, updatedAt: at };
  if (score < config.minScore) return { signal: null, level: next };

  const pip = pipSize(level.symbol);
  const risk = level.range * config.stopRange;
  return {
    signal: {
      id: ichimokuSignalId(level.symbol, level.timeframe, level.barTime),
      strategy: 'ichimoku-kijun',
      symbol: level.symbol,
      timeframe: level.timeframe,
      barTime: level.barTime,
      detectedAt: at,
      source: 'live',
      direction: level.direction,
      kumo: long ? 'above' : 'below',
      entry: price,
      stop: long ? price - risk : price + risk,
      target: long ? price + risk * config.rewardMultiple : price - risk * config.rewardMultiple,
      stopPips: risk / pip,
      rangePips: level.range / pip,
      tenkan: level.tenkan,
      kijun: level.kijun,
      senkouA: level.senkouA,
      senkouB: level.senkouB,
      distancePips: distance / pip,
      cloudBullish: level.cloudBullish,
      futureCloudBullish: level.futureCloudBullish,
      chikouFree,
      tenkanAgrees: level.tenkanAgrees,
      score,
    },
    level: next,
  };
}

export { ICHIMOKU_SIGNAL_CHECKS };
