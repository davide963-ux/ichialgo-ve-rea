/**
 * Server-side scanner: the thing that makes the signal history exist.
 *
 *   trigger (GitHub Actions, on a schedule)
 *        │  POST /api/scan   Authorization: Bearer SCANNER_TOKEN
 *        ▼
 *   runScan()
 *        │
 *        ├── per pair ─▶ Yahoo candles ─▶ analyseIchimoku()     (the bundle:
 *        │                                                       the browser's
 *        │                                                       own code)
 *        │                     │
 *        │                     ├─▶ recent closed bars ─▶ ticket
 *        │                     │        └─▶ insert (on conflict do nothing)
 *        │                     │
 *        │                     └─▶ bars after an OPEN trade ─▶ stepExit()
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
 * THE RULES IT SHARES WITH THE BACKTEST
 * ─────────────────────────────────────
 * These are not re-implemented here. They are imported, so there is one
 * answer and not two:
 *
 *   1. ENTRY IS THE SIGNAL BAR'S CLOSE — a price that traded by definition,
 *      so there is no fill rule and no 'nofill' outcome. The previous
 *      strategy rested a limit at the EMA and had to decide whether each bar
 *      had reached it; a third had not, and filling them anyway was worth
 *      about a fifth of the stop per trade of fiction.
 *   2. THE TRADE IS LIVE FROM THE NEXT BAR. The fill is at the signal bar's
 *      close, so nothing in that bar can decide the trade in either
 *      direction.
 *   3. SAME-BAR AMBIGUITY GOES TO THE STOP. `stepExit` decides this, and it
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
  analyseIchimoku,
  minBars,
  PAIRS,
  STRATEGY_CONFIG,
  TIMEFRAME_SECONDS,
  parseTdSeries,
  parseYahooChart,
  openExit,
  pipSize,
  pipsOf,
  stepExit,
  tdSeriesQuery,
  ticketLevels,
  yahooQuery,
} from './strategy.bundle.mjs';
import { YAHOO_REST_DEFAULT, YAHOO_UA } from './yahoo.mjs';
import { readConfig } from './api.mjs';
import { closeTrade, finishRun, openTrades, recordSignals, startRun } from './db.mjs';

/**
 * Bars to fetch per pair.
 *
 * Ichimoku needs 78 before it reports anything — Senkou B's 52 plus the
 * 26-bar displacement, so a cloud is actually in effect at the bar being
 * judged — which leaves 300 with more than two hundred bars of signals
 * inside every window, far more than `lookbackBars` ever reconsiders.
 */
const CANDLE_COUNT = 300;

