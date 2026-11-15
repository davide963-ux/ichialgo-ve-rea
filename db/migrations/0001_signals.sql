-- Signal history for the EMA50-touch strategy.
--
-- WHAT A ROW IS
-- ─────────────
-- One touch of the EMA50 on one bar of one pair, the order ticket that touch
-- implied, and — once price decides — what that trade would have made, in
-- pips. Not "a thing the scanner noticed": a statement you can check against
-- a chart afterwards.
--
-- WHY THE ID IS TEXT AND NOT A SEQUENCE
-- ─────────────────────────────────────
--   id = 'ema50-touch|EUR/USD|30M|1763208000'
--
-- Deterministic from (strategy, symbol, timeframe, bar). A scanner that fires
-- twice, overlaps its own lookback window, or runs from two places at once
-- cannot produce two rows for one touch, and does not need a lock to avoid
-- it. The scanner re-reads several recent bars on every run precisely BECAUSE
-- the id makes that free.
--
-- WHY `result` STARTS AT 'open' AND 'nofill' EXISTS
-- ────────────────────────────────────────────────
-- Entry is a resting limit at the EMA, and the touch band is wider than the
-- line, so a bar can touch the band without ever trading at the entry. The
-- backtest counts those as no-fills (see backtest.ts, rule 1 — counting them
-- as trades was worth about a fifth of the stop per trade of pure fiction).
-- The live history has to apply the same rule or its statistics will be
-- inflated in exactly the way the backtest's once were, and the two will
-- never agree.
create table if not exists signals (
  id              text primary key,
  strategy        text        not null,
  symbol          text        not null,
  timeframe       text        not null,

  -- Market time of the bar that touched, and when the scanner saw it. Both
  -- matter: the first orders the history, the gap between them is scanner lag.
  bar_time        timestamptz not null,
  detected_at     timestamptz not null default now(),
  source          text        not null check (source in ('candle', 'live')),

  -- ── the touch itself ──────────────────────────────────────────────────
  price           double precision not null,
  ema             double precision not null,
  atr             double precision not null,
  tolerance_pips  double precision not null,
  distance_pips   double precision not null,
  approach        text not null check (approach in ('above', 'below')),
  outcome         text not null check (outcome in ('bounce', 'cross', 'inside', 'pending')),
  trend           text not null check (trend in ('up', 'down', 'flat')),
  bias            text not null check (bias in ('long', 'short', 'neutral')),
  counter_trend   boolean not null,

  -- The five Ichimoku checks, null until the cloud has enough bars to warm up.
  ichimoku        jsonb,
  ichimoku_score  smallint,

  -- ── the ticket, as it stood at the touch ──────────────────────────────
  -- Stored rather than recomputed: ATR moves, so re-deriving these later
  -- would silently answer a different question from the one asked at the time.
  direction       text check (direction in ('LONG', 'SHORT')),
  entry           double precision,
  stop_loss       double precision,
  take_profit     double precision,
  stop_pips       double precision,

  -- ── how it ended ──────────────────────────────────────────────────────
  result          text not null default 'open'
                  check (result in ('open', 'tp', 'sl', 'nofill', 'expired')),
  exit_price      double precision,
  exit_at         timestamptz,
  bars_held       integer,
  -- Net pips, cost included. The unit the whole app now reports in.
  result_pips     double precision,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- The history page: newest first, optionally one pair.
create index if not exists signals_bar_time_idx   on signals (bar_time desc);
create index if not exists signals_symbol_bar_idx on signals (symbol, bar_time desc);

-- The resolver asks only for trades still running. Partial, so this stays
-- O(open) instead of O(history) as the table grows — and the table is meant
-- to grow for years.
create index if not exists signals_open_idx on signals (symbol) where result = 'open';

create or replace function set_updated_at() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists signals_set_updated_at on signals;
create trigger signals_set_updated_at
  before update on signals
  for each row execute function set_updated_at();

-- One row per scanner run. Deliberately in the database and not in process
-- memory: the scanner is serverless, so a module-level variable is per
-- instance and dies on cold start — it would not actually record anything.
create table if not exists scanner_runs (
  id            bigint generated always as identity primary key,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  ok            boolean,
  scanned       integer not null default 0,
  recorded      integer not null default 0,
  resolved      integer not null default 0,
  errors        text[]  not null default '{}',
  detail        jsonb
);

create index if not exists scanner_runs_started_idx on scanner_runs (started_at desc);
