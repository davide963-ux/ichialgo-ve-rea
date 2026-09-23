/**
 * The 24/7 scanner.
 *
 * Runs on a schedule, in the server, whether or not anybody has the site open.
 * That is the whole point: the previous design ran the strategy in the browser,
 * so the signal history recorded when someone happened to be looking rather
 * than what the market did.
 *
 *   cron ──▶ /api/scanner ──▶ runScan()
 *                               │
 *                               ├─ 1. MANAGE OPEN TRADES   (always, even at night)
 *                               │     price per pair → TP / SL / expiry
 *                               │
 *                               ├─ 2. GATE                 (session? weekend?)
 *                               │
 *                               └─ 3. LOOK FOR SETUPS      (skips frozen pairs)
 *                                     candles → analyse → tracker
 *                                     → only TRANSITIONS are recorded
 *
 * ORDER MATTERS. Trade management runs first and unconditionally: a stop must
 * be honoured at 3am even though no new signal would be taken then. Only the
 * search for NEW setups is gated by session hours.
 *
 * CREDIT DISCIPLINE
 * ─────────────────
 * Twelve Data charges per request, and the budget is per key per day. Four
 * things cut the bill before a single request is made, in descending order of
 * effect:
 *
 *   1. a pair with an OPEN trade is skipped entirely — no candles fetched
 *   2. a pair that just closed one is skipped for `cooldownHours`
 *   3. nothing is scanned outside the configured session window or at weekends
 *   4. candles for one (pair, timeframe) are fetched once per run and reused
 *
 * The first is the big one, and it is a strategy rule that happens to be a
 * budget rule: one position per pair at a time.
 *
 * Every dependency is injected. The scan itself makes no assumption about
 * where candles come from or what the clock says, which is what lets the
 * tests drive it through a whole trade lifecycle without a network or a wait.
 */
import { analyse, SetupTracker, isActionable, isOpportunity, setupKey, TIER_LABEL } from '../src/services/strategy';
import type { AnalyseOptions, Direction, StrategyAnalysis } from '../src/services/strategy';
import type { Candle } from '../src/services/marketData/types';
import { toSignalRow, type Outcome, type PendingSignal, type SignalRow, type SignalsDb } from './signalsDb';

/**
 * Stamped on every recorded signal, and part of each row's deterministic id.
 *
 * Change it when the RULES change, not when they are merely tuned: rows keep
 * their old id, so two strategies writing under one name become impossible to
 * tell apart afterwards, and a backtest of the new rules cannot be compared
 * against history produced by the old ones.
 */
export const STRATEGY_ID = 'mtf-confluence-v1';

export interface ScannerConfig {
  symbols: readonly string[];
  /**
   * Where setups are FOUND. The strategy's main working timeframe.
   *
   * The three timeframes do different jobs and are deliberately not required
   * to agree: `biasTimeframe` supplies directional context, these are scanned
   * for the setup itself, and `entryTimeframe` times the entry. Demanding all
   * three look identical is the over-filtering the strategy spec rules out.
   */
  timeframes: readonly string[];
  /** Directional context. Endorses or objects; never vetoes. Null disables it. */
  biasTimeframe: string | null;
  /**
   * Entry timing and confirmation.
   *
   * Costs one extra credit per pair, and buys the difference between "this
   * level is holding" and "this level has held" — which on a 1H setup is
   * typically several pips of entry and a tighter stop. Null disables it.
   */
  entryTimeframe: string | null;
  /** UTC hours [from, to) in which NEW setups may be found. */
  sessionHours: [number, number];
  /** Skip a pair for this long after one of its trades closes. */
  cooldownHours: number;
  /** Open trades older than this are closed as 'expired'. */
  expiryDays: number;
  /** Candles requested per series. */
  outputSize: number;
  /** Refuse to run again within this window. */
  minIntervalMs: number;
  /**
   * Hard ceiling on Twelve Data credits one run may spend.
   *
   * The per-MINUTE limit is what bites: 8 per key, and a full pass over 7
   * pairs on two timeframes plus a daily bias wants ~21. With one key that
   * pass cannot complete, and without a cap the run simply fails on whichever
   * pairs come last — the same pairs every time, so they would never be
   * scanned at all. The cap plus the round-robin cursor turns that into
   * "cover everything over several runs" instead of "never see the tail".
   */
  maxCreditsPerRun: number;
}

