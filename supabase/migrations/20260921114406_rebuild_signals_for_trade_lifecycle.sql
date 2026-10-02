-- Rebuild the signals table around a TRADE, not an observation.
--
-- The old shape recorded "the EMA50 was touched and price bounced/crossed".
-- That can never answer the only question worth asking of a signal history:
-- did it make money? A history you cannot measure is a log, not a record.
--
-- The 421 rows dropped here were backfill: the browser replayed 300 bars on
-- every page load, so they describe when someone had the site open rather than
-- what the market did. Keeping them would poison every statistic computed from
-- this table.
drop function if exists public.upsert_signals(jsonb);
drop table if exists public.signals cascade;

create table public.signals (
  -- Deterministic: strategy|symbol|timeframe|bar_time. A cron that fires twice,
  -- or two scanner instances racing, cannot produce two rows for one setup.
  id              text primary key,
  strategy        text not null,
  symbol          text not null,
  timeframe       text not null,

  -- Market time of the analysed bar, and when we noticed. Both matter: the
  -- first orders the history, the second measures scanner latency.
  bar_time        timestamptz not null,
  detected_at     timestamptz not null default now(),

  direction       text not null check (direction in ('long', 'short')),
  signal          text not null check (signal in (
                    'STRONG_LONG', 'LONG', 'WATCH_LONG', 'NEUTRAL',
                    'WATCH_SHORT', 'SHORT', 'STRONG_SHORT', 'NO_TRADE')),
  confidence      smallint not null check (confidence between 0 and 100),
  market_condition text not null check (market_condition in (
                    'TRENDING_BULLISH', 'TRENDING_BEARISH', 'RANGING', 'CHOPPY',
                    'TRANSITION', 'OVEREXTENDED', 'INSUFFICIENT_DATA')),
  setup_status    text not null check (setup_status in (
                    'FORMING', 'CONFIRMING', 'CONFIRMED', 'ACTIVE',
                    'INVALIDATED', 'COMPLETED')),

  price           double precision not null,
  atr             double precision not null,

  -- The order ticket as it stood when the signal fired.
  entry           double precision,
  stop_loss       double precision,
  take_profit1    double precision,
  take_profit2    double precision,
  take_profit3    double precision,
  stop_pips       double precision,
  stop_distance_atr double precision,

  -- Lifecycle. 'pending' until price resolves it; 'be' is a breakeven stop
  -- after TP1 moved it to entry, which is a different outcome from a loss.
  result          text not null default 'pending' check (result in (
                    'pending', 'tp1', 'tp2', 'tp3', 'sl', 'be', 'expired', 'invalidated')),
  tp1_hit         boolean not null default false,
  closed_price    double precision,
  closed_at       timestamptz,
  -- Result in R. The unit that makes trades comparable across pairs and
  -- volatility: +2.5 means two and a half times the risk taken.
  r_multiple      double precision,

  -- The whole structured analysis, so any signal can be re-explained later
  -- without re-running the engine against history we no longer have.
  analysis        jsonb,
  reasons         text[] not null default '{}',
  warnings        text[] not null default '{}',

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index signals_bar_time_idx    on public.signals (bar_time desc);
create index signals_symbol_bar_idx  on public.signals (symbol, bar_time desc);
create index signals_strategy_tf_idx on public.signals (strategy, timeframe, bar_time desc);
-- Partial: the TP/SL checker only ever asks for open trades, and this keeps
-- that query O(open) rather than O(history) as the table grows.
create index signals_pending_idx     on public.signals (symbol) where result = 'pending';

comment on table public.signals is
  'Trade signals from the Ichialgo scanner, with their outcomes. Written only by the app server using the service role key; RLS is on with no policies, so anon/publishable keys cannot read or write.';

alter table public.signals enable row level security;

-- Setup memory, so a serverless scanner that starts cold does not re-emit
-- every setup it already sent. One row per (symbol, timeframe).
create table public.setup_state (
  key             text primary key,
  symbol          text not null,
  timeframe       text not null,
  direction       text not null,
  status          text not null,
  first_bar_time  timestamptz,
  last_bar_time   timestamptz,
  impulse_origin  double precision,
  emitted_confidence smallint,
  emitted_at      timestamptz,
  updated_at      timestamptz not null default now()
);

comment on table public.setup_state is
  'SetupTracker state across scanner invocations. Prevents re-emitting a setup after a cold start.';

alter table public.setup_state enable row level security;

-- Scanner run log. This is deliberately IN THE DATABASE rather than in process
-- memory: on serverless, a module-level variable is per-instance and dies on
-- cold start, so a "do not scan twice within N minutes" guard held in memory
-- does not actually guard anything once two instances are warm.
create table public.scanner_runs (
  id              bigint generated always as identity primary key,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  ok              boolean,
  scanned         integer not null default 0,
  emitted         integer not null default 0,
  closed          integer not null default 0,
  credits_used    integer not null default 0,
  errors          text[] not null default '{}',
  detail          jsonb
);

create index scanner_runs_started_idx on public.scanner_runs (started_at desc);

comment on table public.scanner_runs is
  'One row per scanner invocation. Backs the minimum-interval guard and gives credit-spend observability.';

alter table public.scanner_runs enable row level security;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke execute on function public.set_updated_at() from public;
revoke execute on function public.set_updated_at() from anon;
revoke execute on function public.set_updated_at() from authenticated;

create trigger signals_set_updated_at
  before update on public.signals
  for each row execute function public.set_updated_at();

create trigger setup_state_set_updated_at
  before update on public.setup_state
  for each row execute function public.set_updated_at();
