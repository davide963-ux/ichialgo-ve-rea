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
import { resolveOpenTrade, scannerConfig, signalRow } from './scanner.mjs';
import { TIMEFRAME_SECONDS, analyseIchimoku, pipSize, ticketLevels } from './strategy.bundle.mjs';
import { backtest } from '../src/services/strategy/backtest';

const bar = (time, o, h, l, c) => ({ time, open: o, high: h, low: l, close: c, volume: null, complete: true });

/** A signal the ticket builder will accept: EUR/USD, a 30-pip stop. */
const signal = (over = {}) => ({
  id: 'ichimoku-kijun|EUR/USD|30M|1000',
  strategy: 'ichimoku-kijun',
  symbol: 'EUR/USD',
  timeframe: '30M',
  barTime: 1000,
  detectedAt: 0,
  source: 'candle',
  direction: 'LONG',
  kumo: 'above',
  entry: 1.1,
  stop: 1.097,
  target: 1.106,
  stopPips: 30,
  rangePips: 75,
  tenkan: 1.1005,
  kijun: 1.0998,
  senkouA: 1.097,
  senkouB: 1.096,
  senkouAheadA: 1.1005,
  senkouAheadB: 1.0965,
  distancePips: 2,
  cloudPips: 10,
  checks: [
    { label: 'Cloud in effect bullish', pass: true, detail: '1.097 vs 1.096', required: true },
    { label: 'Cloud 26 bars ahead bullish', pass: true, detail: '1.1005 vs 1.0965', required: true },
    { label: 'Chikou free', pass: true, detail: 'clear', required: true },
    { label: 'Tenkan above Kijun', pass: true, detail: '1.1005 vs 1.0998', required: true },
  ],
  score: 4,
  checksTotal: 4,
  ...over,
});

/**
 * There is no fill rule and no entry-bar resolution to test any more, which is
 * why the two describe blocks that used to be here are gone. Entry is the
 * signal bar's close, so the fill is certain and the bar is over; the first
 * candle that can decide anything is the next one, which is `resolveOpenTrade`
 * below. What is left to pin on `signalRow` is that it stores the levels and
 * the confirmations faithfully and always opens the trade.
 */
describe('signalRow', () => {
  it('stores the ticket the trade-plan card would show, and opens it', () => {
    const s = signal();
    const { entry, stop, target } = ticketLevels(s);
    const row = signalRow(s, 0);
    expect(row.result).toBe('open');
    expect(row.entry).toBe(entry);
    expect(row.stop_loss).toBe(stop);
    expect(row.take_profit).toBe(target);
    expect(row.stop_pips).toBeCloseTo(Math.abs(entry - stop) / pipSize('EUR/USD'), 6);
    // Nothing is resolved at insert time: the entry bar is already behind it.
    expect(row.exit_price).toBeNull();
    expect(row.exit_at).toBeNull();
    expect(row.bars_held).toBeNull();
    expect(row.result_pips).toBeNull();
  });

  /**
   * The conditions go in as the detector stated them, not as named columns.
   * Three strategies with three different rule sets cannot share a fixed set
   * of booleans, so what has to survive the round trip is the list itself —
   * including a check that could not be answered, which must stay null rather
   * than flatten to false. The history has to be able to say "not knowable"
   * as well as "failed".
   */
  it('stores the lines and the whole check list, not just the total', () => {
    const unknown = signal().checks.map((c, i) => (i === 2 ? { ...c, pass: null, detail: 'too few bars' } : c));
    const row = signalRow(signal({ checks: unknown, score: 3 }), 0);
    expect(row.kumo).toBe('above');
    expect(row.kijun).toBe(1.0998);
    expect(row.tenkan).toBe(1.1005);
    expect(row.senkou_a).toBe(1.097);
    expect(row.senkou_b).toBe(1.096);
    expect(row.senkou_ahead_a).toBe(1.1005);
    expect(row.senkou_ahead_b).toBe(1.0965);
    expect(row.range_pips).toBe(75);
    expect(row.cloud_pips).toBe(10);
    expect(row.score).toBe(3);
    expect(row.checks_total).toBe(4);
    expect(row.checks).toHaveLength(4);
    expect(row.checks[2].pass).toBeNull();
    expect(row.checks[3].label).toBe('Tenkan above Kijun');
  });

  it('mirrors the ticket for a short', () => {
    const row = signalRow(signal({ direction: 'SHORT', kumo: 'below', stop: 1.103, target: 1.094 }), 0);
    expect(row.direction).toBe('SHORT');
    expect(row.stop_loss).toBeGreaterThan(row.entry);
    expect(row.take_profit).toBeLessThan(row.entry);
  });

  it('refuses a signal with no usable ticket rather than storing an unmeasurable row', () => {
    expect(signalRow(signal({ entry: Number.NaN }), 0)).toBeNull();
    expect(signalRow(signal({ stop: 0 }), 0)).toBeNull();
  });

  it('records the detection time in whole seconds, as the column expects', () => {
    expect(signalRow(signal(), 1_763_208_123_456).detected_at).toBe(1_763_208_123);
  });
});

