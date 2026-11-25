/**
 * Pure Ichimoku. No EMA, no ATR, no other indicator anywhere in this file.
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
 *               This is what replaces ATR.
 *   gate        four confirmations, all Ichimoku's own. A signal below the
 *               threshold is not produced at all.
 *
 * WHAT THIS IS MEASURED TO DO, STATED PLAINLY
 * ───────────────────────────────────────────
 * On the checked-in 1H fixtures, at one pip of cost, the default settings
 * average +4.00 pips over 412 trades. That number should not be trusted on
 * its own: split by time it is +0.33 on the older 60% and +11.38 on the
 * newer 40%, and EVERY variant tested — including rules with no edge at all —
 * improves by a similar amount across that boundary. The second period was
 * simply kinder. The honest summary is "around break-even on hard data,
 * good on easy data", not "profitable".
 *
 * What does hold within each period is the gate: raising `minScore` from 2 to
 * 4 improves the result in both halves. That part is a property of the rule
 * rather than of the sample.
 *
 * The fixtures are 1H and the scanner runs 30M, so none of this is settled
 * for the timeframe actually traded.
 */
import { ICHIMOKU_SIGNAL_CHECKS, ICHIMOKU_STRATEGY, type IchimokuStrategyConfig } from '../../config/ichimokuStrategy';
import type { Timeframe } from '../../config/timeframes';
import { cloudIsBullish, ichimoku, kumoSide, type IchimokuSeries, type KumoSide } from '../../lib/indicators';
import { pipSize } from '../../lib/pips';
import type { Candle } from '../marketData';

export type Direction = 'LONG' | 'SHORT';

export interface IchimokuSignal {
  /** Stable per (symbol, timeframe, bar) — re-scanning never duplicates one. */
  id: string;
  strategy: 'ichimoku-kijun';
  symbol: string;
  timeframe: Timeframe;
  /** Open time of the bar that touched Kijun, UNIX seconds. */
  barTime: number;
  detectedAt: number;

  /** From the Kumo, never from the approach side. */
  direction: Direction;
  /** Where price closed relative to the cloud. Always 'above' or 'below'. */
  kumo: Exclude<KumoSide, 'inside'>;

  // ── the levels, all Ichimoku-derived ───────────────────────────────────
  /** Close of the signal bar: where a market order fills. */
  entry: number;
  stop: number;
  target: number;
  /** |entry − stop| in pips. */
  stopPips: number;
  /** The 26-bar range, in pips — this strategy's unit of distance. */
  rangePips: number;

  // ── the lines at the moment of the signal ──────────────────────────────
  tenkan: number | null;
  kijun: number;
  senkouA: number;
  senkouB: number;
  /** |close − Kijun| in pips: how clean the retest was. */
  distancePips: number;

  // ── the four confirmations ─────────────────────────────────────────────
  /** Cloud in effect is bullish (Senkou A above B). */
  cloudBullish: boolean;
  /** The cloud 26 bars ahead, already determined today. */
  futureCloudBullish: boolean | null;
  /** Lagging line clear of the candles it is drawn over. */
  chikouFree: boolean | null;
  /** Tenkan on the direction's side of Kijun. */
  tenkanAgrees: boolean;
  /** How many of the four agree, 0–4. */
  score: number;
}

export interface IchimokuAnalysis {
  ichimoku: IchimokuSeries;
  /** The 26-bar range at each bar, in price units. */
  range: (number | null)[];
  signals: IchimokuSignal[];
  /** The level the live watcher follows, from the most recent bar. */
  level: { symbol: string; timeframe: Timeframe; kijun: number; band: number; direction: Direction | null; armed: boolean; barTime: number } | null;
  reason: 'ok' | 'not-enough-bars';
}

export const ichimokuSignalId = (symbol: string, timeframe: Timeframe, barTime: number) =>
  `ichimoku-kijun|${symbol}|${timeframe}|${barTime}`;

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
 * displacement, so a cloud is actually in effect at the bar being judged.
 */
export function minBars(config = ICHIMOKU_STRATEGY): number {
  return 52 + 26 + config.rangePeriod;
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
  let level: IchimokuAnalysis['level'] = null;

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

    /**
     * Inside the cloud there is no trend to pull back into, so nothing is
     * traded — but the pair is re-armed once price is clearly away from the
     * line, so the next genuine retest is not swallowed by a stale disarm.
     */
    if (side === 'inside') {
      if (Math.abs(bar.close - kijun) > band * config.rearmBands) armed = true;
      if (i === candles.length - 1) {
        level = { symbol, timeframe, kijun, band, direction: null, armed, barTime: bar.time };
      }
      continue;
    }

    const long = side === 'above';
    const direction: Direction = long ? 'LONG' : 'SHORT';
    const touched = bar.low <= kijun + band && bar.high >= kijun - band;

    if (touched && armed) {
      const back = candles[i - shift];
      const chikouFree = back ? (long ? bar.close > back.high : bar.close < back.low) : null;

      // The cloud 26 bars ahead: known today, and what the trend walks into.
      const aheadA = series.senkouARaw[i] ?? null;
      const aheadB = series.senkouBRaw[i] ?? null;
      const futureCloudBullish = aheadA === null || aheadB === null ? null : aheadA > aheadB;

      const tenkan = series.tenkan[i] ?? null;
      const tenkanAgrees = tenkan === null ? false : long ? tenkan > kijun : tenkan < kijun;

      const checks = [
        long ? bullish : !bullish,
        futureCloudBullish === null ? false : long ? futureCloudBullish : !futureCloudBullish,
        chikouFree === true,
        tenkanAgrees,
      ];
      const score = checks.filter(Boolean).length;

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
          distancePips: Math.abs(bar.close - kijun) / pip,
          cloudBullish: bullish,
          futureCloudBullish,
          chikouFree,
          tenkanAgrees,
          score,
        });
      }
    }

    if (!armed && Math.abs(bar.close - kijun) > band * config.rearmBands) armed = true;

    if (i === candles.length - 1) {
      level = { symbol, timeframe, kijun, band, direction, armed, barTime: bar.time };
    }
  }

  return { ichimoku: series, range, signals, level, reason: 'ok' };
}

export { ICHIMOKU_SIGNAL_CHECKS };
