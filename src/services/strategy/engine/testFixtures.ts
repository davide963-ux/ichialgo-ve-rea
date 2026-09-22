/**
 * Shared synthetic markets for the engine tests.
 *
 * WHY A SEEDED GENERATOR RATHER THAN HAND-DRAWN BARS
 * ──────────────────────────────────────────────────
 * Hand-built fixtures prove a detector fires on the shape you drew, which is
 * the easiest thing in the world to make true and says nothing about whether
 * it fires on anything else. Hand-drawn bars are still used where a SPECIFIC
 * shape is the point — a double top, an engulfing bar — but the frequency and
 * causality guarantees need many bars of varied market, and those have to be
 * generated.
 *
 * The generator is deterministic, so a failure is always reproducible.
 */
import type { Candle } from '../../marketData/types';

/** Deterministic PRNG. Same seed, same market, every run and every machine. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * A market with regimes: trends that run, ranges that chop, sharp moves.
 *
 * Real price is not a pure random walk — it trends, and structure forms
 * because of that. A walk with no regimes would understate how often genuine
 * setups appear and make the frequency tests meaningless.
 */
export function market(n: number, seed: number, pip = 0.0001): Candle[] {
  const r = rng(seed);
  const out: Candle[] = [];
  let price = 1.1;
  let drift = 0;
  let regimeLeft = 0;
  let vol = 8 * pip;

  for (let i = 0; i < n; i++) {
    if (regimeLeft <= 0) {
      const roll = r();
      drift =
        roll < 0.45 ? (r() < 0.5 ? 1 : -1) * (0.4 + r() * 0.8) * pip
        : roll < 0.8 ? 0
        : (r() < 0.5 ? 1 : -1) * (1.5 + r()) * pip;
      vol = (5 + r() * 8) * pip;
      regimeLeft = 20 + Math.floor(r() * 60);
    }
    regimeLeft--;

    const open = price;
    const close = open + drift + (r() - 0.5) * 2 * vol;
    const wick = vol * (0.3 + r() * 0.7);
    out.push({
      time: 1_700_000_000 + i * 3600,
      open,
      high: Math.max(open, close) + wick * r(),
      low: Math.min(open, close) - wick * r(),
      close,
      volume: null,
      complete: true,
    });
    price = close;
  }
  return out;
}

/**
 * Build candles from a close path.
 *
 * THE OPEN IS A MIDPOINT, NOT THE PREVIOUS CLOSE
 * ──────────────────────────────────────────────
 * The obvious construction — `open = previous close` — is subtly unusable for
 * structure tests. At a turning point the peak bar and the bar after it BOTH
 * have `max(open, close)` equal to the peak close, so they share an identical
 * high. A fractal pivot requires a STRICT extreme over its window, so neither
 * qualifies, and pivot detection silently returns nothing at all.
 *
 * Opening at the midpoint of the previous and current close keeps the bars
 * valid OHLC while making the turning bar a strict extreme, which is what real
 * price does anyway: the bar that makes the high trades above its neighbours.
 */
export function fromCloses(closes: readonly number[], wick = 0.0004, start = 1_700_000_000): Candle[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : (closes[i - 1]! + close) / 2;
    return {
      time: start + i * 3600,
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      close,
      volume: null,
      complete: true,
    };
  });
}

/** A straight path between two prices, for building deliberate swings. */
export function leg(from: number, to: number, bars: number): number[] {
  return Array.from({ length: bars }, (_, i) => from + ((to - from) * (i + 1)) / bars);
}

/** Enough flat warm-up bars to get past the engine's minimum history. */
export function warmup(price: number, bars: number): number[] {
  // A tiny alternating wobble, so ATR is non-zero — a perfectly flat series
  // gives ATR 0 and the engine correctly refuses to analyse it.
  return Array.from({ length: bars }, (_, i) => price + (i % 2 === 0 ? 0.0003 : -0.0003));
}
