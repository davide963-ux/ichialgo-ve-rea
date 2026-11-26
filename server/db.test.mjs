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
    id: 'ichimoku-kijun|EUR/USD|30M|1000',
    strategy: 'ichimoku-kijun',
    symbol: 'EUR/USD',
    timeframe: '30M',
    bar_time: 1_700_000_000,
    detected_at: 1_700_000_060,
    source: 'candle',
    kumo: 'above',
    kijun: 1.0998,
    tenkan: 1.1005,
    senkou_a: 1.097,
    senkou_b: 1.096,
    distance_pips: 2,
    range_pips: 75,
    score: 4,
    cloud_bullish: true,
    future_cloud_bullish: true,
    chikou_free: true,
    tenkan_agrees: true,
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
    expect(back[1].kumo).toBe('above');
    expect(Number(back[1].score)).toBe(4);
    expect(back[1].cloud_bullish).toBe(true);
    // A boolean must survive as a boolean, not as the string 'true': the
    // history page branches on it directly.
    expect(back[1].tenkan_agrees).toBe(true);
  });

  /**
   * The rule the whole re-reading design rests on: the scanner looks at the
   * last few bars every run, so it offers the same signal repeatedly and the
   * database must take it once.
   */
  it('takes a repeated signal exactly once, and does not touch the stored row', async () => {
    await recordSignals([row()], env);
    expect(await recordSignals([row({ entry: 9.9, score: 1 })], env)).toBe(0);
    const [stored] = await recentSignals({}, env);
    expect(Number(stored.entry)).toBe(1.1);
    expect(Number(stored.score)).toBe(4);
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
        row({ id: 'skip', bar_time: 1_700_001_500, result: 'expired' }),
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

  /**
   * The table holds rows from the retired EMA50-touch strategy — 0002 dropped
   * its indicator columns but kept the rows, because they are real
   * observations. Reads must not mix the two, or the history page would show
   * one strategy's ticket with another's nulls and average them together.
   */
  it('keeps a retired strategy’s rows out of the reads and out of the stats', async () => {
    await recordSignals(
      [
        row({ id: 'now', result: 'tp' }),
        row({ id: 'then', strategy: 'ema50-touch', result: 'tp', bar_time: 1_700_000_500 }),
      ],
      env,
    );
    await pool.query(`update signals set result_pips = 20`);

    const rows = await recentSignals({}, env);
    expect(rows.map((r) => r.id)).toEqual(['now']);

    const [eur] = await signalStats(env);
    expect(Number(eur.total)).toBe(1);
    expect(Number(eur.net_pips)).toBe(20); // not 40: the retired row is not added in

    // Asked for explicitly, it is still there — nothing was deleted.
    expect((await recentSignals({ strategy: 'ema50-touch' }, env)).map((r) => r.id)).toEqual(['then']);

    // But an open trade is resolved whatever produced it, or the open count
    // grows for ever with trades nothing is tracking.
    await pool.query(`update signals set result = 'open', result_pips = null`);
    expect((await openTrades(env)).map((t) => t.id).sort()).toEqual(['now', 'then']);
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
        row({ id: 'd', result: 'expired', bar_time: 4 }),
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
    expect(Number(eur.expired)).toBe(1);
    expect(Number(eur.net_pips)).toBe(10); // +20 − 10, open and expired excluded
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

/**
 * The UPGRADE path, which the suite above cannot cover.
 *
 * Everything else here migrates an EMPTY schema, so it proves the migrations
 * build the right tables from nothing. Production is not empty: the Neon
 * database has 0001 applied and rows written by the retired EMA50-touch
 * strategy, and 0002 drops NOT NULL columns out from under them.
 *
 * Those are different operations with different ways to fail — a drop of a
 * column some index or constraint still depends on, a new check constraint
 * that existing rows violate — and the only way to know is to do it in that
 * order, with a row in the table.
 */
run('migrating a database that already holds the old strategy’s rows', () => {
  let pool;
  let restore;
  const env = { DATABASE_URL: URL_ };

  const read = (name) => readFileSync(join(migrationsDir, name), 'utf8');

  beforeAll(async () => {
    pool = await createSchemaPool(URL_, 'test_upgrade');
    restore = setDriver(() => pgDriver(pool));
  });

  afterAll(async () => {
    if (restore) setDriver(restore);
    resetClient();
    await pool?.end();
  });

  it('keeps the old rows and their tickets, and adds the new columns', async () => {
    // 1. The database as it stood before this change.
    await migrate([{ name: '0001_signals.sql', text: read('0001_signals.sql') }], env);

    // 2. A row of the old shape, written through the old column list. It has
    //    to go in as raw SQL: recordSignals now names the new columns.
    await pool.query(
      `insert into signals (
         id, strategy, symbol, timeframe, bar_time, detected_at, source,
         price, ema, atr, tolerance_pips, distance_pips,
         approach, outcome, trend, bias, counter_trend, ichimoku, ichimoku_score,
         direction, entry, stop_loss, take_profit, stop_pips, result, result_pips
       ) values (
         'ema50-touch|EUR/USD|30M|1000', 'ema50-touch', 'EUR/USD', '30M',
         to_timestamp(1700000000), to_timestamp(1700000060), 'candle',
         1.1, 1.1, 0.001, 2, 0.5, 'above', 'bounce', 'up', 'long', false,
         '{"score":4}'::jsonb, 4, 'LONG', 1.1, 1.099, 1.102, 10, 'tp', 20
       )`,
    );

    // 3. The change.
    const ran = await migrate(
      [
        { name: '0001_signals.sql', text: read('0001_signals.sql') },
        { name: '0002_ichimoku.sql', text: read('0002_ichimoku.sql') },
      ],
      env,
    );
    expect(ran, 'only the new migration should apply').toEqual(['0002_ichimoku.sql']);

    // The observation survived: a ticket and a result are still a ticket and
    // a result whatever indicator produced them.
    const [old] = await pool.query(`select * from signals where strategy = 'ema50-touch'`).then((r) => r.rows);
    expect(old).toBeTruthy();
    expect(old.direction).toBe('LONG');
    expect(Number(old.entry)).toBe(1.1);
    expect(Number(old.result_pips)).toBe(20);
    expect(old.result).toBe('tp');

    // The indicator columns it no longer has.
    for (const gone of ['price', 'ema', 'atr', 'tolerance_pips', 'approach', 'outcome', 'trend', 'bias', 'counter_trend', 'ichimoku', 'ichimoku_score']) {
      expect(Object.hasOwn(old, gone), `${gone} should have been dropped`).toBe(false);
    }
    // The Ichimoku columns it has but cannot fill. Null, not zero: a zero
    // Kijun would be read as a price.
    for (const added of ['kumo', 'kijun', 'tenkan', 'senkou_a', 'senkou_b', 'range_pips', 'score', 'cloud_bullish', 'future_cloud_bullish', 'chikou_free', 'tenkan_agrees']) {
      expect(Object.hasOwn(old, added), `${added} should have been added`).toBe(true);
      expect(old[added], `${added} should be null on a legacy row`).toBeNull();
    }

    // And the upgraded table takes a new-shape row through the real writer.
    expect(
      await recordSignals(
        [
          {
            id: 'ichimoku-kijun|EUR/USD|30M|2000',
            strategy: 'ichimoku-kijun',
            symbol: 'EUR/USD',
            timeframe: '30M',
            bar_time: 1_700_003_600,
            detected_at: 1_700_003_660,
            source: 'candle',
            kumo: 'above',
            kijun: 1.0998,
            tenkan: 1.1005,
            senkou_a: 1.097,
            senkou_b: 1.096,
            distance_pips: 2,
            range_pips: 75,
            score: 4,
            cloud_bullish: true,
            future_cloud_bullish: true,
            chikou_free: true,
            tenkan_agrees: true,
            direction: 'LONG',
            entry: 1.1,
            stop_loss: 1.099,
            take_profit: 1.102,
            stop_pips: 10,
            result: 'open',
          },
        ],
        env,
      ),
    ).toBe(1);

    // The reads show the new strategy only, with both rows still on disk.
    expect((await recentSignals({}, env)).map((r) => r.strategy)).toEqual(['ichimoku-kijun']);
    expect(Number((await pool.query('select count(*) from signals')).rows[0].count)).toBe(2);
  });
});
