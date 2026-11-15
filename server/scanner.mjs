/**
 * Server-side scanner: the thing that makes the signal history exist.
 *
 *   trigger (GitHub Actions, every 15 min)
 *        │  POST /api/scan   Authorization: Bearer SCANNER_TOKEN
 *        ▼
 *   runScan()
 *        │
 *        ├── per pair ─▶ Yahoo candles ─▶ analyseEma50Touch()   (the bundle:
 *        │                                                       the browser's
 *        │                                                       own code)
 *        │                     │
 *        │                     ├─▶ recent closed bars ─▶ ticket ─▶ fill rule
 *        │                     │        └─▶ insert (on conflict do nothing)
 *        │                     │
 *        │                     └─▶ bars after an OPEN trade ─▶ resolveBar()
 *        │                              └─▶ close it, in pips
 *        ▼
 *   Neon
 *
 * WHY A SERVER SCANNER AT ALL
 * ───────────────────────────
 * The strategy runs in the browser, which means it only runs while a tab is
 * open. A history assembled that way records when somebody was looking at the
 * site, not what the market did — and this project has already thrown away a
 * table of 421 such rows for exactly that reason. The scanner closes that gap:
 * it runs whether or not anyone is watching.
 *
 * WHY NOT A VERCEL CRON
 * ─────────────────────
 * Hobby plans allow one cron firing a day, accurate to the hour. A 30-minute
 * strategy needs better than that, so the trigger is a GitHub Actions
 * schedule (see .github/workflows/scan.yml) which this route simply answers.
 * Nothing here depends on the trigger being punctual — see the lookback below.
 *
 * THE THREE RULES IT SHARES WITH THE BACKTEST
 * ───────────────────────────────────────────
 * These are not re-implemented here. They are imported, so there is one
 * answer and not two:
 *
 *   1. ENTRY MUST BE A PRICE THAT TRADED. A resting limit at the EMA fills
 *      only if the touch bar's range covered it. The band is wider than the
 *      line, so many touches never reach it. Those are recorded as 'nofill',
 *      not as trades. Counting them was worth about a fifth of the stop per
 *      trade of fiction when the backtest did it.
 *   2. THE ENTRY BAR CAN STOP YOU OUT, but cannot take profit — OHLC cannot
 *      say whether the high came before or after the fill.
 *   3. SAME-BAR AMBIGUITY GOES TO THE STOP. `resolveBar` decides this, and it
 *      is the backtest's own function.
 *
 * WHY IT RE-READS BARS IT HAS ALREADY SEEN
 * ────────────────────────────────────────
 * `lookbackBars` makes every run cover the last few closed bars rather than
 * only the newest. Scheduled triggers are late, skipped and occasionally
 * bunched; a scanner that only ever looked at the newest bar would lose a
 * signal every time that happened. Re-reading is free because the signal id
 * is deterministic and the insert is ON CONFLICT DO NOTHING, so a bar seen
 * five times produces one row.
 */
import {
  PAIRS,
  STRATEGY_CONFIG,
  TIMEFRAME_SECONDS,
  analyseEma50Touch,
  parseYahooChart,
  pipSize,
  pipsOf,
  resolveBar,
  ticketLevels,
  yahooQuery,
} from './strategy.bundle.mjs';
import { YAHOO_REST_DEFAULT, YAHOO_UA } from './yahoo.mjs';
import { closeTrade, finishRun, openTrades, recordSignals, startRun } from './db.mjs';

/** Bars to fetch per pair. Enough for EMA50 + Ichimoku's 52-period span. */
const CANDLE_COUNT = 300;

export function scannerConfig(env = process.env) {
  return {
    timeframe: env.SCAN_TIMEFRAME || STRATEGY_CONFIG.scanTimeframe,
    /**
     * How many recently-closed bars each run considers. Four 30M bars is two
     * hours of slack, which covers a GitHub Actions schedule running late or
     * being skipped entirely for a cycle.
     */
    lookbackBars: Math.max(1, Number(env.SCAN_LOOKBACK_BARS ?? 4) || 4),
    yahooRest: (env.YAHOO_REST_URL || YAHOO_REST_DEFAULT).trim(),
    /** Pairs to scan. Defaults to the app's own list, so the two cannot drift. */
    symbols: (env.SCAN_SYMBOLS?.trim() ? env.SCAN_SYMBOLS.split(',').map((s) => s.trim()) : PAIRS.map((p) => p.symbol)),
  };
}

