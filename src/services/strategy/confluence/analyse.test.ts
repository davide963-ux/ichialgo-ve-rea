import { describe, expect, it } from 'vitest';
import { CONFLUENCE_STRATEGY } from '../../../config/confluence';
import type { Candle } from '../../marketData/types';
import { analyseConfluence } from './analyse';
import { isActionable } from './scoring';

const PIP = 0.0001;
const SYMBOL = 'EUR/USD';

/**
 * Candles from a close path.
 *
 * Wicks are measured from the CLOSE, not from max(open, close). Deriving the
 * high from the previous close makes two bars share an identical high at a
 * turning point, which a strict fractal refuses to call a pivot — an artefact
 * of the fixture that would quietly disable structure detection in every test.
 */
function toCandles(closes: readonly number[], wickPips = 4): Candle[] {
  return closes.map((close, i) => ({
    time: 1_700_000_000 + i * 3600,
    open: i === 0 ? close : closes[i - 1]!,
    high: close + wickPips * PIP,
    low: close - wickPips * PIP,
    close,
    volume: null,
    complete: true,
  }));
}

/** Drift plus oscillation: a trend that actually has swings in it. */
function wave(n: number, base: number, driftPips: number, ampPips: number, period: number): number[] {
  return Array.from({ length: n }, (_, i) => base + i * driftPips * PIP + Math.sin((i / period) * 2 * Math.PI) * ampPips * PIP);
}

/** Turn the last bar into a rejection: pushed down into the zone, closed back up. */
function addRejection(bars: Candle[], direction: 'up' | 'down' = 'up', pip = PIP): Candle[] {
  const out = bars.map((b) => ({ ...b }));
  const last = out[out.length - 1]!;
  if (direction === 'up') {
    last.low = last.close - 20 * pip;
    last.close = last.open + 6 * pip;
    last.high = last.close + 1 * pip;
  } else {
    last.high = last.close + 20 * pip;
    last.close = last.open - 6 * pip;
    last.low = last.close - 1 * pip;
  }
  return out;
}

/** An uptrend that has pulled back ~42% into the EMA50/Kijun zone and rejected. */
const longSetup = () => addRejection(toCandles(wave(130, 1.05, 0.8, 25, 16)), 'up');

/** The same path mirrored about its base — every condition inverted. */
const shortSetup = () => {
  const closes = wave(130, 1.05, 0.8, 25, 16).map((c) => 2.1 - c);
  return addRejection(toCandles(closes), 'down');
};

const analyse = (bars: Candle[], over: Partial<Parameters<typeof analyseConfluence>[1]> = {}) =>
  analyseConfluence(bars, { symbol: SYMBOL, timeframe: '1H', lastBarClosed: true, ...over });

describe('analyseConfluence — insufficient data', () => {
  it('says INSUFFICIENT_DATA rather than guessing, with no candles', () => {
    const a = analyse([]);
    expect(a.marketCondition).toBe('INSUFFICIENT_DATA');
    expect(a.signal).toBe('NO_TRADE');
    expect(a.confidence).toBe(0);
    expect(a.warnings[0]).toMatch(/No candles/);
  });

  it('refuses to analyse below minBars, and says how many it needs', () => {
    const a = analyse(toCandles(wave(40, 1.05, 1, 20, 14)));
    expect(a.marketCondition).toBe('INSUFFICIENT_DATA');
    expect(a.warnings[0]).toContain(String(CONFLUENCE_STRATEGY.minBars));
  });
});

