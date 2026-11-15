/**
 * Neon Postgres access for the signal history.
 *
 *   GitHub Actions ──POST /api/scan──▶ scanner ──┬─▶ recordSignals()
 *                                                └─▶ resolveTrade()
 *   browser ────────GET /api/signals──▶ recentSignals()
 *
 * WHY NEON AND WHY THE HTTP DRIVER
 * ────────────────────────────────
 * The scanner is a serverless function that wakes, does a few hundred
 * milliseconds of work and dies. A pooled TCP connection is the wrong shape
 * for that — every cold start pays a handshake, and idle instances hold
 * connections the database then has to reclaim. `neon()` is a one-shot HTTPS
 * request per statement: no pool, no teardown, nothing to leak between
 * invocations.
 *
 * The cost is that each statement is its own round trip, so this module batches
 * deliberately (one multi-row insert, not one insert per signal) rather than
 * looping over single statements.
 *
 * WHY EVERY FUNCTION TOLERATES AN UNCONFIGURED DATABASE
 * ────────────────────────────────────────────────────
 * DATABASE_URL is absent in local development and in any deployment where the
 * history has not been set up yet. The app's job is to show live signals; the
 * history is an addition to it. So a missing database degrades the history to
 * empty and leaves everything else working, rather than taking the site down.
 * `isConfigured()` is the one thing callers check.
 */
import { createRequire } from 'node:module';
import { neon } from '@neondatabase/serverless';

let cached = null;
let cachedUrl = null;

/**
 * How a connection string becomes a query function. Swappable, and that is
 * not a test backdoor — it is the only way this file's SQL gets executed
 * before production.
 *
 * `neon()` speaks HTTP to Neon's own proxy. It cannot be pointed at an
 * ordinary Postgres server, so without this seam every statement below would
 * first run for real against the live database, and a typo in a column name
 * would surface as a failed scan rather than as a failed test. db.test.mjs
 * installs a driver backed by a local Postgres and exercises all of it.
 *
 * Anything installed here must match neon()'s shape: a tagged template that
 * resolves to an ARRAY OF ROWS (not a { rows } wrapper), carrying a `.query`
 * method for raw multi-statement text.
 */
let driver = defaultDriver;

/**
 * Neon in production, ordinary Postgres anywhere else.
 *
 * `neon()` is an HTTPS client for Neon's own query proxy — it cannot speak to
 * a Postgres server directly, so `postgresql://localhost/...` simply does not
 * work through it. That would make local development against a local database
 * impossible, which is the normal way to try a schema change before it
 * reaches the real data.
 *
 * So a non-Neon host falls back to node-postgres, wrapped to look exactly
 * like neon(): a tagged template resolving to an array of rows, with `.query`
 * for raw text. `pg` is a devDependency and this branch is never taken in
 * production, where the URL always points at neon.tech — if it is somehow
 * missing, the error says so rather than failing somewhere stranger.
 */
function defaultDriver(url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // An unparseable URL is neon()'s problem to report, not this function's.
  }
  if (host === '' || host.endsWith('.neon.tech')) return neon(url);

  let pg;
  try {
    pg = createRequire(import.meta.url)('pg');
  } catch {
    throw new Error(
      `DATABASE_URL points at ${host}, which is not Neon, and the 'pg' package is not installed. ` +
        'Install it for local development, or use a Neon connection string.',
    );
  }
  const pool = new pg.Pool({ connectionString: url });
  const tagged = (strings, ...values) => {
    const text = strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), '');
    return pool.query(text, values).then((r) => r.rows);
  };
  tagged.query = (text, params = []) => pool.query(text, params).then((r) => r.rows);
  return tagged;
}

/** Install a different driver. Returns the previous one, so tests can restore it. */
export function setDriver(next) {
  const prev = driver;
  driver = next;
  resetClient();
  return prev;
}

/** True when a connection string is present. Callers branch on this. */
export function isConfigured(env = process.env) {
  return typeof env.DATABASE_URL === 'string' && env.DATABASE_URL.trim().length > 0;
}

/**
 * The tagged-template query function, memoised per URL.
 *
 * Memoised because a warm serverless instance serves many requests and
 * re-parsing the connection string each time is pure waste; keyed by URL so a
 * test that swaps the variable is not served a stale client.
 */
function sql(env = process.env) {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error('DATABASE_URL is not set — the signal history is not configured.');
  if (cached && cachedUrl === url) return cached;
  cached = driver(url);
  cachedUrl = url;
  return cached;
}

/** Drop the memoised client. Tests use this; nothing in production needs it. */
export function resetClient() {
  cached = null;
  cachedUrl = null;
}

// ── schema ────────────────────────────────────────────────────────────────