export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  symbols: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD', 'NZD/USD'],
  // 4H context, 1H setup, 15M entry — the split the strategy spec asks for.
  timeframes: ['1H'],
  biasTimeframe: '4H',
  entryTimeframe: '15min',
  // London open to New York close. Outside it, spreads widen and the moves
  // this strategy looks for do not develop.
  sessionHours: [7, 21],
  cooldownHours: 10,
  expiryDays: 10,
  outputSize: 300,
  minIntervalMs: 14 * 60_000,
  // Two keys' worth of a minute window, leaving room for the price checks that
  // step 1 already spent. Raise it if you add keys.
  maxCreditsPerRun: 16,
};

export interface MarketFeed {
  /** Closed candles, oldest first. `complete` on the last one drives gating. */
  candles(symbol: string, timeframe: string, outputSize: number): Promise<Candle[]>;
  price(symbol: string): Promise<number>;
  /** Credits spent so far — read for the run log. */
  creditsUsed(): number;
}

export interface ScanResult {
  ok: boolean;
  skipped?: string;
  scanned: number;
  emitted: number;
  closed: number;
  creditsUsed: number;
  frozen: string[];
  sessionActive: boolean;
  /** Where the next run starts, so the tail of the list is not starved. */
  nextOffset: number;
  /** True when the credit cap stopped the run before every pair was seen. */
  budgetExhausted: boolean;
  errors: string[];
  signals: { id: string; symbol: string; timeframe: string; signal: string; confidence: number }[];
  closures: { id: string; outcome: Outcome; price: number }[];
  /**
   * Every pair worth looking at this run, best first.
   *
   * Distinct from `signals`, and deliberately so. `signals` is what was
   * RECORDED as a trade — actionable tiers only, deduplicated by the tracker,
   * one per pair. This is what was SEEN: every tier above NEUTRAL including
   * EARLY and WATCHLIST, ranked by confidence, whether or not a position was
   * taken.
   *
   * A scanner that only reports what it traded cannot answer "what is
   * developing right now?", which is most of what a scanner is for.
   */
  opportunities: Opportunity[];
}

export interface Opportunity {
  symbol: string;
  timeframe: string;
  /** Tier as the spec words it: STRONG BUY, BUY, EARLY BUY, WATCHLIST… */
  tier: string;
  signal: string;
  confidence: number;
  direction: string;
  marketCondition: string;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Reward-to-risk of the first target, when there is a ticket. */
  rewardRisk: number | null;
  /** One sentence naming the conditions that produced the reading. */
  explanation: string;
}

export interface RunScanOptions {
  db: SignalsDb;
  feed: MarketFeed;
  config?: ScannerConfig;
  now?: () => number;
  /** Skip the minimum-interval guard. Used by the tests and by ?force=1. */
  force?: boolean;
  /**
   * The strategy. Defaults to the one installed at `services/strategy`.
   *
   * Injectable because the scanner's own behaviour — freezing a pair on a
   * signal, not re-emitting the same setup, releasing a pair when its trade
   * closes, surviving a cold start — is plumbing that must hold for ANY
   * strategy. Testing it through whichever strategy happens to be installed
   * makes those tests fail the moment the rules change, which says nothing
   * about the plumbing and is exactly what happened the first time.
   */
  analyse?: Analyse;
}

/** The one function a strategy has to provide. */
export type Analyse = (candles: readonly Candle[], options: AnalyseOptions) => StrategyAnalysis;

/**
 * Is the market open for NEW signals?
 *
 * Weekend is checked as well as the hour. The reference implementation checked
 * only the hour, so a Saturday run spent credits analysing Friday's closing
 * print as though it were live — and could emit a signal on it.
 */
export function isSessionActive(ms: number, [from, to]: [number, number]): boolean {
  const d = new Date(ms);
  const day = d.getUTCDay();
  if (day === 6) return false; // Saturday
  if (day === 0) return false; // Sunday — Sydney opens late, not worth the credits
  // Friday after the session window is the weekend for our purposes.
  const hour = d.getUTCHours();
  return hour >= from && hour < to;
}