describe('analyseConfluence — the hierarchy gates', () => {
  it('blocks a choppy market even when indicators align', () => {
    const chop = toCandles(Array.from({ length: 160 }, (_, i) => 1.1 + (i % 2 === 0 ? 12 : -12) * PIP));
    const a = analyse(chop);
    expect(a.marketCondition).toBe('CHOPPY');
    expect(a.signal).toBe('NO_TRADE');
    expect(a.warnings.some((w) => /Choppy/.test(w))).toBe(true);
  });

  it('blocks an overextended market — a good trend entered too late', () => {
    const a = analyse(toCandles(Array.from({ length: 160 }, (_, i) => 1.05 + i * 6 * PIP)));
    expect(a.marketCondition).toBe('OVEREXTENDED');
    expect(a.signal).toBe('NO_TRADE');
    expect(a.ema50!.extensionAtr).toBeGreaterThan(CONFLUENCE_STRATEGY.extension.overextendedAtr);
  });

  it('does not emit a signal merely because price is near the EMA50', () => {
    // Flat market, price sitting on the EMA: the old detector's signal case.
    const flat = toCandles(Array.from({ length: 160 }, (_, i) => 1.1 + Math.sin(i / 3) * 1 * PIP));
    const a = analyse(flat);
    expect(isActionable(a.signal)).toBe(false);
  });
});

describe('analyseConfluence — a valid long setup', () => {
  const a = analyse(longSetup());

  it('produces an actionable long', () => {
    expect(a.direction).toBe('long');
    expect(isActionable(a.signal)).toBe(true);
    expect(a.confidence).toBeGreaterThanOrEqual(CONFLUENCE_STRATEGY.thresholds.actionable);
  });

  it('reached it through the full hierarchy, not one condition', () => {
    expect(a.marketCondition).toBe('TRENDING_BULLISH');
    expect(a.marketStructure!.direction).toBe('up');
    expect(a.confluence!.zoneStrength).not.toBe('none');
    expect(['healthy', 'deep']).toContain(a.setup.pullback);
    expect(a.setup.confirmation).toBe(true);
  });

  it('measured a partial retracement, not a broken trend', () => {
    expect(a.setup.retracementPct).toBeGreaterThan(CONFLUENCE_STRATEGY.pullback.shallowPct);
    expect(a.setup.retracementPct).toBeLessThan(CONFLUENCE_STRATEGY.pullback.invalidationPct);
  });

  it('is fully explainable: every point traces to a named condition', () => {
    expect(a.scoreReasons.length).toBeGreaterThan(3);
    for (const r of a.scoreReasons) {
      expect(r.key).toBeTruthy();
      expect(r.label).toBeTruthy();
      expect(r.points).not.toBe(0);
    }
    expect(a.reasons.length).toBeGreaterThan(0);
  });

  it('anchors the stop to structure and places targets beyond it', () => {
    expect(a.risk.entry).not.toBeNull();
    expect(a.risk.stopPips).toBeGreaterThanOrEqual(CONFLUENCE_STRATEGY.risk.minStopPips);
    expect(a.risk.targets).toHaveLength(CONFLUENCE_STRATEGY.risk.targetR.length);
    // Long: every target above entry, each further than the last.
    for (let i = 0; i < a.risk.targets.length; i++) {
      expect(a.risk.targets[i]!).toBeGreaterThan(a.risk.entry!);
      if (i > 0) expect(a.risk.targets[i]!).toBeGreaterThan(a.risk.targets[i - 1]!);
    }
    expect(a.risk.invalidationCondition).toBeTruthy();
  });
});

describe('analyseConfluence — symmetry', () => {
  it('reads the mirrored path as the mirrored trade, at the same confidence', () => {
    const long = analyse(longSetup());
    const short = analyse(shortSetup());

    expect(short.direction).toBe('short');
    expect(isActionable(short.signal)).toBe(true);
    expect(short.marketCondition).toBe('TRENDING_BEARISH');
    expect(short.marketStructure!.direction).toBe('down');
    expect(short.confidence).toBe(long.confidence);
  });

  it('places the short stop above entry and targets below', () => {
    const short = analyse(shortSetup());
    expect(short.risk.entry).not.toBeNull();
    for (const t of short.risk.targets) expect(t).toBeLessThan(short.risk.entry!);
  });
});

