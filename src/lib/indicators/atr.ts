/**
 * Average True Range (Wilder).
 *
 *   TR_i  = max(high-low, |high - prevClose|, |low - prevClose|)
 *   ATR   = SMA of the first `period` TRs, then Wilder smoothing:
 *           ATR_i = (ATR_(i-1) * (period - 1) + TR_i) / period
 *
 * Used here to size the "touch" tolerance: a 20-pip wick on USD/JPY at
 * high volatility is not the same event as a 20-pip wick in a dead session,
 * so the EMA touch band scales with ATR instead of a fixed pip count.
 */
export interface OHLC {
  high: number;
  low: number;
  close: number;
}

export function trueRange(bar: OHLC, prevClose: number | null): number {
  const hl = bar.high - bar.low;
  if (prevClose === null) return hl;
  return Math.max(hl, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
}

export function atr(candles: readonly OHLC[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (period < 1 || candles.length < period) return out;

  const tr: number[] = candles.map((c, i) => trueRange(c, i === 0 ? null : candles[i - 1]!.close));

  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i]!;
  let prev = sum / period;
  out[period - 1] = prev;

  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}
