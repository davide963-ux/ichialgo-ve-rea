-- Historical log of strategy signals.
--
-- The primary key is the app's own signal id, "strategy|symbol|timeframe|barTime",
-- so the same bar can never be stored twice however many times it is re-scanned
-- or how many browsers are open. That is also what lets a 'live' signal be
-- upgraded in place when the bar later closes and its outcome is known.
create table public.signals (
  id            text primary key,
  strategy      text        not null,
  symbol        text        not null,
  timeframe     text        not null,

  -- When the touch happened in MARKET time (the bar), not when we noticed.
  bar_time      timestamptz not null,
  -- When this app first saw it; preserved across upgrades.
  detected_at   timestamptz not null,
  source        text        not null check (source in ('candle', 'live')),

  price         double precision not null,
  ema           double precision not null,
  atr           double precision not null,
  tolerance_pips  double precision not null,
  distance_pips   double precision not null,

  approach      text not null check (approach in ('above', 'below')),
  outcome       text not null check (outcome in ('bounce', 'cross', 'inside', 'pending')),
  trend         text not null check (trend in ('up', 'down', 'flat')),
  bias          text not null check (bias in ('long', 'short', 'neutral')),
  counter_trend boolean not null,

  -- The five Ichimoku checks, null before the cloud has warmed up.
  ichimoku      jsonb,
  ichimoku_score smallint,
  -- Entry/stop/target/size at the moment of the touch, null if unsizable.
  plan          jsonb,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- The history queries: newest first, filtered by pair and timeframe.
create index signals_bar_time_idx      on public.signals (bar_time desc);
create index signals_symbol_bar_idx    on public.signals (symbol, bar_time desc);
create index signals_timeframe_bar_idx on public.signals (timeframe, bar_time desc);

comment on table public.signals is
  'EMA50 touch signals produced by Ichialgo. Written only by the app server using the service role key; RLS is on with no policies, so anon/publishable keys cannot read or write.';

-- RLS on, and deliberately NO policies: every request that is not the service
-- role is denied. The app reaches this table only through its own server, which
-- holds the service key; the browser never talks to Supabase directly.
alter table public.signals enable row level security;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger signals_set_updated_at
  before update on public.signals
  for each row execute function public.set_updated_at();
