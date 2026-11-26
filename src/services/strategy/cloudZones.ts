/**
 * OANDA's fourth approach: "Identifying future support and resistance zones".
 *
 * Quoted: "Kumo (Cloud) is derived from the summation of Senkou Span A
 * (Leading span A) and Senkou Span B (Leading span B) that are shifted
 * forward 26 periods, which in turn allows the Kumo (Cloud) to act as a
 * potential future support zone if price is above the Cloud, and as a
 * potential future resistance zone if price is below the Cloud."
 *
 * And on thickness: "a large or thick Cloud indicates potentially stronger
 * support or resistance levels, while a small or thin one can indicate weaker
 * support and resistance."
 *
 * THIS IS NOT A STRATEGY AND DOES NOT PRODUCE SIGNALS
 * ──────────────────────────────────────────────────
 * The article presents it as a way of reading the chart, not as an entry
 * rule — no trigger, no direction, no ticket. So it lives here as a pure
 * read-out for the pair page rather than as a fourth detector, because
 * dressing a reading up as a strategy would put a number on it that nobody
 * claimed.
 *
 * In the article's own example the USD/JPY hourly zone "rests at
 * 156.00/155.40" — the two span values at the far edge of the drawn cloud,
 * quoted nearer-edge first.
 */
import { pipSize } from '../../lib/pips';
import type { IchimokuSeries } from '../../lib/indicators';
import type { Candle } from '../marketData';
import type { CloudZone } from './types';

/**
 * The cloud ahead of the last candle, as a support or resistance zone.
 *
 * Returns null while price is inside the cloud: the article only assigns the
 * zone a meaning when price is clear of it on one side, and a zone that is
 * both support and resistance at once says nothing.
 */
export function futureCloudZone(
  candles: readonly Candle[],
  series: IchimokuSeries,
  symbol: string,
): CloudZone | null {
  const last = candles.at(-1);
  if (!last) return null;

  const i = candles.length - 1;
  const a = series.senkouARaw[i];
  const b = series.senkouBRaw[i];
  if (a == null || b == null) return null;

  const top = Math.max(a, b);
  const bottom = Math.min(a, b);
  const pip = pipSize(symbol);

  // Price must be clear of the cloud that will be in effect, which is the one
  // being drawn now — the same cloud the zone describes.
  if (last.close > top) {
    return {
      kind: 'support',
      near: top,
      far: bottom,
      thicknessPips: (top - bottom) / pip,
      fromBarTime: last.time + (series.config.displacement) * 0,
    };
  }
  if (last.close < bottom) {
    return {
      kind: 'resistance',
      near: bottom,
      far: top,
      thicknessPips: (top - bottom) / pip,
      fromBarTime: last.time,
    };
  }
  return null;
}

/**
 * How a zone's thickness reads, relative to the pair's own recent travel.
 *
 * The article is qualitative — "large or thick" against "small or thin" — so
 * the threshold is ours. It is expressed as a fraction of the 26-bar range so
 * that it means the same thing on USD/JPY and on EUR/USD, which a pip figure
 * would not.
 */
export function zoneStrength(thicknessPips: number, rangePips: number): 'thick' | 'thin' {
  return rangePips > 0 && thicknessPips >= rangePips * 0.15 ? 'thick' : 'thin';
}
