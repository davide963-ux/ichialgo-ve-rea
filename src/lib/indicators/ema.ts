/**
 * Exponential Moving Average.
 *
 *   seed  = SMA of the first `period` values          (standard TradingView/MetaTrader seeding)
 *   ema_i = price_i * k + ema_(i-1) * (1 - k),  k = 2 / (period + 1)
 *
 * The result is index-aligned with the input: positions before the seed are
 * `null`, never 0 — an undefined EMA must not look like a price of zero.
 */
export function ema(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return out;

  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  let prev = sum / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** EMA over candle closes — the usual way a moving average is plotted. */
export function emaOfCloses(candles: readonly { close: number }[], period: number): (number | null)[] {
  return ema(candles.map((c) => c.close), period);
}

/**
 * Slope of a series over `lookback` bars, as a per-bar delta.
 * Used to tell a trending EMA from a flat one.
 */
export function slopePerBar(series: readonly (number | null)[], index: number, lookback: number): number | null {
  const now = series[index];
  const then = series[index - lookback];
  if (now === null || now === undefined || then === null || then === undefined) return null;
  return (now - then) / lookback;
}