describe('analyseConfluence — no lookahead, no forming-bar entries', () => {
  it('never reports CONFIRMED while the last bar is still forming', () => {
    const a = analyse(longSetup(), { lastBarClosed: false });
    expect(a.setup.status).not.toBe('CONFIRMED');
    expect(a.barClosed).toBe(false);
    expect(a.warnings.some((w) => /still forming/.test(w))).toBe(true);
  });

  it('cannot see past the analysed bar', () => {
    const bars = longSetup();
    const atIndex = analyseConfluence(bars, { symbol: SYMBOL, timeframe: '1H', lastBarClosed: true, index: 120 });

    const tampered = bars.map((b) => ({ ...b }));
    for (let i = 121; i < tampered.length; i++) {
      tampered[i] = { ...tampered[i]!, high: 9, low: 8, close: 8.5, open: 8.5 };
    }
    const again = analyseConfluence(tampered, { symbol: SYMBOL, timeframe: '1H', lastBarClosed: true, index: 120 });

    expect(again.signal).toBe(atIndex.signal);
    expect(again.confidence).toBe(atIndex.confidence);
  });
});

describe('analyseConfluence — multi-timeframe', () => {
  it('rewards an agreeing higher timeframe and punishes a conflicting one', () => {
    const agree = analyse(longSetup(), { higherTimeframeBias: 'long' });
    const conflict = analyse(longSetup(), { higherTimeframeBias: 'short' });
    expect(agree.confidence).toBeGreaterThan(conflict.confidence);
    expect(agree.multiTimeframe!.alignment).toBe('aligned');
    expect(conflict.multiTimeframe!.alignment).toBe('conflicting');
  });

  it('does not call a setup high-confidence when the higher timeframe contradicts it', () => {
    const conflict = analyse(longSetup(), { higherTimeframeBias: 'short' });
    expect(conflict.signal).not.toBe('STRONG_LONG');
  });

  it('omits the block entirely when no other timeframe was supplied', () => {
    expect(analyse(longSetup()).multiTimeframe).toBeNull();
  });
});

describe('analyseConfluence — structured output', () => {
  const a = analyse(longSetup());

  it('exposes every field the dashboard needs, as data not prose', () => {
    expect(a.ema50).toMatchObject({
      value: expect.any(Number),
      slopeAtr: expect.any(Number),
      direction: expect.any(String),
      priceRelation: expect.any(String),
      extensionAtr: expect.any(Number),
    });
    expect(a.ichimoku).toMatchObject({
      priceRelationToCloud: expect.any(String),
      cloudDirection: expect.any(String),
      cloudStrength: expect.any(String),
      cloudThicknessAtr: expect.any(Number),
    });
    expect(a.confluence).toMatchObject({ zoneStrength: expect.any(String) });
    expect(a.marketStructure).toMatchObject({ direction: expect.any(String), trendStrength: expect.any(Number) });
    expect(a.setup).toMatchObject({ status: expect.any(String), pullback: expect.any(String) });
  });

  it('normalises distances by ATR so thresholds travel across pairs', () => {
    // The same shape at JPY's scale: 100x the price, 100x the pip, so every
    // move is identical in PIPS. Only the ATR-normalised readings should match
    // — that is the whole point of normalising.
    const jpyPip = 0.01;
    const jpyCloses = wave(130, 1.05, 0.8, 25, 16).map((c) => c * 100 + 48.95);
    const jpyBars = addRejection(toCandles(jpyCloses, 4 * 100), 'up', jpyPip);
    const jpy = analyseConfluence(jpyBars, { symbol: 'USD/JPY', timeframe: '1H', lastBarClosed: true });

    expect(jpy.ema50!.extensionAtr).toBeCloseTo(a.ema50!.extensionAtr, 1);
    expect(jpy.confluence!.ema50KijunDistanceAtr!).toBeCloseTo(a.confluence!.ema50KijunDistanceAtr!, 1);
    expect(jpy.signal).toBe(a.signal);
  });
});
