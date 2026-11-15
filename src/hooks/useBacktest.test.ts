/**
 * The backtest must describe the system that is actually running.
 *
 * It did not: the pair list was hardcoded to whichever CSVs happened to be in
 * fixtures/market/, which were downloaded for an earlier strategy. The result
 * reported GBP/JPY — a pair the scanner does not trade — while saying nothing
 * about USD/CHF or NZD/USD, which it does. Nobody noticed because nothing
 * compared the two lists.
 */
import { describe, expect, it } from 'vitest';
import { PAIRS } from '../config/pairs';
import { FIXTURE_PAIRS, UNTESTED_PAIRS, UNUSED_FIXTURES } from './useBacktest';

const scanned = PAIRS.map((p) => p.symbol);

describe('backtest universe', () => {
  it('never reports a pair the scanner does not trade', () => {
    for (const { symbol } of FIXTURE_PAIRS) {
      expect(scanned, `${symbol} is backtested but not scanned`).toContain(symbol);
    }
  });

  it('accounts for every scanned pair as either tested or named untested', () => {
    const tested = FIXTURE_PAIRS.map((p) => p.symbol);
    expect([...tested, ...UNTESTED_PAIRS].sort()).toEqual([...scanned].sort());
  });

  it('has something to run', () => {
    expect(FIXTURE_PAIRS.length).toBeGreaterThan(0);
    for (const p of FIXTURE_PAIRS) expect(typeof p.load).toBe('function');
  });

  /**
   * GBP/JPY is the specific pair that was being reported. Its CSV stays on
   * disk — it is real data and costs nothing to keep — but it must not reach
   * the results while the scanner does not trade it.
   */
  it('keeps an untraded fixture out of the results without deleting it', () => {
    if (!scanned.includes('GBP/JPY')) {
      expect(FIXTURE_PAIRS.map((p) => p.symbol)).not.toContain('GBP/JPY');
      expect(UNUSED_FIXTURES).toContain('GBP/JPY');
    }
  });

  it('names the traded pairs it cannot speak for', () => {
    // Not an assertion about which ones: just that the gap is reported rather
    // than silently dropped, whatever config/pairs.ts says today.
    for (const symbol of UNTESTED_PAIRS) {
      expect(scanned).toContain(symbol);
      expect(FIXTURE_PAIRS.map((p) => p.symbol)).not.toContain(symbol);
    }
  });
});
