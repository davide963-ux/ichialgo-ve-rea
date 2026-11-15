/**
 * The scanner's two pure decisions: what to record, and when a trade is over.
 *
 * These exist because the live history and the backtest MUST agree. If the
 * scanner counts a fill the backtest would refuse, or credits a target on the
 * entry bar, the history will quietly show a better strategy than the one the
 * backtest measured — and the difference will look like a real edge. The last
 * test in this file pins that agreement on real candles rather than trusting
 * the two to stay in step by inspection.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveOpenTrade, signalRow } from './scanner.mjs';
import { analyseEma50Touch, pipSize, ticketLevels } from './strategy.bundle.mjs';
import { backtestTouches } from '../src/services/strategy/backtest';

const bar = (time, o, h, l, c) => ({ time, open: o, high: h, low: l, close: c, volume: null, complete: true });

/** A touch the ticket builder will accept: EUR/USD, ATR gives a ~15-pip stop. */
const touch = (over = {}) => ({
  id: 'ema50-touch|EUR/USD|30M|1000',
  strategy: 'ema50-touch',
  symbol: 'EUR/USD',
  timeframe: '30M',
  barTime: 1000,
  detectedAt: 0,
  source: 'candle',
  price: 1.1,
  ema: 1.1,
  tolerancePips: 2,
  atr: 0.001,
  distancePips: 0.5,
  approach: 'above',
  outcome: 'bounce',
  trend: 'up',
  bias: 'long',
  counterTrend: false,
  ichimoku: null,
  ...over,
});

describe('signalRow — rule 1, the entry must be a price that traded', () => {
  it('records a touch that never reached the entry as nofill, not as a trade', () => {
    const s = touch();
    const { entry } = ticketLevels(s);
    // The bar's whole range sits above the entry: a resting limit there never
    // filled. The touch is real (the BAND was entered); the trade is not.
    const row = signalRow(s, bar(1000, entry + 0.002, entry + 0.003, entry + 0.001, entry + 0.002), 0);
    expect(row.result).toBe('nofill');
  });

  it('opens a trade when the bar traded through the entry', () => {
    const s = touch();
    const { entry } = ticketLevels(s);
    const row = signalRow(s, bar(1000, entry + 0.001, entry + 0.002, entry - 0.0001, entry + 0.001), 0);
    expect(row.result).toBe('open');
    expect(row.entry).toBe(entry);
    expect(row.stop_pips).toBeCloseTo(Math.abs(entry - row.stop_loss) / pipSize('EUR/USD'), 6);
  });
});

describe('signalRow — rule 2, the entry bar can lose but cannot win', () => {
  it('stops the trade out on its own bar when that bar covered the stop', () => {
    const s = touch();
    const { entry, stop } = ticketLevels(s);
    const row = signalRow(s, bar(1000, entry, entry + 0.0005, stop - 0.0001, entry), 0);
    expect(row.result).toBe('sl');
  });

  it('does NOT credit the target on the entry bar, because OHLC cannot order it', () => {
    const s = touch();
    const { entry, target } = ticketLevels(s);
    // The bar reaches the target, but nothing says the high came after the
    // fill. Crediting it would invent a win out of bar geometry.
    const row = signalRow(s, bar(1000, entry, target + 0.0005, entry - 0.0001, target), 0);
    expect(row.result).toBe('open');
  });

  it('prefers the stop when the entry bar covers both', () => {
    const s = touch();
    const { entry, stop, target } = ticketLevels(s);
    const row = signalRow(s, bar(1000, entry, target + 0.001, stop - 0.001, entry), 0);
    expect(row.result).toBe('sl');
  });
});