/**
 * Split a .sql file into individual statements.
 *
 * WHY THIS EXISTS, WHICH IS NOT "TIDINESS"
 * ────────────────────────────────────────
 * Neon's HTTP driver sends each request as a single parse message, so it
 * accepts exactly ONE statement. Handing it a whole migration file fails with
 * 42601 — a plain syntax error, pointing at nothing useful.
 *
 * It is worth being precise about how that got shipped: the integration tests
 * run against a local Postgres through node-postgres, whose simple-query
 * protocol happily executes a multi-statement string. So the migration passed
 * every test and failed on the first real deploy. The lesson is in the code
 * now — `migrate` splits unconditionally, for every driver, so the tests
 * exercise the same one-statement-per-call path Neon will take.
 *
 * WHY NOT `text.split(';')`
 * ─────────────────────────
 * The migration defines a trigger function:
 *
 *     create function set_updated_at() ... as $$
 *     begin
 *       new.updated_at = now();     ← a semicolon INSIDE the body
 *       return new;                 ← and another
 *     end;
 *     $$;
 *
 * Splitting on `;` would cut that into four pieces, none of them valid. So
 * this walks the text and only treats `;` as a terminator at the top level —
 * outside dollar-quoted bodies ($$ or $tag$), string literals, quoted
 * identifiers, and comments.
 */