/**
 * Which outcome, if any, this price produces for an open trade.
 *
 * The stop is tested first. With well-formed levels a single price cannot
 * satisfy both the stop and a target, so the ordering only matters for a
 * corrupted ticket — where resolving as a loss beats booking a phantom win.
 *
 * KNOWN LIMITATION: this reads the CURRENT price, so a move that spiked
 * through a level and came back between two runs is invisible. The trade is
 * recorded as still open when a real position would have been stopped out, so
 * results here are optimistic by however much the market whipsawed. Checking
 * candle highs and lows since the last run would fix it, at the cost of a
 * candle request per open trade per run; worth doing once the win rate is
 * being taken seriously enough for the difference to matter.
 */
export function resolveOutcome(
  signal: PendingSignal,
  price: number,
): { outcome: Outcome | null } {
  const { direction, entry, stop_loss: stop, take_profit: target } = signal;
  if (entry === null || stop === null) return { outcome: null };

  const long = direction === 'long';
  const hitStop = long ? price <= stop : price >= stop;

  // The stop wins a tie, for the same reason it does in the backtest: a poll
  // that sees both levels crossed cannot order them, and reading it the other
  // way invents wins.
  if (hitStop) return { outcome: 'sl' };

  if (target !== null && (long ? price >= target : price <= target)) return { outcome: 'tp' };

  return { outcome: null };
}

