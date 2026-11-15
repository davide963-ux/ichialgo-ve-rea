/**
 * The whole scan loop, end to end, against a real PostgreSQL server.
 *
 *   stubbed Yahoo body ─▶ parseYahooChart ─▶ analyseEma50Touch ─▶ ticketLevels
 *        ─▶ signalRow ─▶ recordSignals ─▶ [Postgres] ─▶ openTrades
 *        ─▶ resolveOpenTrade ─▶ closeTrade ─▶ finishRun
 *
 * The unit tests prove each piece. This proves they are wired to each other:
 * that the scanner writes rows Postgres accepts, that a second run does not
 * duplicate the first, and that a trade opened by one run is closed by a
 * later one when more candles arrive. Those are the failures that only show
 * up in production, because each part is individually fine.
 *
 * Yahoo is stubbed rather than called. The candles come from a checked-in
 * fixture, so the test is deterministic and does not depend on a live
 * unofficial endpoint — and the stub sits at the `fetch` boundary, so the
 * real URL building and the real parser both still run.
 *
 * Needs TEST_DATABASE_URL; skipped without it.
 */
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate, recentSignals, resetClient, setDriver } from './db.mjs';
import { createSchemaPool, pgDriver } from './pgTestHarness.mjs';
import { runScan } from './scanner.mjs';

const URL_ = process.env.TEST_DATABASE_URL;
const run = URL_ ? describe : describe.skip;

/** The fixture, as rows of OHLC. */
const candles = readFileSync(new URL('../fixtures/market/EURUSD_1H.csv', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((l) => {
    const [t, o, h, lo, c] = l.split(',').map(Number);
    return { time: t, open: o, high: h, low: lo, close: c };
  });

/** Shape those rows the way Yahoo would return them. */
function yahooBody(rows) {
  return {
    chart: {
      result: [
        {
          timestamp: rows.map((c) => c.time),
          indicators: {
            quote: [
              {
                open: rows.map((c) => c.open),
                high: rows.map((c) => c.high),
                low: rows.map((c) => c.low),
                close: rows.map((c) => c.close),
              },
            ],
          },
        },
      ],
    },
  };
}

run('runScan end to end', () => {
  let pool;
  let restoreDriver;
  let realFetch;
  /** Moved by each test to decide how much history "Yahoo" has produced. */
  let window = { from: 0, to: 300 };

  const env = {
    DATABASE_URL: URL_,
    SCAN_TIMEFRAME: '1H', // the fixture is hourly
    SCAN_SYMBOLS: 'EUR/USD',
    SCAN_LOOKBACK_BARS: '400', // the fixture is history, so consider all of it
  };

  beforeAll(async () => {
    // Private schema: db.test.mjs runs in a parallel worker and truncates the
    // same table names.
    pool = await createSchemaPool(URL_, 'test_e2e');
    restoreDriver = setDriver(() => pgDriver(pool));
    const text = readFileSync(new URL('../db/migrations/0001_signals.sql', import.meta.url), 'utf8');
    await migrate([{ name: '0001_signals.sql', text }], env);
  });

  afterAll(async () => {
    if (restoreDriver) setDriver(restoreDriver);
    resetClient();
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('truncate signals, scanner_runs restart identity');
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      // The real URL builder still ran; assert it asked for what we expect.
      expect(String(url)).toContain('EURUSD%3DX');
      return { ok: true, status: 200, json: async () => yahooBody(candles.slice(window.from, window.to)) };
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('records signals, opens trades and logs the run', async () => {
    window = { from: 0, to: 300 };
    const out = await runScan({ env, now: Date.now() });

    expect(out.ok).toBe(true);
    expect(out.errors).toEqual([]);
    expect(out.scanned).toBe(1);
    expect(out.recorded).toBeGreaterThan(10);

    const rows = await recentSignals({ limit: 1000 }, env);
    expect(rows.length).toBe(out.recorded);
    // Every row carries a usable ticket; a row without one cannot be measured.
    for (const r of rows) {
      expect(r.direction === 'LONG' || r.direction === 'SHORT').toBe(true);
      expect(Number(r.stop_pips)).toBeGreaterThan(0);
      expect(['open', 'sl', 'nofill']).toContain(r.result);
    }
    // The fill rule must actually reject some: if everything filled, rule 1
    // is not running and the history is inflated.
    expect(rows.filter((r) => r.result === 'nofill').length).toBeGreaterThan(0);

    const [logged] = await pool.query('select * from scanner_runs').then((r) => r.rows);
    expect(logged.ok).toBe(true);
    expect(logged.recorded).toBe(out.recorded);
    expect(logged.finished_at).toBeTruthy();
  });

  it('writes nothing new when the same window is scanned again', async () => {
    window = { from: 0, to: 300 };
    const first = await runScan({ env });
    const second = await runScan({ env });

    expect(first.recorded).toBeGreaterThan(10);
    expect(second.recorded).toBe(0);
    expect((await recentSignals({ limit: 1000 }, env)).length).toBe(first.recorded);
  });

  /**
   * The point of the whole design: a trade opened on one run is closed by a
   * later one, once the market has produced the bars that decide it.
   */
  it('closes trades on a later run, once more candles exist', async () => {
    window = { from: 0, to: 300 };
    await runScan({ env });
    const openAfterFirst = (await recentSignals({ limit: 1000 }, env)).filter((r) => r.result === 'open');
    expect(openAfterFirst.length, 'the first window must leave trades running').toBeGreaterThan(0);

    // The market moves on: 200 more hours of candles.
    window = { from: 0, to: 500 };
    const second = await runScan({ env });
    expect(second.resolved, 'later candles must resolve earlier trades').toBeGreaterThan(0);

    const rows = await recentSignals({ limit: 1000 }, env);
    const closed = rows.filter((r) => r.result === 'tp' || r.result === 'sl');
    expect(closed.length).toBeGreaterThan(0);

    for (const c of closed) {
      expect(c.result_pips).not.toBeNull();
      expect(c.exit_at).not.toBeNull();
      expect(Number(c.bars_held)).toBeGreaterThanOrEqual(0);
      // A take profit must gain and a stop must lose: a sign error here would
      // make a losing strategy read as a winning one.
      if (c.result === 'tp') expect(Number(c.result_pips)).toBeGreaterThan(0);
      if (c.result === 'sl') expect(Number(c.result_pips)).toBeLessThan(0);
    }
  });

  it('survives a provider failure without writing a half-finished run', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
    const out = await runScan({ env });

    expect(out.recorded).toBe(0);
    expect(out.errors.join(' ')).toContain('429');
    expect(out.ok).toBe(false); // every pair failed
    expect((await recentSignals({ limit: 10 }, env)).length).toBe(0);

    const [logged] = await pool.query('select * from scanner_runs order by id desc limit 1').then((r) => r.rows);
    expect(logged.ok).toBe(false);
    expect(logged.errors.length).toBeGreaterThan(0);
  });
});