export function scannerConfig(env = process.env) {
  return {
    timeframe: env.SCAN_TIMEFRAME || STRATEGY_CONFIG.scanTimeframe,
    /**
     * How many recently-closed bars each run reconsiders.
     *
     * SIZED FROM WHAT GITHUB ACTUALLY DELIVERS, NOT FROM THE CRON
     * ──────────────────────────────────────────────────────────
     * The workflow asks for a run every 15 minutes. Measured over the first
     * 81 hours of real scheduling, GitHub delivered 12 — one every 7.4 hours
     * on average, the widest gap 9.4 hours. Scheduled workflows are queued at
     * low priority and dropped under load, and a once-every-15-minutes
     * schedule on a public repository is throttled hard.
     *
     * The first version used four bars: two hours on 30M. Against 8-hour
     * gaps that meant most closed bars were never looked at, so the history
     * would have had holes through it even once the provider was fixed.
     *
     * 48 bars is 24 hours on 30M — comfortably past the worst observed gap,
     * with room for GitHub getting worse. It costs NOTHING extra: the same
     * 300 candles are already fetched (150 hours on 30M, so the window is
     * well inside them), and the signal id is deterministic with ON CONFLICT
     * DO NOTHING, so re-reading a bar writes nothing the second time.
     *
     * The limit is the candle window, not this number: a bar older than the
     * 300 fetched cannot be recovered whatever the lookback says.
     */
    lookbackBars: Math.max(1, Number(env.SCAN_LOOKBACK_BARS ?? 48) || 48),
    yahooRest: (env.YAHOO_REST_URL || YAHOO_REST_DEFAULT).trim(),
    /** Twelve Data: the fallback when Yahoo refuses. Keys come from the same
     *  pooled configuration the proxy uses, so there is one place to add one. */
    td: readConfig(env).twelvedata,
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
async function fetchFromYahoo(symbol, timeframe, base, signal) {
  const url = `${base}/v8/finance/chart/?${yahooQuery(symbol, timeframe, CANDLE_COUNT)}`;
  const res = await fetch(url, { headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${symbol}`);
  return parseYahooChart(await res.json(), symbol, timeframe, CANDLE_COUNT);
}

/**
 * Candles from Twelve Data, trying each pooled key in turn.
 *
 * Failover is deliberately simple compared with the proxy's credit meter: a
 * scan asks for at most one series per pair, a few times an hour, so the
 * budget is never the binding constraint. What matters is that one exhausted
 * or revoked key does not take the whole scan down, hence the loop.
 *
 * Twelve Data reports failures inside the body with HTTP 200, so
 * `parseTdSeries` throws on those too — a 429 on key #1 must move to key #2,
 * not be read as "no candles".
 */
async function fetchFromTwelveData(symbol, timeframe, td, signal) {
  if (td.keys.length === 0) throw new Error('no Twelve Data API key configured');
  const qs = tdSeriesQuery(symbol, timeframe, CANDLE_COUNT);
  let last;
  for (const key of td.keys) {
    try {
      const res = await fetch(`${td.rest}/time_series?${qs}&apikey=${encodeURIComponent(key)}`, {
        headers: { Accept: 'application/json' },
        signal,
      });
      if (!res.ok) throw new Error(`Twelve Data ${res.status}`);
      return parseTdSeries(await res.json(), symbol);
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`Twelve Data: ${last?.message || last}`);
}

/**
 * Yahoo first, Twelve Data when Yahoo refuses.
 *
 * WHY THE FALLBACK IS NOT OPTIONAL
 * ────────────────────────────────
 * Yahoo's chart endpoint is unofficial and rate-limits datacentre IP ranges.
 * From a browser on a home connection it is fine, which is why the app uses
 * it and why it costs no credits. From a serverless function it answers 429 —
 * every pair, every run. This scanner ran for four days returning
 * "Yahoo 429" seven times a scan and recording nothing at all.
 *
 * So Yahoo stays FIRST, because when it works it is free, and Twelve Data
 * catches what it refuses. The browser already works this way
 * (YahooCandleRouter); this is the same arrangement on the server.
 *
 * `state.yahooParked` makes that one decision per RUN rather than per pair.
 * Once Yahoo has refused, the other six pairs will be refused too — asking
 * anyway would spend six round trips to be told so, and leaning harder on an
 * endpoint that is already rate-limiting is how a soft limit becomes a hard
 * one.
 */
async function fetchCandles(symbol, timeframe, cfg, state, signal) {
  if (!state.yahooParked) {
    try {
      return await fetchFromYahoo(symbol, timeframe, cfg.yahooRest, signal);
    } catch (err) {
      state.yahooParked = String(err?.message || err);
    }
  }
  try {
    return await fetchFromTwelveData(symbol, timeframe, cfg.td, signal);
  } catch (err) {
    // Name both, or a run that failed everywhere looks like a Twelve Data
    // problem when Yahoo was the first thing to go.
    throw new Error(`${err?.message || err} (after ${state.yahooParked ?? 'Yahoo not tried'})`);
  }
}

/**
 * Turn a detected signal into the row the database stores.
 *
 * Returns null when the signal produces no usable ticket — levels that round
 * to a zero stop distance on a 2-digit pair, for instance. A signal with no
 * ticket cannot be measured, and a history of unmeasurable rows is a log, not
 * a record.
 *
 * Every row starts at 'open'. Under the previous strategy this function also
 * had to decide whether the entry filled and whether the entry bar stopped
 * the trade out on the spot; both questions are gone with the resting limit.
 * The fill is the bar's close, so the bar is over, and the first candle that
 * can decide anything is the next one — which `resolveOpenTrade` handles on
 * this run or a later one.
 */
export function signalRow(signal, detectedAt) {
  const levels = ticketLevels(signal);
  if (!levels) return null;

  const { direction, entry, stop, target } = levels;

  return {
    id: signal.id,
    strategy: signal.strategy,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    bar_time: signal.barTime,
    detected_at: Math.floor(detectedAt / 1000),
    source: signal.source,

    // The lines as they stood on the signal bar, and the range the stop came
    // from. Stored rather than recomputed: a later candle window would give
    // different numbers and answer a different question.
    kumo: signal.kumo,
    kijun: signal.kijun,
    tenkan: signal.tenkan,
    senkou_a: signal.senkouA,
    senkou_b: signal.senkouB,
    senkou_ahead_a: signal.senkouAheadA,
    senkou_ahead_b: signal.senkouAheadB,
    distance_pips: signal.distancePips,
    range_pips: signal.rangePips,
    cloud_pips: signal.cloudPips,

    /**
     * The conditions as the detector stated them, not as named columns. A
     * breakout and a pullback do not require the same conditions, or the same
     * NUMBER of them, so a fixed set of boolean columns cannot hold both —
     * see db/migrations/0003_strategies.sql.
     */
    entry_type: signal.entryType,
    score: signal.score,
    checks_total: signal.checksTotal,
    checks: signal.checks,

    direction,
    entry,
    stop_loss: stop,
    take_profit: target,
    stop_pips: Math.abs(entry - stop) / pipSize(signal.symbol),
    break_even: levels.breakEven,

    result: 'open',
    exit_price: null,
    exit_at: null,
    bars_held: null,
    result_pips: null,
  };
}

/**
 * Walk the bars after an open trade's entry and see whether price decided.
 *
 * Pure: candles and the trade in, an outcome or null out. The entry bar is
 * skipped because the fill happened at its close: everything that bar did is
 * already in the past when the position opens, so crediting its high or
 * debiting its low would be resolving a trade against bars it never held.
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

  /**
   * The break-even move is replayed from the entry bar on every run, not
   * remembered between them. It is a pure function of the stored ticket and
   * the candles, so replaying gives the same answer every time — and it
   * avoids a column whose only job would be to disagree with the candles.
   */
  const rules = {
    direction: trade.direction,
    entry: Number(trade.entry),
    stop: Number(trade.stop_loss),
    target: Number(trade.take_profit),
    breakEvenAt: trade.break_even === null || trade.break_even === undefined ? null : Number(trade.break_even),
  };
  let state = openExit(rules);

  for (let i = entryIndex + 1; i < candles.length; i++) {
    const bar = candles[i];
    // A bar still forming can stop a trade out — the low really happened —
    // so it is NOT skipped. `complete` only matters for indicator warm-up.
    const stepped = stepExit(bar, rules, state);
    state = stepped.state;
    const { exit, price } = stepped;
    if (exit === null) continue;
    return {
      result: exit,
      exitPrice: price,
      exitAt: bar.time,
      barsHeld: i - entryIndex,
      // Raw pips, before spread. The backtest charges a spread because it is
      // asking "would this have been profitable"; the history is recording
      // what price did, and a broker's spread is not part of that.
      resultPips: pipsOf(trade.symbol, trade.direction, Number(trade.entry), rules.stop, price, 0),
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
  /**
   * Signals dropped because the database still held an open trade for that
   * pair. Expected to stay at zero: the detector already refuses to produce
   * one. A non-zero value means the detector's view and the stored history
   * have come apart, which is worth seeing in the run log.
   */
  let blockedByOpen = 0;
  /** Trades this run closed, so they no longer block anything. */
  const closedThisRun = new Set();
  /** Per-run provider state: see fetchCandles for why Yahoo is parked once. */
  const providerState = { yahooParked: null };

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
      const candles = await fetchCandles(symbol, cfg.timeframe, cfg, providerState, signal);
      scanned++;

      // ── resolve what is already running ───────────────────────────────
      for (const trade of openBySymbol.get(symbol) ?? []) {
        const outcome = resolveOpenTrade(trade, candles);
        if (outcome && (await closeTrade({ id: trade.id, ...outcome }, env))) {
          resolved++;
          closedThisRun.add(trade.id);
        }
      }

      // ── record what is new ────────────────────────────────────────────
      if (!cfg.symbols.includes(symbol)) continue; // open trade only; not scanned

      const newest = candles.at(-1);
      // Only bars that have CLOSED, and only recent ones. A detector reports
      // every signal in 300 bars of history; writing all of them would
      // backfill the table with history the fixtures already cover.
      const oldest = (newest?.time ?? 0) - cfg.lookbackBars * barSeconds;

      /**
       * ONE system, both entries, on the SAME candles every run.
       *
       * This used to loop over three selectable strategies, which was a
       * misreading: OANDA's article presents its approaches as parts of one
       * method that work together, not as rivals to be scored against each
       * other. The detector now returns breakouts and pullbacks from a single
       * pass, so there is nothing here to choose between.
       */
      const rows = [];
      const { signals, reason } = analyseIchimoku(candles, symbol, cfg.timeframe, undefined, now);
      if (reason === 'not-enough-bars') {
        errors.push(`${symbol}: only ${candles.length} ${cfg.timeframe} candles, needs ${minBars()}`);
      } else {
        /**
         * ONE TRADE PER PAIR IS THE DETECTOR'S JOB, NOT THIS LOOP'S.
         *
         * It used to be nobody's. The scanner wrote every signal in its
         * lookback window as a separate open trade, so a busy pair could
         * hold eight at once in the stored history while the backtest — which
         * did enforce one at a time — reported one. Two systems, two answers,
         * no way to tell which was the strategy.
         *
         * `analyseIchimoku` now goes quiet from a signal until its stop or
         * target, so what arrives here is already non-overlapping.
         */
        for (const s of signals) {
          if (s.barTime < oldest) continue;
          if (s.barTime >= (newest?.time ?? 0)) continue; // still forming
          const row = signalRow(s, now);
          if (row) rows.push(row);
        }
      }

      /**
       * The storage-level check on that claim.
       *
       * The detector simulates positions over the candles IT was given. The
       * database remembers trades from previous runs, and the two could in
       * principle disagree — a trade whose entry bar has scrolled out of the
       * window, a row written under an older build. Rather than trust the
       * agreement, a signal that would open a second position on a pair is
       * dropped and COUNTED, so a divergence shows up in the run log instead
       * of quietly becoming two open trades.
       */
      const stillOpen = (openBySymbol.get(symbol) ?? []).filter((t) => !closedThisRun.has(t.id));
      const blocked = [];
      const admitted = [];
      for (const row of rows) {
        if (stillOpen.some((t) => Number(t.bar_time) < row.bar_time)) blocked.push(row);
        else admitted.push(row);
      }
      if (blocked.length > 0) blockedByOpen += blocked.length;

      const added = await recordSignals(admitted, env);
      recorded += added;
      perPair[symbol] = {
        candles: candles.length,
        considered: rows.length,
        recorded: added,
        ...(blocked.length > 0 ? { blockedByOpen: blocked.length } : {}),
      };
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
    blockedByOpen,
    errors,
    // Which provider actually served the run, so a silent switch to the
    // metered one is visible in the run log rather than only in the bill.
    provider: providerState.yahooParked ? 'twelvedata' : 'yahoo',
    yahooParked: providerState.yahooParked,
    detail: perPair,
  };
  await finishRun(runId, summary, env);
  return summary;
}