export function splitSql(text) {
  const out = [];
  let start = 0;
  let i = 0;
  /**
   * Has anything executable been seen since the last `;`?
   *
   * Tracked separately from "is the slice non-empty", because a file usually
   * ends with a trailing comment. Without this, that comment is emitted as a
   * final statement and sent to the server as an empty query.
   */
  let hasSql = false;

  /** Close off the statement ending at `end`, if it holds any SQL. */
  const flush = (end) => {
    if (hasSql) {
      const stmt = text.slice(start, end).trim();
      if (stmt) out.push(stmt);
    }
    hasSql = false;
  };

  while (i < text.length) {
    const c = text[i];

    // -- line comment
    if (c === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }
    // /* block comment */ — nests in Postgres, so count depth
    if (c === '/' && text[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') (depth++, (i += 2));
        else if (text[i] === '*' && text[i + 1] === '/') (depth--, (i += 2));
        else i++;
      }
      continue;
    }
    // 'string literal' — '' is an escaped quote, not a terminator
    if (c === "'") {
      hasSql = true;
      i++;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") i += 2;
        else if (text[i] === "'") {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    // "quoted identifier" — same doubling rule
    if (c === '"') {
      hasSql = true;
      i++;
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') i += 2;
        else if (text[i] === '"') {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    // $$ ... $$ or $tag$ ... $tag$
    if (c === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(i));
      if (tag) {
        hasSql = true;
        const close = text.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? text.length : close + tag[0].length;
        continue;
      }
    }
    if (c === ';') {
      flush(i);
      start = i + 1;
      i++;
      continue;
    }
    if (!/\s/.test(c)) hasSql = true;
    i++;
  }

  flush(text.length);
  return out;
}

/**
 * Apply any migration the database has not seen, in filename order.
 *
 * Statements run one at a time — see `splitSql` for why that is a hard
 * requirement and not a style choice. The file is only recorded as applied
 * after every one of its statements has succeeded, so a failure half way
 * leaves it un-recorded and the next run retries it. That is safe because the
 * files are written to be idempotent (`create table if not exists`,
 * `create or replace`, `drop trigger if exists`), so re-running the part that
 * already succeeded changes nothing.
 */
export async function migrate(files, env = process.env) {
  const q = sql(env);
  await q`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;

  const applied = new Set((await q`select name from schema_migrations`).map((r) => r.name));
  const ran = [];
  for (const { name, text } of files) {
    if (applied.has(name)) continue;
    for (const statement of splitSql(text)) {
      try {
        await q.query(statement);
      } catch (err) {
        // Name the file and show the statement: a bare 42601 from a 100-line
        // migration tells you nothing about where to look.
        const head = statement.length > 200 ? `${statement.slice(0, 200)}…` : statement;
        throw new Error(`${name}: ${err?.message || err}\n\nStatement:\n${head}`);
      }
    }
    await q`insert into schema_migrations (name) values (${name}) on conflict do nothing`;
    ran.push(name);
  }
  return ran;
}

// ── writing ───────────────────────────────────────────────────────────────

/**
 * Insert signals, ignoring any the database already holds.
 *
 * ON CONFLICT DO NOTHING rather than an upsert, and that is the important
 * part. The id is deterministic per (strategy, symbol, timeframe, bar), and a
 * signal is a statement about a moment that has passed. If the scanner sees
 * the same bar again — it re-reads several recent bars every run, by design —
 * the second sighting must change nothing. In particular it must never
 * overwrite a row whose trade has since been resolved, which an upsert would
 * do the moment a lookback window reached back over a closed trade.
 *
 * Returns the number of rows actually inserted, which is how the scanner
 * knows what was new without asking again.
 */
export async function recordSignals(rows, env = process.env) {
  if (rows.length === 0) return 0;
  const q = sql(env);

  // One statement for the whole batch: each neon() call is an HTTPS round
  // trip, so a loop here would cost one per signal.
  const inserted = await q`
    insert into signals (
      id, strategy, symbol, timeframe, bar_time, detected_at, source,
      price, ema, atr, tolerance_pips, distance_pips,
      approach, outcome, trend, bias, counter_trend,
      ichimoku, ichimoku_score,
      direction, entry, stop_loss, take_profit, stop_pips,
      result, exit_price, exit_at, bars_held, result_pips
    )
    select
      x.id, x.strategy, x.symbol, x.timeframe,
      to_timestamp(x.bar_time), to_timestamp(x.detected_at), x.source,
      x.price, x.ema, x.atr, x.tolerance_pips, x.distance_pips,
      x.approach, x.outcome, x.trend, x.bias, x.counter_trend,
      x.ichimoku, x.ichimoku_score,
      x.direction, x.entry, x.stop_loss, x.take_profit, x.stop_pips,
      x.result,
      -- A trade stopped out on its own entry bar arrives already closed, so
      -- its outcome comes in with the insert rather than through closeTrade.
      x.exit_price,
      case when x.exit_at is null then null else to_timestamp(x.exit_at) end,
      x.bars_held, x.result_pips
    from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(
      id text, strategy text, symbol text, timeframe text,
      bar_time double precision, detected_at double precision, source text,
      price double precision, ema double precision, atr double precision,
      tolerance_pips double precision, distance_pips double precision,
      approach text, outcome text, trend text, bias text, counter_trend boolean,
      ichimoku jsonb, ichimoku_score smallint,
      direction text, entry double precision, stop_loss double precision,
      take_profit double precision, stop_pips double precision,
      result text, exit_price double precision, exit_at double precision,
      bars_held integer, result_pips double precision
    )
    on conflict (id) do nothing
    returning id`;
  return inserted.length;
}

/** Trades still running, oldest first, so the resolver works in order. */
export async function openTrades(env = process.env) {
  const q = sql(env);
  return q`
    select id, symbol, timeframe, direction, entry, stop_loss, take_profit, stop_pips,
           extract(epoch from bar_time)::double precision as bar_time
    from signals
    where result = 'open'
    order by bar_time asc`;
}

/**
 * Close a trade.
 *
 * `where result = 'open'` is what makes this safe to call from two scanner
 * invocations at once: whichever lands first closes the trade, the other
 * affects zero rows. Without the guard a late take-profit check could
 * overwrite a stop-out that already happened.
 */
export async function closeTrade({ id, result, exitPrice, exitAt, barsHeld, resultPips }, env = process.env) {
  const q = sql(env);
  const rows = await q`
    update signals set
      result = ${result},
      exit_price = ${exitPrice},
      exit_at = ${exitAt === null ? null : new Date(exitAt * 1000).toISOString()},
      bars_held = ${barsHeld},
      result_pips = ${resultPips}
    where id = ${id} and result = 'open'
    returning id`;
  return rows.length > 0;
}

// ── reading ───────────────────────────────────────────────────────────────

/** Newest first, for the history page. `symbol` null means every pair. */
export async function recentSignals({ limit = 200, symbol = null } = {}, env = process.env) {
  const q = sql(env);
  const capped = Math.min(Math.max(1, Number(limit) || 200), 1000);
  return q`
    select id, strategy, symbol, timeframe,
           extract(epoch from bar_time)::double precision   as bar_time,
           extract(epoch from detected_at)::double precision as detected_at,
           source, price, ema, atr, tolerance_pips, distance_pips,
           approach, outcome, trend, bias, counter_trend, ichimoku, ichimoku_score,
           direction, entry, stop_loss, take_profit, stop_pips,
           result, exit_price,
           extract(epoch from exit_at)::double precision     as exit_at,
           bars_held, result_pips
    from signals
    where (${symbol}::text is null or symbol = ${symbol})
    order by bar_time desc
    limit ${capped}`;
}

/**
 * Totals for the history page header, computed in the database.
 *
 * Grouped by symbol rather than summed overall, because adding a JPY pip to a
 * EUR/USD pip is adding unlike things — the same reason the backtest page
 * flags a mixed selection instead of printing one total.
 */
export async function signalStats(env = process.env) {
  const q = sql(env);
  return q`
    select symbol,
           count(*)                                            as total,
           count(*) filter (where result = 'open')              as open,
           count(*) filter (where result = 'tp')                as tp,
           count(*) filter (where result = 'sl')                as sl,
           count(*) filter (where result = 'nofill')            as nofill,
           sum(result_pips) filter (where result in ('tp','sl')) as net_pips,
           avg(stop_pips)   filter (where result in ('tp','sl')) as avg_stop_pips
    from signals
    group by symbol
    order by symbol`;
}

// ── run log ───────────────────────────────────────────────────────────────

export async function startRun(env = process.env) {
  const q = sql(env);
  const [row] = await q`insert into scanner_runs default values returning id`;
  return row?.id ?? null;
}

export async function finishRun(id, { ok, scanned, recorded, resolved, errors, detail }, env = process.env) {
  if (id === null) return;
  const q = sql(env);
  await q`
    update scanner_runs set
      finished_at = now(), ok = ${ok}, scanned = ${scanned},
      recorded = ${recorded}, resolved = ${resolved},
      errors = ${errors}, detail = ${JSON.stringify(detail ?? {})}::jsonb
    where id = ${id}`;
}