describe('resolveOpenTrade', () => {
  const openTrade = (over = {}) => ({
    id: 't',
    symbol: 'EUR/USD',
    timeframe: '30M',
    direction: 'LONG',
    entry: 1.1,
    stop_loss: 1.099,
    take_profit: 1.102,
    stop_pips: 10,
    bar_time: 1000,
    ...over,
  });

  it('leaves a trade open while price has decided nothing', () => {
    const candles = [bar(1000, 1.1, 1.1005, 1.0999, 1.1), bar(2000, 1.1, 1.1005, 1.0995, 1.1)];
    expect(resolveOpenTrade(openTrade(), candles)).toBeNull();
  });

  it('skips the entry bar, which already had its one chance', () => {
    const { entry, take_profit } = { entry: 1.1, take_profit: 1.102 };
    // The ENTRY bar reaches the target. It must not close the trade here.
    const candles = [bar(1000, entry, take_profit + 0.001, entry, entry), bar(2000, entry, entry, entry, entry)];
    expect(resolveOpenTrade(openTrade(), candles)).toBeNull();
  });

  it('closes at the target and reports the gain in pips', () => {
    const candles = [bar(1000, 1.1, 1.1, 1.1, 1.1), bar(2000, 1.1, 1.1025, 1.0999, 1.102)];
    const out = resolveOpenTrade(openTrade(), candles);
    expect(out.result).toBe('tp');
    expect(out.exitPrice).toBe(1.102);
    expect(out.barsHeld).toBe(1);
    expect(out.resultPips).toBeCloseTo(20, 6); // 1.102 − 1.100 = 20 pips
  });

  it('closes at the stop and reports the loss in pips', () => {
    const candles = [bar(1000, 1.1, 1.1, 1.1, 1.1), bar(2000, 1.1, 1.1, 1.0985, 1.099)];
    const out = resolveOpenTrade(openTrade(), candles);
    expect(out.result).toBe('sl');
    expect(out.resultPips).toBeCloseTo(-10, 6);
  });

  it('gives an ambiguous bar to the stop, same as the backtest', () => {
    const candles = [bar(1000, 1.1, 1.1, 1.1, 1.1), bar(2000, 1.1, 1.103, 1.098, 1.1)];
    expect(resolveOpenTrade(openTrade(), candles).result).toBe('sl');
  });

  it('uses the pair\'s own pip size, so a JPY result is not inflated 100×', () => {
    const t = openTrade({ symbol: 'USD/JPY', entry: 150, stop_loss: 149.9, take_profit: 150.2 });
    const candles = [bar(1000, 150, 150, 150, 150), bar(2000, 150, 150.25, 149.95, 150.2)];
    expect(resolveOpenTrade(t, candles).resultPips).toBeCloseTo(20, 6);
  });

  /**
   * Each run only fetches the newest few hundred bars, so a trade that has
   * not resolved by then scrolls out of view permanently. Leaving it 'open'
   * would mean the open count grows for ever with trades nothing is tracking.
   */
  it('retires a trade whose entry bar has scrolled out of the window', () => {
    const out = resolveOpenTrade(openTrade({ bar_time: 1 }), [bar(9000, 1.1, 1.1, 1.1, 1.1)]);
    expect(out.result).toBe('expired');
    // No outcome was observed, so no number is invented for one.
    expect(out.resultPips).toBeNull();
    expect(out.exitPrice).toBeNull();
  });

  /**
   * The opposite case must NOT expire. A bar newer than every candle we hold
   * means the provider returned short history this time, not that the trade
   * is over — expiring it would throw away a live trade on a bad response.
   */
  it('waits, rather than expiring, when the window starts after the entry bar', () => {
    expect(resolveOpenTrade(openTrade({ bar_time: 9999 }), [bar(1000, 1.1, 1.1, 1.1, 1.1)])).toBeNull();
  });

  it('does not expire anything when the provider returned no candles at all', () => {
    expect(resolveOpenTrade(openTrade({ bar_time: 1000 }), [])).toBeNull();
  });
});

/**
 * The agreement test.
 *
 * Replay a real fixture through the backtest, then through the scanner's own
 * two functions, and require the same verdict on every trade the backtest
 * took. This is the test that would fail if someone "fixed" one of the three
 * rules in one place and not the other.
 */
describe('the scanner and the backtest reach the same verdict', () => {
  const csv = readFileSync(new URL('../fixtures/market/EURUSD_1H.csv', import.meta.url), 'utf8');
  const candles = csv
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const [t, o, h, l, c] = line.split(',').map(Number);
      return { time: t, open: o, high: h, low: l, close: c, volume: null, complete: true };
    });

  it('agrees on outcome and pips for every trade the backtest opened', () => {
    // No spread on either side: the scanner records raw pips, so the
    // comparison has to ask the backtest for raw pips too.
    const bt = backtestTouches(candles, 'EUR/USD', '1H', { costPips: 0 });
    const byId = new Map(bt.trades.map((t) => [t.id, t]));

    const { signals } = analyseEma50Touch(candles, 'EUR/USD', '1H');
    const byTime = new Map(candles.map((c) => [c.time, c]));

    let compared = 0;
    for (const s of signals) {
      const trade = byId.get(s.id);
      if (!trade) continue; // the backtest was already in a position: not comparable
      const row = signalRow(s, byTime.get(s.barTime), 0);
      expect(row, `no ticket for ${s.id}`).not.toBeNull();

      // Same levels, to the stored precision.
      expect(row.entry).toBeCloseTo(trade.entry, 10);
      expect(row.stop_loss).toBeCloseTo(trade.stop, 10);
      expect(row.take_profit).toBeCloseTo(trade.target, 10);
      expect(row.stop_pips).toBeCloseTo(trade.stopPips, 8);

      const outcome = row.result === 'open' ? resolveOpenTrade({ ...row, bar_time: s.barTime }, candles) : null;
      const scannerExit = row.result === 'open' ? (outcome?.result ?? 'open') : row.result;
      const scannerPips = row.result === 'sl' ? -row.stop_pips : (outcome?.resultPips ?? null);

      expect(scannerExit, `exit disagrees on ${s.id}`).toBe(trade.exit);
      if (trade.pips !== null) expect(scannerPips, `pips disagree on ${s.id}`).toBeCloseTo(trade.pips, 6);
      compared++;
    }

    // Guard the guard: a comparison that silently compared nothing would pass.
    expect(compared, 'the fixture must produce comparable trades').toBeGreaterThan(50);
  });

  it('refuses the same fills the backtest refuses', () => {
    const bt = backtestTouches(candles, 'EUR/USD', '1H', { costPips: 0 });
    const traded = new Set(bt.trades.map((t) => t.id));
    const { signals } = analyseEma50Touch(candles, 'EUR/USD', '1H');
    const byTime = new Map(candles.map((c) => [c.time, c]));

    let nofill = 0;
    for (const s of signals) {
      const row = signalRow(s, byTime.get(s.barTime), 0);
      if (row?.result !== 'nofill') continue;
      nofill++;
      // A bar the scanner calls a no-fill must never appear as a backtest trade.
      expect(traded.has(s.id), `${s.id} was a no-fill here but a trade there`).toBe(false);
    }
    expect(nofill, 'the fixture must contain no-fills').toBeGreaterThan(10);
  });
});