/**
 * Candles straight from Yahoo — no proxy hop.
 *
 * The browser goes through /api/yahoo-chart because a browser cannot set a
 * User-Agent and should not know upstream URLs. This runs on the server, so
 * it talks to Yahoo directly and parses the body with `parseYahooChart`,
 * which is the browser's own parser.
 */
async function fetchCandles(symbol, timeframe, base, signal) {
  const url = `${base}/v8/finance/chart/?${yahooQuery(symbol, timeframe, CANDLE_COUNT)}`;
  const res = await fetch(url, { headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${symbol}`);
  return parseYahooChart(await res.json(), symbol, timeframe, CANDLE_COUNT);
}

/**
 * Turn a detected touch into the row the database stores.
 *
 * Returns null when the touch produces no usable ticket — an ATR that yields
 * a zero stop distance, for instance. A signal with no ticket cannot be
 * measured, and a history of unmeasurable rows is a log, not a record.
 */
export function signalRow(signal, touchBar, detectedAt) {
  const levels = ticketLevels(signal);
  if (!levels) return null;

  const { direction, entry, stop, target } = levels;
  const stopPips = Math.abs(entry - stop) / pipSize(signal.symbol);

  // Rule 1: the limit at the EMA fills only if the bar traded there.
  const filled = touchBar.low <= entry && entry <= touchBar.high;

  // Rule 2: if it filled, the rest of that bar is live, and can only lose.
  const onEntryBar = filled ? resolveBar(touchBar, direction, stop, target) : null;
  const stoppedOnEntryBar = onEntryBar?.exit === 'sl';

  /**
   * A trade stopped on its own bar is CLOSED, so it has to be written with
   * its outcome, not just its verdict. Recording the 'sl' without the pips
   * left those losses out of every total — which makes the strategy look
   * better than it is, since the entry-bar stop is the fastest loss there is.
   * Caught by scanner.e2e.test.mjs.
   */
  const exit = stoppedOnEntryBar
    ? {
        exit_price: onEntryBar.price,
        exit_at: touchBar.time,
        bars_held: 0,
        // Raw pips, before spread, like every other result the scanner stores.
        result_pips: pipsOf(signal.symbol, direction, entry, stop, onEntryBar.price, 0),
      }
    : { exit_price: null, exit_at: null, bars_held: null, result_pips: null };

  return {
    id: signal.id,
    strategy: signal.strategy,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    bar_time: signal.barTime,
    detected_at: Math.floor(detectedAt / 1000),
    source: signal.source,

    price: signal.price,
    ema: signal.ema,
    atr: signal.atr,
    tolerance_pips: signal.tolerancePips,
    distance_pips: signal.distancePips,
    approach: signal.approach,
    outcome: signal.outcome,
    trend: signal.trend,
    bias: signal.bias,
    counter_trend: signal.counterTrend,
    ichimoku: signal.ichimoku ?? null,
    ichimoku_score: signal.ichimoku?.score ?? null,

    direction,
    entry,
    stop_loss: stop,
    take_profit: target,
    stop_pips: stopPips,

    result: !filled ? 'nofill' : stoppedOnEntryBar ? 'sl' : 'open',
    ...exit,
  };
}

/**
 * Walk the bars after an open trade's entry and see whether price decided.
 *
 * Pure: candles and the trade in, an outcome or null out. The entry bar is
 * skipped because `signalRow` already gave it its one chance to stop the
 * trade out, and crediting its high as a target would be rule 2 in reverse.
 */
export function resolveOpenTrade(trade, candles) {
  const barTime = Math.round(Number(trade.bar_time));
  const entryIndex = candles.findIndex((c) => c.time === barTime);

  if (entryIndex === -1) {
    /**
     * Its entry bar is no longer in the window.
     *
     * Each run fetches the newest CANDLE_COUNT bars, so a trade that has not
     * resolved within that many bars scrolls out of view and can never be
     * decided again. Left alone it would sit at 'open' for ever, quietly
     * inflating the open count with trades nobody is tracking.
     *
     * So it is retired as 'expired': price may well have decided it, but this
     * system no longer holds the candles that would say how. No pip figure is
     * recorded, because inventing one — or counting it as a scratch — would
     * put a number on an outcome that was never observed.
     *
     * Only when the bar is OLDER than the window. A bar newer than every
     * candle we hold means the provider returned less history than usual, not
     * that the trade is finished, so that case waits for the next run.
     */
    const oldest = candles[0]?.time;
    if (oldest !== undefined && barTime < oldest) {
      return { result: 'expired', exitPrice: null, exitAt: null, barsHeld: null, resultPips: null };
    }
    return null;
  }

  for (let i = entryIndex + 1; i < candles.length; i++) {
    const bar = candles[i];
    // A bar still forming can stop a trade out — the low really happened —
    // so it is NOT skipped. `complete` only matters for indicator warm-up.
    const { exit, price } = resolveBar(bar, trade.direction, Number(trade.stop_loss), Number(trade.take_profit));
    if (exit === null) continue;
    return {
      result: exit,
      exitPrice: price,
      exitAt: bar.time,
      barsHeld: i - entryIndex,
      // Raw pips, before spread. The backtest charges a spread because it is
      // asking "would this have been profitable"; the history is recording
      // what price did, and a broker's spread is not part of that.
      resultPips: pipsOf(trade.symbol, trade.direction, Number(trade.entry), Number(trade.stop_loss), price, 0),
    };
  }
  return null;
}

/** One pass: record what is new, resolve what is running. */
export async function runScan({ env = process.env, now = Date.now(), signal } = {}) {
  const cfg = scannerConfig(env);
  const barSeconds = TIMEFRAME_SECONDS[cfg.timeframe];
  const runId = await startRun(env);

  const errors = [];
  const perPair = {};
  let recorded = 0;
  let resolved = 0;
  let scanned = 0;

  // Fetch once per pair and use the same candles for both halves of the job.
  const open = await openTrades(env);
  const openBySymbol = new Map();
  for (const t of open) {
    if (!openBySymbol.has(t.symbol)) openBySymbol.set(t.symbol, []);
    openBySymbol.get(t.symbol).push(t);
  }

  // Every symbol that needs looking at: the ones we scan, plus any that still
  // holds an open trade even if it has since left the scan list.
  const symbols = [...new Set([...cfg.symbols, ...openBySymbol.keys()])];

  for (const symbol of symbols) {
    try {
      const candles = await fetchCandles(symbol, cfg.timeframe, cfg.yahooRest, signal);
      scanned++;

      // ── resolve what is already running ───────────────────────────────
      for (const trade of openBySymbol.get(symbol) ?? []) {
        const outcome = resolveOpenTrade(trade, candles);
        if (outcome && (await closeTrade({ id: trade.id, ...outcome }, env))) resolved++;
      }

      // ── record what is new ────────────────────────────────────────────
      if (!cfg.symbols.includes(symbol)) continue; // open trade only; not scanned

      const { signals, reason } = analyseEma50Touch(candles, symbol, cfg.timeframe);
      if (reason === 'not-enough-bars') {
        errors.push(`${symbol}: only ${candles.length} ${cfg.timeframe} candles`);
        continue;
      }

      const byTime = new Map(candles.map((c) => [c.time, c]));
      const newest = candles.at(-1);
      // Only bars that have CLOSED, and only recent ones. The detector reports
      // every touch in 300 bars of history; writing all of them would backfill
      // the table with history the fixtures already cover.
      const oldest = (newest?.time ?? 0) - cfg.lookbackBars * barSeconds;

      const rows = [];
      for (const s of signals) {
        if (s.barTime < oldest) continue;
        if (s.barTime >= (newest?.time ?? 0)) continue; // still forming
        const bar = byTime.get(s.barTime);
        if (!bar) continue;
        const row = signalRow(s, bar, now);
        if (row) rows.push(row);
      }

      const added = await recordSignals(rows, env);
      recorded += added;
      perPair[symbol] = { candles: candles.length, considered: rows.length, recorded: added };
    } catch (err) {
      errors.push(`${symbol}: ${err?.message || String(err)}`);
    }
  }

  const summary = {
    ok: errors.length < symbols.length,
    timeframe: cfg.timeframe,
    scanned,
    recorded,
    resolved,
    errors,
    detail: perPair,
  };
  await finishRun(runId, summary, env);
  return summary;
}