/**
 * The lookback is what makes an irregular schedule harmless, so its size is a
 * claim about reality rather than a taste: GitHub delivered this workflow's
 * runs 7.4 hours apart on average over 81 hours, worst gap 9.4 hours. A
 * window smaller than that leaves closed bars nobody ever looks at.
 */
describe('scannerConfig lookback', () => {
  const WORST_OBSERVED_GAP_HOURS = 9.4;

  it('covers the worst observed gap between scheduled runs, on the scan timeframe', () => {
    const { lookbackBars, timeframe } = scannerConfig({});
    const hours = (lookbackBars * TIMEFRAME_SECONDS[timeframe]) / 3600;
    expect(hours).toBeGreaterThan(WORST_OBSERVED_GAP_HOURS);
  });

  it('stays inside the candle window, since a bar outside it cannot be recovered', () => {
    const { lookbackBars } = scannerConfig({});
    expect(lookbackBars).toBeLessThan(300);
  });

  it('can be overridden, and never drops below one bar', () => {
    expect(scannerConfig({ SCAN_LOOKBACK_BARS: '12' }).lookbackBars).toBe(12);
    expect(scannerConfig({ SCAN_LOOKBACK_BARS: '0' }).lookbackBars).toBeGreaterThanOrEqual(1);
    expect(scannerConfig({ SCAN_LOOKBACK_BARS: 'nonsense' }).lookbackBars).toBeGreaterThanOrEqual(1);
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

  it('skips the entry bar, whose range is already behind the fill', () => {
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
 * took. This is the test that would fail if someone "fixed" one of the rules
 * in one place and not the other.
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
    const bt = backtest('ichimoku-kijun', candles, 'EUR/USD', '1H', { costPips: 0 });
    const byId = new Map(bt.trades.map((t) => [t.id, t]));

    const { signals } = analyseIchimoku(candles, 'EUR/USD', '1H');

    let compared = 0;
    for (const s of signals) {
      const trade = byId.get(s.id);
      if (!trade) continue; // the backtest was already in a position: not comparable
      const row = signalRow(s, 0);
      expect(row, `no ticket for ${s.id}`).not.toBeNull();

      // Same levels, to the stored precision.
      expect(row.entry).toBeCloseTo(trade.entry, 10);
      expect(row.stop_loss).toBeCloseTo(trade.stop, 10);
      expect(row.take_profit).toBeCloseTo(trade.target, 10);
      expect(row.stop_pips).toBeCloseTo(trade.stopPips, 8);

      const outcome = resolveOpenTrade({ ...row, bar_time: s.barTime }, candles);
      expect(outcome?.result ?? 'open', `exit disagrees on ${s.id}`).toBe(trade.exit);
      if (trade.pips !== null) {
        expect(outcome?.resultPips ?? null, `pips disagree on ${s.id}`).toBeCloseTo(trade.pips, 6);
      }
      compared++;
    }

    // Guard the guard: a comparison that silently compared nothing would pass.
    expect(compared, 'the fixture must produce comparable trades').toBeGreaterThan(20);
  });

  /**
   * The scanner records EVERY recent signal; the backtest trades one position
   * at a time. So the scanner is a superset, and the thing worth pinning is
   * that it never DROPS one the backtest took — the old version of this test
   * pinned the mirror image (that both refused the same fills), which no
   * longer exists now that every signal fills.
   */
  it('records every signal the backtest traded, and more besides', () => {
    const bt = backtest('ichimoku-kijun', candles, 'EUR/USD', '1H', { costPips: 0 });
    const { signals } = analyseIchimoku(candles, 'EUR/USD', '1H');
    const recorded = new Set(signals.map((s) => signalRow(s, 0)).filter(Boolean).map((r) => r.id));

    for (const t of bt.trades) {
      expect(recorded.has(t.id), `${t.id} was traded but would not be recorded`).toBe(true);
    }
    expect(recorded.size, 'the scanner must record more than the backtest trades').toBeGreaterThan(bt.trades.length);
  });
});
