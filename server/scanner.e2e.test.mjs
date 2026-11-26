/**
 * The whole scan loop, end to end, against a real PostgreSQL server.
 *
 *   stubbed Yahoo body ─▶ parseYahooChart ─▶ analyseIchimoku ─▶ ticketLevels
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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Shape those rows the way Twelve Data's time_series returns them: newest
 * last, datetimes rather than epochs, numbers as strings.
 */
function tdBody(rows) {
  const pad = (n) => String(n).padStart(2, '0');
  return {
    values: rows.map((c) => {
      const d = new Date(c.time * 1000);
      return {
        datetime:
          `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
          `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
        open: String(c.open),
        high: String(c.high),
        low: String(c.low),
        close: String(c.close),
      };
    }),
  };
}

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
    /**
     * EVERY migration, read from disk in filename order — not a named one.
     *
     * This used to apply '0001_signals.sql' by name, and when 0002 retired
     * the EMA columns this test kept building the old table and failed with
     * `column "kumo" does not exist`. Reading the directory means a new
     * migration is exercised here the moment it is added, which is the only
     * way this test can keep being an end-to-end test of production's schema.
     */
    const dir = new URL('../db/migrations/', import.meta.url);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((name) => ({ name, text: readFileSync(join(dir.pathname, name), 'utf8') }));
    expect(files.length, 'there must be migrations to apply').toBeGreaterThan(1);
    await migrate(files, env);
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
    /**
     * Every row carries a usable ticket AND the Ichimoku detail behind it. The
     * detail is checked here rather than only in the unit test because the
     * failure this catches is a schema one: a column the insert names but the
     * table does not have, or a value that arrives as null because the column
     * list and the record definition drifted apart.
     */
    /**
     * One strategy, and BOTH of its entries have to come through the whole
     * pipeline. Pinning only the pullback here would pass while the breakout
     * wrote nothing at all — which is a live possibility, since the breakout
     * is much the rarer of the two and its row carries two columns
     * (senkou_ahead_a/b) the pullback does not depend on.
     */
    expect(new Set(rows.map((r) => r.strategy))).toEqual(new Set(['ichimoku']));
    const byEntry = new Set(rows.map((r) => r.entry_type));
    expect([...byEntry].sort(), 'both entries should have recorded something').toEqual([
      'breakout',
      'pullback',
    ]);

    for (const r of rows) {
      expect(r.direction === 'LONG' || r.direction === 'SHORT').toBe(true);
      expect(Number(r.stop_pips)).toBeGreaterThan(0);
      // Entry is the signal bar's close, so every recorded signal is a trade:
      // 'nofill' cannot occur any more and must not appear.
      expect(['open', 'tp', 'sl']).toContain(r.result);

      expect(r.kumo === 'above' || r.kumo === 'below').toBe(true);
      expect(r.direction).toBe(r.kumo === 'above' ? 'LONG' : 'SHORT');
      expect(Number(r.kijun)).toBeGreaterThan(0);
      expect(Number(r.senkou_a)).toBeGreaterThan(0);
      expect(Number(r.senkou_b)).toBeGreaterThan(0);
      expect(Number(r.range_pips)).toBeGreaterThan(0);
      expect(Number(r.score)).toBeGreaterThanOrEqual(1);
      expect(Number(r.score)).toBeLessThanOrEqual(Number(r.checks_total));
      // The conditions arrive as the detector stated them, not as columns.
      expect(Array.isArray(r.checks)).toBe(true);
      expect(r.checks.length).toBe(Number(r.checks_total));
      for (const c of r.checks) {
        expect(typeof c.label).toBe('string');
        expect(typeof c.required).toBe('boolean');
      }
      // Every required check passed, or the signal would not exist.
      for (const c of r.checks) if (c.required) expect(c.pass).toBe(true);

      /**
       * The stop sits beyond the structure the entry is based on, which is
       * the one thing about this strategy that cannot be checked from the
       * indicator columns alone — a breakout needs the cloud edge, a pullback
       * needs Kijun, and getting them the wrong way round would still produce
       * a plausible-looking row.
       */
      const far = r.kumo === 'above'
        ? Math.min(Number(r.senkou_a), Number(r.senkou_b))
        : Math.max(Number(r.senkou_a), Number(r.senkou_b));
      const level = r.entry_type === 'pullback' ? Number(r.kijun) : far;
      if (r.direction === 'LONG') expect(Number(r.stop_loss)).toBeLessThan(level);
      else expect(Number(r.stop_loss)).toBeGreaterThan(level);

      if (r.entry_type === 'breakout') {
        expect(Number(r.senkou_ahead_a)).toBeGreaterThan(0);
        expect(Number(r.senkou_ahead_b)).toBeGreaterThan(0);
      }
    }

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
    const out = await runScan({ env: { ...env, TWELVEDATA_API_KEY_1: '' } });

    expect(out.recorded).toBe(0);
    expect(out.errors.join(' ')).toContain('429');
    expect(out.ok).toBe(false); // every pair failed
    expect((await recentSignals({ limit: 10 }, env)).length).toBe(0);

    const [logged] = await pool.query('select * from scanner_runs order by id desc limit 1').then((r) => r.rows);
    expect(logged.ok).toBe(false);
    expect(logged.errors.length).toBeGreaterThan(0);
  });

  /**
   * The failure that ran in production for four days: Yahoo's chart endpoint
   * rate-limits datacentre IPs, so every scan returned "Yahoo 429" seven
   * times and recorded nothing. Yahoo stays first because it is free; Twelve
   * Data has to catch what it refuses.
   */
  describe('when Yahoo refuses', () => {
    const withKey = { ...env, TWELVEDATA_API_KEY_1: 'test-key', TWELVEDATA_REST_URL: 'https://td.test' };

    it('falls back to Twelve Data and still records signals', async () => {
      const seen = { yahoo: 0, td: 0 };
      globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('finance/chart')) {
          seen.yahoo++;
          return { ok: false, status: 429, json: async () => ({}) };
        }
        seen.td++;
        expect(u).toContain('apikey=test-key');
        expect(u).toContain('interval=1h');
        return { ok: true, status: 200, json: async () => tdBody(candles.slice(0, 300)) };
      };

      const out = await runScan({ env: withKey });
      expect(out.ok).toBe(true);
      expect(out.errors).toEqual([]);
      expect(out.recorded).toBeGreaterThan(0);
      expect(out.provider).toBe('twelvedata');
      expect(out.yahooParked).toMatch(/429/);

      // Yahoo is asked ONCE for the whole run, not once per pair: leaning on
      // an endpoint that is already rate-limiting is how a soft limit becomes
      // a hard one.
      expect(seen.yahoo).toBe(1);
      expect(seen.td).toBe(1); // one pair in SCAN_SYMBOLS
    });

    it('tries the next pooled key when the first one is rejected', async () => {
      const keys = [];
      globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('finance/chart')) return { ok: false, status: 429, json: async () => ({}) };
        const key = new URL(u).searchParams.get('apikey');
        keys.push(key);
        // Twelve Data reports this INSIDE the body, with HTTP 200.
        if (key === 'dead') return { ok: true, status: 200, json: async () => ({ status: 'error', code: 429, message: 'run out of credits' }) };
        return { ok: true, status: 200, json: async () => tdBody(candles.slice(0, 300)) };
      };

      const out = await runScan({
        env: { ...withKey, TWELVEDATA_API_KEY_1: 'dead', TWELVEDATA_API_KEY_2: 'alive' },
      });
      expect(keys).toEqual(['dead', 'alive']);
      expect(out.recorded).toBeGreaterThan(0);
    });

    it('reports both providers when the fallback fails too', async () => {
      globalThis.fetch = async (url) =>
        String(url).includes('finance/chart')
          ? { ok: false, status: 429, json: async () => ({}) }
          : { ok: false, status: 500, json: async () => ({}) };

      const out = await runScan({ env: withKey });
      expect(out.ok).toBe(false);
      // Naming only the fallback would hide that Yahoo went first.
      expect(out.errors.join(' ')).toMatch(/Twelve Data 500/);
      expect(out.errors.join(' ')).toMatch(/Yahoo 429/);
    });

    it('says so plainly when there is no fallback key configured', async () => {
      globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
      const out = await runScan({ env: { ...env, TWELVEDATA_API_KEY_1: '' } });
      expect(out.errors.join(' ')).toMatch(/no Twelve Data API key configured/);
    });
  });

  it('stays on Yahoo, and does not spend a credit, while Yahoo works', async () => {
    window = { from: 0, to: 300 };
    let td = 0;
    const realStub = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (!String(url).includes('finance/chart')) td++;
      return realStub(url);
    };
    const out = await runScan({ env: { ...env, TWELVEDATA_API_KEY_1: 'test-key' } });
    expect(out.provider).toBe('yahoo');
    expect(out.yahooParked).toBeNull();
    expect(td, 'Twelve Data must not be touched when Yahoo answers').toBe(0);
  });
});
