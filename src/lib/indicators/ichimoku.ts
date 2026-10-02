/**
 * Ichimoku Kinko Hyo.
 *
 *   Tenkan-sen (conversion)  = (highest high + lowest low) / 2 over 9
 *   Kijun-sen  (base)        = same over 26
 *   Senkou A   (cloud edge)  = (Tenkan + Kijun) / 2,   plotted 26 bars AHEAD
 *   Senkou B   (cloud edge)  = same over 52,           plotted 26 bars AHEAD
 *   Chikou     (lagging)     = close,                  plotted 26 bars BEHIND
 *
 * DISPLACEMENT IS THE WHOLE POINT, and the easiest thing to get wrong.
 * The cloud you see above bar `i` was computed 26 bars earlier; the cloud
 * computed at bar `i` is drawn 26 bars into the future, past the last candle.
 * So this module returns both:
 *
 *   senkouARaw[i]  value COMPUTED at bar i        → for projecting forward
 *   senkouA[i]     cloud IN EFFECT at bar i       → for analysis and plotting
 *                  (= senkouARaw[i - 26])
 *
 *   bars:      … 24  25  26  27 …            n-1 │ future (no candles yet)
 *   raw:            A25 A26 A27              An-1│
 *   in effect:       …  A0  A1               An-27
 *   future:                                      │ An-26 … An-1   ← the leading cloud
 *
 * Chikou is the mirror image: chikou[i] is the close of bar i+26, i.e. what
 * the lagging line shows when it is drawn above bar i. It is null for the
 * last 26 bars, because that part of the line has not been drawn yet.
 */
import type { OHLC } from './atr';

export interface IchimokuConfig {
  tenkan: number;
  kijun: number;
  senkouB: number;
  /** Bars the cloud is pushed forward and the lagging line pulled back. */
  displacement: number;
}

export const ICHIMOKU_DEFAULT: IchimokuConfig = { tenkan: 9, kijun: 26, senkouB: 52, displacement: 26 };

export interface IchimokuSeries {
  tenkan: (number | null)[];
  kijun: (number | null)[];
  /** Cloud in effect at each bar (already displaced). */
  senkouA: (number | null)[];
  senkouB: (number | null)[];
  /** Cloud values as computed at each bar (not displaced). */
  senkouARaw: (number | null)[];
  senkouBRaw: (number | null)[];
  /** Lagging line as drawn: chikou[i] is the close of bar i + displacement. */
  chikou: (number | null)[];
  config: IchimokuConfig;
}

/** Midpoint of the highest high and lowest low over `period` bars ending at i. */
export function donchianMid(candles: readonly OHLC[], period: number): (number | null)[] {
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
    if (Number.isFinite(hi) && Number.isFinite(lo)) out[i] = (hi + lo) / 2;
  }
  return out;
}

export function ichimoku(candles: readonly OHLC[], config: IchimokuConfig = ICHIMOKU_DEFAULT): IchimokuSeries {
  const n = candles.length;
  const tenkan = donchianMid(candles, config.tenkan);
  const kijun = donchianMid(candles, config.kijun);
  const senkouBRaw = donchianMid(candles, config.senkouB);

  const senkouARaw: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const t = tenkan[i];
    const k = kijun[i];
    senkouARaw[i] = t === null || t === undefined || k === null || k === undefined ? null : (t + k) / 2;
  }

  const shift = config.displacement;
  const senkouA: (number | null)[] = new Array(n).fill(null);
  const senkouB: (number | null)[] = new Array(n).fill(null);
  const chikou: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    senkouA[i] = i - shift >= 0 ? senkouARaw[i - shift]! : null;
    senkouB[i] = i - shift >= 0 ? senkouBRaw[i - shift]! : null;
    chikou[i] = i + shift < n ? candles[i + shift]!.close : null;
  }

  return { tenkan, kijun, senkouA, senkouB, senkouARaw, senkouBRaw, chikou, config };
}

/**
 * The leading cloud: the last `displacement` raw values, which belong to bars
 * that do not exist yet. `offset` is how many bars past the final candle each
 * point sits.
 */
export function futureCloud(series: IchimokuSeries, barCount: number): { offset: number; senkouA: number | null; senkouB: number | null }[] {
  const shift = series.config.displacement;
  const out: { offset: number; senkouA: number | null; senkouB: number | null }[] = [];
  for (let i = Math.max(0, barCount - shift); i < barCount; i++) {
    out.push({ offset: i - (barCount - shift) + 1, senkouA: series.senkouARaw[i] ?? null, senkouB: series.senkouBRaw[i] ?? null });
  }
  return out;
}

export type KumoSide = 'above' | 'below' | 'inside';

/** Where a price sits relative to the cloud in effect at bar `i`. */
export function kumoSide(series: IchimokuSeries, i: number, price: number): KumoSide | null {
  const a = series.senkouA[i];
  const b = series.senkouB[i];
  if (a === null || a === undefined || b === null || b === undefined) return null;
  const top = Math.max(a, b);
  const bottom = Math.min(a, b);
  if (price > top) return 'above';
  if (price < bottom) return 'below';
  return 'inside';
}

/** Cloud thickness in price units — a thin cloud is weak support/resistance. */
export function kumoThickness(series: IchimokuSeries, i: number): number | null {
  const a = series.senkouA[i];
  const b = series.senkouB[i];
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return Math.abs(a - b);
}

/** A bullish cloud has Senkou A above Senkou B (drawn green by convention). */
export function cloudIsBullish(series: IchimokuSeries, i: number): boolean | null {
  const a = series.senkouA[i];
  const b = series.senkouB[i];
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return a > b;
}