export async function runScan(options: RunScanOptions): Promise<ScanResult> {
  const config = options.config ?? DEFAULT_SCANNER_CONFIG;
  const now = options.now ?? (() => Date.now());
  const { db, feed } = options;
  const analyseWith = options.analyse ?? analyse;

  const result: ScanResult = {
    ok: true,
    scanned: 0,
    emitted: 0,
    closed: 0,
    creditsUsed: 0,
    frozen: [],
    sessionActive: false,
    nextOffset: 0,
    budgetExhausted: false,
    errors: [],
    signals: [],
    closures: [],
    opportunities: [],
  };

  // ── Guard: refuse to run twice in quick succession ──────────────────────
  // Held in the database, not in module scope: on serverless a module-level
  // timestamp is per-instance and dies on cold start, so it guards nothing
  // once two instances are warm.
  if (!options.force) {
    const last = await db.lastRunStartedAt().catch(() => null);
    if (last !== null && now() - last < config.minIntervalMs) {
      const waitSec = Math.ceil((config.minIntervalMs - (now() - last)) / 1000);
      return { ...result, ok: true, skipped: `Ran ${Math.round((now() - last) / 1000)}s ago; next allowed in ${waitSec}s.` };
    }
  }

  const runId = await db.startRun().catch(() => null);

  // ═══ STEP 1 — manage open trades. Runs always, session or not. ═══════════
  const pending = await db.loadPending().catch((err: unknown) => {
    result.errors.push(`loadPending: ${(err as Error).message}`);
    return [] as PendingSignal[];
  });

  const frozen = new Set<string>();
  const byPair = new Map<string, PendingSignal[]>();
  /** (symbol|timeframe) of trades still open after this run's checks. */
  const stillOpen = new Set<string>();
  for (const p of pending) {
    frozen.add(p.symbol);
    stillOpen.add(setupKey(p.symbol, p.timeframe));
    const list = byPair.get(p.symbol) ?? [];
    list.push(p);
    byPair.set(p.symbol, list);
  }

  for (const [symbol, signals] of byPair) {
    let price: number;
    try {
      price = await feed.price(symbol);
    } catch (err) {
      result.errors.push(`price ${symbol}: ${(err as Error).message}`);
      continue;
    }

    for (const signal of signals) {
      const { outcome } = resolveOutcome(signal, price);
      try {
        if (outcome !== null) {
          const affected = await db.closeSignal(signal.id, outcome, price);
          if (affected > 0) {
            result.closed++;
            result.closures.push({ id: signal.id, outcome, price });
            frozen.delete(symbol);
            stillOpen.delete(setupKey(signal.symbol, signal.timeframe));
          }
        }
      } catch (err) {
        result.errors.push(`resolve ${signal.id}: ${(err as Error).message}`);
      }
    }
  }

  // Trades that never resolved. Left open they would freeze their pair forever.
  try {
    const expired = await db.expireStale(config.expiryDays);
    result.closed += expired;
  } catch (err) {
    result.errors.push(`expireStale: ${(err as Error).message}`);
  }

  // ═══ STEP 2 — gate the search for new setups ════════════════════════════
  result.sessionActive = isSessionActive(now(), config.sessionHours);
  result.frozen = [...frozen];
  result.creditsUsed = feed.creditsUsed();

  if (!result.sessionActive) {
    await db.finishRun(runId, { ...summaryOf(result), detail: { reason: 'outside-session' } }).catch(() => {});
    return result;
  }

  // ═══ STEP 3 — look for setups ═══════════════════════════════════════════
  const tracker = new SetupTracker({ now });
  try {
    tracker.load(await db.loadSetupState());
  } catch (err) {
    result.errors.push(`loadSetupState: ${(err as Error).message}`);
  }

  // Reconcile the tracker with reality before scanning.
  //
  // An ACTIVE setup suppresses every future signal for its pair — that is the
  // point, one position at a time. But nothing releases it when the trade
  // closes, so without this a pair goes PERMANENTLY SILENT after its first
  // trade. Comparing against the open trades handles closures from this run
  // and any that happened out of band (a manual close, a row edited by hand).
  for (const setup of tracker.snapshot()) {
    if (setup.status === 'ACTIVE' && !stillOpen.has(setup.key)) {
      tracker.complete(setup.symbol, setup.timeframe);
    }
  }

  const rows: SignalRow[] = [];

  // Round-robin start, so a run cut short by the credit cap resumes where the
  // last one stopped rather than always covering the same head of the list.
  const startOffset = await db.lastCursor().catch(() => 0);
  const order = config.symbols.map((_, k) => config.symbols[(startOffset + k) % config.symbols.length]!);

  // Step 1's price checks already cost credits; the cap covers the whole run.
  const budgetLeft = () => config.maxCreditsPerRun - feed.creditsUsed();
  let scannedCount = 0;

  for (const symbol of order) {
    if (frozen.has(symbol)) {
      scannedCount++;
      continue;
    }

    // Stop BEFORE spending rather than after: a pair half-analysed is worse
    // than one left for the next run, because its bias would be fetched and
    // then thrown away.
    const needed = (config.biasTimeframe ? 1 : 0) + 1;
    if (budgetLeft() < needed) {
      result.budgetExhausted = true;
      break;
    }

    // Higher-timeframe bias, computed once per pair and applied to every
    // timeframe below it. A setup the daily contradicts is not a high-
    // confidence trade however good it looks on the 1H.
    let bias: Direction | null = null;
    if (config.biasTimeframe) {
      try {
        const biasCandles = await feed.candles(symbol, config.biasTimeframe, config.outputSize);
        const biasAnalysis = analyseWith(biasCandles, {
          symbol,
          timeframe: config.biasTimeframe,
          lastBarClosed: lastBarClosed(biasCandles),
        });
        bias = biasAnalysis.direction;
      } catch (err) {
        result.errors.push(`bias ${symbol}: ${(err as Error).message}`);
      }
    }

    // Entry-timeframe confirmation, fetched once per pair like the bias.
    // A failure here is NOT fatal: it costs the confirmation bonus and the
    // setup is scored without it, rather than the pair being skipped.
    let entryBias: Direction | null = null;
    if (config.entryTimeframe) {
      try {
        const entryCandles = await feed.candles(symbol, config.entryTimeframe, config.outputSize);
        entryBias = analyseWith(entryCandles, {
          symbol,
          timeframe: config.entryTimeframe,
          lastBarClosed: lastBarClosed(entryCandles),
        }).direction;
      } catch (err) {
        result.errors.push(`entry ${symbol}: ${(err as Error).message}`);
      }
    }

    for (const timeframe of config.timeframes) {
      if (budgetLeft() < 1) {
        result.budgetExhausted = true;
        break;
      }
      try {
        const candles = await feed.candles(symbol, timeframe, config.outputSize);
        const analysis = analyseWith(candles, {
          symbol,
          timeframe,
          lastBarClosed: lastBarClosed(candles),
          higherTimeframeBias: bias ?? undefined,
          entryConfirmation: entryBias ?? undefined,
        });
        result.scanned++;

        // Record the READING before the tracker decides whether it is news:
        // a developing setup is worth surfacing every run, even though it is
        // only ever recorded as a trade once.
        if (isOpportunity(analysis.signal)) {
          result.opportunities.push(toOpportunity(analysis));
        }

        const decision = tracker.update(analysis);
        if (!decision.emit) continue;

        const row = toSignalRow(analysis, STRATEGY_ID, now());
        if (row === null) continue;

        rows.push(row);
        result.signals.push({
          id: row.id,
          symbol,
          timeframe,
          signal: analysis.signal,
          confidence: analysis.confidence,
        });

        // An emitted actionable signal becomes the pair's open trade, so the
        // pair is frozen for the rest of this run and every run after it until
        // the trade resolves.
        if (isActionable(analysis.signal)) {
          tracker.activate(symbol, timeframe);
          frozen.add(symbol);
          break; // no second timeframe for a pair that just signalled
        }
      } catch (err) {
        result.errors.push(`${symbol} ${timeframe}: ${(err as Error).message}`);
      }
    }

    scannedCount++;
  }

  // Where the next run picks up. Wraps, so the cursor walks the list forever.
  result.nextOffset = config.symbols.length === 0 ? 0 : (startOffset + scannedCount) % config.symbols.length;

  try {
    result.emitted = await db.recordSignals(rows);
  } catch (err) {
    result.errors.push(`recordSignals: ${(err as Error).message}`);
    result.ok = false;
  }

  try {
    await db.saveSetupState(tracker.snapshot());
  } catch (err) {
    result.errors.push(`saveSetupState: ${(err as Error).message}`);
  }

  result.creditsUsed = feed.creditsUsed();
  result.frozen = [...frozen];
  result.ok = result.ok && result.errors.length < config.symbols.length;

  // Best first — the scanner's job is to put the strongest setup at the top.
  result.opportunities.sort((a, b) => b.confidence - a.confidence);

  await db.finishRun(runId, summaryOf(result)).catch(() => {});
  return result;
}

