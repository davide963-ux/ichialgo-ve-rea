/**
 * The backtest must describe the system that is actually running.
 *
 * It did not: the pair list was hardcoded to whichever CSVs happened to be in
 * fixtures/market/, which had been downloaded for an earlier strategy. The
 * results included a cross the scanner does not trade while saying nothing
 * about USD/CHF or NZD/USD, which it does. Nobody noticed because nothing
 * compared the two lists.
 *
 * The offending fixture has since been deleted, so the two lists agree today.
 * These tests stay anyway: they are what makes that agreement a property of
 * the code rather than of someone having tidied up once. Dropping a pair from
 * config/pairs.ts without dropping its CSV would fail here, which is the
 * whole point — the published numbers would otherwise quietly start
 * describing a system nobody is running.
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
   * There is no fixture on disk for a pair the scanner does not trade, and
   * that is asserted rather than assumed. If one is ever added back, this
   * fails and names it — and the mechanism underneath keeps it out of the
   * results in the meantime, so a stray CSV cannot change a published number
   * before anyone runs the tests.
   */
  it('carries no fixture for a pair the scanner does not trade', () => {
    expect(UNUSED_FIXTURES, 'untraded fixtures on disk').toEqual([]);
    for (const symbol of UNUSED_FIXTURES) {
      expect(FIXTURE_PAIRS.map((p) => p.symbol)).not.toContain(symbol);
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
