/**
 * Every statement in db.mjs, run against a real PostgreSQL server.
 *
 * WHY THIS IS AN INTEGRATION TEST AND NOT A MOCK
 * ──────────────────────────────────────────────
 * A mocked database proves that db.mjs calls a function. It does not prove
 * that `jsonb_to_recordset` lists the columns the table actually has, that
 * `on conflict (id) do nothing` has an index to conflict on, or that
 * `extract(epoch from bar_time)` returns what the UI expects. Those are the
 * things that break, and they only break in Postgres.
 *
 * The Neon driver talks HTTP to Neon's proxy and cannot address a local
 * server, so `setDriver` swaps in the adapter below — a tagged template over
 * `pg` with neon()'s exact shape (rows array, plus `.query` for raw text).
 * The SQL is unchanged; only the transport differs.
 *
 * Skipped automatically when TEST_DATABASE_URL is unset, so a normal
 * `npm test` on a machine with no Postgres still passes. CI and anyone
 * changing this file should set it:
 *
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/ichialgo npm test
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSchemaPool, pgDriver } from './pgTestHarness.mjs';
import {
  closeTrade,
  finishRun,
  migrate,
  openTrades,
  recentSignals,
  recordSignals,
  resetClient,
  setDriver,
  signalStats,
  startRun,
} from './db.mjs';

const URL_ = process.env.TEST_DATABASE_URL;
const run = URL_ ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

run('db.mjs against PostgreSQL', () => {
  let pool;
  let restore;
  const env = { DATABASE_URL: URL_ };

  beforeAll(async () => {
    // Private schema: scanner.e2e.test.mjs runs in a parallel worker and
    // truncates the same table names.
    pool = await createSchemaPool(URL_, 'test_db');
    restore = setDriver(() => pgDriver(pool));

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((name) => ({ name, text: readFileSync(join(migrationsDir, name), 'utf8') }));

    // The schema was just created empty, so this proves the migration BUILDS
    // the tables rather than finding them already there.
    const ran = await migrate(files, env);
    expect(ran.length, 'the migration must actually apply').toBeGreaterThan(0);
  });

  afterAll(async () => {
    if (restore) setDriver(restore);
    resetClient();
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('truncate signals, scanner_runs restart identity');
  });

  const row = (over = {}) => ({
    id: 'ema50-touch|EUR/USD|30M|1000',
    strategy: 'ema50-touch',
    symbol: 'EUR/USD',
    timeframe: '30M',
    bar_time: 1_700_000_000,
    detected_at: 1_700_000_060,
    source: 'candle',
    price: 1.1,
    ema: 1.1,
    atr: 0.001,
    tolerance_pips: 2,
    distance_pips: 0.5,
    approach: 'above',
    outcome: 'bounce',
    trend: 'up',
    bias: 'long',
    counter_trend: false,
    ichimoku: { score: 4 },
    ichimoku_score: 4,
    direction: 'LONG',
    entry: 1.1,
    stop_loss: 1.099,
    take_profit: 1.102,
    stop_pips: 10,
    result: 'open',
    ...over,
  });

  it('is idempotent: a second migrate() applies nothing', async () => {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((name) => ({ name, text: readFileSync(join(migrationsDir, name), 'utf8') }));
    expect(await migrate(files, env)).toEqual([]);
  });

  it('inserts a batch and reads it back with the times as epoch seconds', async () => {
    expect(await recordSignals([row(), row({ id: 'b', symbol: 'USD/JPY', bar_time: 1_700_003_600 })], env)).toBe(2);
    const back = await recentSignals({}, env);
    expect(back).toHaveLength(2);
    // Newest first, and bar_time survives the timestamptz round trip as the
    // same number the UI formats.
    expect(Number(back[0].bar_time)).toBe(1_700_003_600);
    expect(back[0].symbol).toBe('USD/JPY');
    expect(back[1].ichimoku).toEqual({ score: 4 });
    expect(back[1].counter_trend).toBe(false);
  });

  /**
   * The rule the whole re-reading design rests on: the scanner looks at the
   * last few bars every run, so it offers the same signal repeatedly and the
   * database must take it once.
   */
  it('takes a repeated signal exactly once, and does not touch the stored row', async () => {
    await recordSignals([row()], env);
    expect(await recordSignals([row({ price: 9.9, outcome: 'cross' })], env)).toBe(0);
    const [stored] = await recentSignals({}, env);
    expect(Number(stored.price)).toBe(1.1);
    expect(stored.outcome).toBe('bounce');
  });

  it('never resurrects a closed trade when its bar is offered again', async () => {
    await recordSignals([row()], env);
    await closeTrade(
      { id: row().id, result: 'tp', exitPrice: 1.102, exitAt: 1_700_007_200, barsHeld: 2, resultPips: 20 },
      env,
    );
    // The lookback window reaches back over it on the next run.
    expect(await recordSignals([row()], env)).toBe(0);
    const [stored] = await recentSignals({}, env);
    expect(stored.result).toBe('tp');
    expect(Number(stored.result_pips)).toBe(20);
  });

  it('lists only open trades, oldest first', async () => {
    await recordSignals(
      [
        row({ id: 'old', bar_time: 1_700_000_000 }),
        row({ id: 'new', bar_time: 1_700_003_600 }),
        row({ id: 'done', bar_time: 1_700_001_000, result: 'sl' }),
        row({ id: 'skip', bar_time: 1_700_001_500, result: 'nofill' }),
      ],
      env,
    );
    const open = await openTrades(env);
    expect(open.map((t) => t.id)).toEqual(['old', 'new']);
    expect(Number(open[0].bar_time)).toBe(1_700_000_000);
  });

  /**
   * The concurrency guard. Two scanner invocations can overlap, and the
   * second must not overwrite an outcome the first already recorded.
   */
  it('closes a trade once; a second close changes nothing', async () => {
    await recordSignals([row()], env);
    const first = await closeTrade(
      { id: row().id, result: 'sl', exitPrice: 1.099, exitAt: 1_700_005_000, barsHeld: 1, resultPips: -10 },
      env,
    );
    const second = await closeTrade(
      { id: row().id, result: 'tp', exitPrice: 1.102, exitAt: 1_700_009_000, barsHeld: 5, resultPips: 20 },
      env,
    );
    expect(first).toBe(true);
    expect(second).toBe(false);
    const [stored] = await recentSignals({}, env);
    expect(stored.result).toBe('sl');
    expect(Number(stored.result_pips)).toBe(-10);
  });

  it('filters by symbol, and treats no symbol as every pair', async () => {
    await recordSignals([row(), row({ id: 'j', symbol: 'USD/JPY' })], env);
    expect(await recentSignals({ symbol: 'USD/JPY' }, env)).toHaveLength(1);
    expect(await recentSignals({ symbol: null }, env)).toHaveLength(2);
  });

  it('caps the limit rather than letting a request ask for the whole table', async () => {
    await recordSignals(
      Array.from({ length: 5 }, (_, i) => row({ id: `s${i}`, bar_time: 1_700_000_000 + i * 60 })),
      env,
    );
    expect(await recentSignals({ limit: 2 }, env)).toHaveLength(2);
    expect(await recentSignals({ limit: 99999 }, env)).toHaveLength(5); // capped, not rejected
    expect(await recentSignals({ limit: 0 }, env)).toHaveLength(5); // floored to the default
  });

  /** Totals are per symbol because adding a JPY pip to a EUR/USD pip is wrong. */
  it('reports stats per pair, counting only resolved trades in the pip total', async () => {
    await recordSignals(
      [
        row({ id: 'a', result: 'tp', bar_time: 1 }),
        row({ id: 'b', result: 'sl', bar_time: 2 }),
        row({ id: 'c', result: 'open', bar_time: 3 }),
        row({ id: 'd', result: 'nofill', bar_time: 4 }),
        row({ id: 'e', symbol: 'USD/JPY', result: 'tp', bar_time: 5 }),
      ],
      env,
    );
    await pool.query(`update signals set result_pips = 20 where id in ('a','e')`);
    await pool.query(`update signals set result_pips = -10 where id = 'b'`);
    // An open trade has no result yet; it must not be counted as a zero.
    await pool.query(`update signals set result_pips = null where id in ('c','d')`);

    const stats = await signalStats(env);
    const eur = stats.find((s) => s.symbol === 'EUR/USD');
    expect(Number(eur.total)).toBe(4);
    expect(Number(eur.open)).toBe(1);
    expect(Number(eur.nofill)).toBe(1);
    expect(Number(eur.net_pips)).toBe(10); // +20 − 10, open and nofill excluded
    expect(stats.find((s) => s.symbol === 'USD/JPY')).toBeTruthy();
  });

  it('records a scanner run from start to finish', async () => {
    const id = await startRun(env);
    expect(id).toBeTruthy();
    await finishRun(id, { ok: true, scanned: 7, recorded: 2, resolved: 1, errors: [], detail: { a: 1 } }, env);
    const [r] = await pool.query('select * from scanner_runs where id = $1', [id]).then((x) => x.rows);
    expect(r.ok).toBe(true);
    expect(r.scanned).toBe(7);
    expect(r.finished_at).toBeTruthy();
    expect(r.detail).toEqual({ a: 1 });
  });

  it('does nothing, rather than throwing, for an empty batch or a null run', async () => {
    expect(await recordSignals([], env)).toBe(0);
    await expect(finishRun(null, { ok: true, scanned: 0, recorded: 0, resolved: 0, errors: [] }, env)).resolves.toBeUndefined();
  });

  /** The trigger, which is the only thing that maintains updated_at. */
  it('bumps updated_at when a row changes', async () => {
    await recordSignals([row()], env);
    const before = await pool.query('select updated_at from signals').then((r) => r.rows[0].updated_at);
    await new Promise((r) => setTimeout(r, 10));
    await closeTrade({ id: row().id, result: 'tp', exitPrice: 1.102, exitAt: 1_700_005_000, barsHeld: 1, resultPips: 20 }, env);
    const after = await pool.query('select updated_at from signals').then((r) => r.rows[0].updated_at);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});