const summaryOf = (r: ScanResult) => ({
  ok: r.ok,
  scanned: r.scanned,
  emitted: r.emitted,
  closed: r.closed,
  creditsUsed: r.creditsUsed,
  errors: r.errors,
  // Carried in the run log so the NEXT run can read it back — the cursor has
  // to survive a cold start, like everything else the scanner remembers.
  detail: { nextOffset: r.nextOffset, budgetExhausted: r.budgetExhausted },
});

/**
 * Is the newest candle finished?
 *
 * Twelve Data returns the forming bar as the newest entry, and a signal
 * confirmed on a forming bar can evaporate before the bar closes. The provider
 * layer marks completeness; when it does not say, assume NOT closed, because
 * that is the answer that cannot produce a phantom signal.
 */
function lastBarClosed(candles: readonly Candle[]): boolean {
  const last = candles[candles.length - 1];
  return last?.complete === true;
}

/** Expose the analysis for a single pair — used by /api/scanner?dry=1. */
export async function analyseOne(
  feed: MarketFeed,
  symbol: string,
  timeframe: string,
  outputSize = 300,
): Promise<StrategyAnalysis> {
  const candles = await feed.candles(symbol, timeframe, outputSize);
  return analyse(candles, { symbol, timeframe, lastBarClosed: lastBarClosed(candles) });
}

/**
 * Flatten an analysis into the scan-list row.
 *
 * The explanation is assembled from the scored reasons rather than written
 * alongside them, so it cannot drift from the number it explains. Warnings are
 * appended because "why is this only EARLY" is usually the more useful half.
 */
function toOpportunity(a: StrategyAnalysis): Opportunity {
  const why = a.reasons.slice(0, 3).join('; ');
  const caveat = a.warnings.length > 0 ? ` ${a.warnings[0]}` : '';
  const stop = a.risk.stop;
  const target = a.risk.target;
  const rewardRisk =
    a.risk.entry === null || stop === null || target === null || Math.abs(a.risk.entry - stop) === 0
      ? null
      : Math.abs(target - a.risk.entry) / Math.abs(a.risk.entry - stop);

  return {
    symbol: a.symbol,
    timeframe: a.timeframe,
    tier: TIER_LABEL[a.signal],
    signal: a.signal,
    confidence: a.confidence,
    direction: a.direction,
    marketCondition: a.marketCondition,
    entry: a.risk.entry,
    stopLoss: stop,
    takeProfit: target,
    rewardRisk: rewardRisk === null ? null : Math.round(rewardRisk * 100) / 100,
    explanation: `${TIER_LABEL[a.signal]} ${a.confidence}% — ${why}.${caveat}`,
  };
}
