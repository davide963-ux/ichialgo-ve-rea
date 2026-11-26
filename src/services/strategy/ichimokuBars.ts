/**
 * The Ichimoku picture at one bar, computed once and shared by every strategy.
 *
 * WHY THIS IS NOT INSIDE A DETECTOR
 * ─────────────────────────────────
 * Three strategies now read the same facts: which side of the Kumo price
 * closed on, whether the cloud is bullish, where the lines sit, how thick the
 * cloud is, what the bar 26 back did. If each detector derived those for
 * itself they would drift — one would compare the close to the cloud and
 * another the whole bar's range, and the app would be quietly running two
 * definitions of "above the cloud" while presenting them as comparable.
 *
 * Nothing here decides anything. There is no rule in this file, only the
 * numbers the rules are written against.
 */
import { cloudIsBullish, ichimoku, kumoSide, type IchimokuSeries, type KumoSide } from '../../lib/indicators';
import { pipSize } from '../../lib/pips';
import type { Candle } from '../marketData';

/** Highest high minus lowest low over `period` bars ending at each index. */
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
 * Bars needed before anything can be reported: Senkou B's 52 plus the 26-bar
 * displacement, so a cloud is actually in effect at the bar being judged,
 * plus the range window.
 */
export const minBarsFor = (rangePeriod: number): number => 52 + 26 + rangePeriod;

export interface BarFacts {
  i: number;
  bar: Candle;
  /** The lines in effect at this bar. */
  tenkan: number | null;
  kijun: number;
  senkouA: number;
  senkouB: number;
  /** The cloud being drawn 26 bars ahead, as computed here. Knowable today. */
  aheadA: number | null;
  aheadB: number | null;
  /** 26-bar high-low range, in price units. */
  range: number;
  /** Where the CLOSE sits relative to the cloud. One definition, shared. */
  side: KumoSide;
  /** Senkou A above Senkou B in the cloud in effect. */
  cloudBullish: boolean;
  /** |Senkou A − Senkou B| in pips: thick is stronger support/resistance. */
  cloudPips: number;
  /** The bar 26 back, which Chikou is drawn over. Undefined early on. */
  back: Candle | undefined;
  pip: number;
}

export interface IchimokuContext {
  series: IchimokuSeries;
  range: (number | null)[];
  pip: number;
  /** Displacement, 26. Named rather than repeated as a literal. */
  shift: number;
  /** Facts at bar `i`, or null when the cloud or the range is not ready. */
  at(i: number): BarFacts | null;
}

export function ichimokuContext(
  candles: readonly Candle[],
  symbol: string,
  rangePeriod: number,
): IchimokuContext {
  const series = ichimoku(candles);
  const range = rangeOver(candles, rangePeriod);
  const pip = pipSize(symbol);
  const shift = series.config.displacement;

  return {
    series,
    range,
    pip,
    shift,
    at(i: number): BarFacts | null {
      const bar = candles[i];
      if (!bar) return null;
      const kijun = series.kijun[i];
      const senkouA = series.senkouA[i];
      const senkouB = series.senkouB[i];
      const r = range[i];
      if (kijun == null || senkouA == null || senkouB == null || r == null || r <= 0) return null;

      const side = kumoSide(series, i, bar.close);
      const cloudBullish = cloudIsBullish(series, i);
      if (side === null || cloudBullish === null) return null;

      return {
        i,
        bar,
        tenkan: series.tenkan[i] ?? null,
        kijun,
        senkouA,
        senkouB,
        aheadA: series.senkouARaw[i] ?? null,
        aheadB: series.senkouBRaw[i] ?? null,
        range: r,
        side,
        cloudBullish,
        cloudPips: Math.abs(senkouA - senkouB) / pip,
        back: candles[i - shift],
        pip,
      };
    },
  };
}

/** A bullish candlestick is one that closed above where it opened. */
export const bullishCandle = (c: Candle): boolean => c.close > c.open;
export const bearishCandle = (c: Candle): boolean => c.close < c.open;

/** Price formatted for a check's `detail`, at a sane number of digits. */
export const px = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(v > 20 ? 3 : 5);
