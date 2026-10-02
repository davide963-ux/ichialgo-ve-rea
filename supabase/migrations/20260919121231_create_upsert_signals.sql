-- Bulk upsert with the same merge rules the in-memory log uses.
--
-- A signal can arrive more than once for the same bar:
--   1. as a 'live' tick, then again as a closed 'candle' with a real outcome;
--   2. as a 'candle' on a still-forming bar (outcome 'pending'), then again
--      once that bar closes and it is known to have bounced or crossed.
-- Both are UPGRADES. The reverse must never happen: a resolved row is never
-- overwritten by a later live tick or a re-scan, and detected_at always keeps
-- the earliest time the app actually saw the touch.
create or replace function public.upsert_signals(payload jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected integer;
begin
  insert into public.signals as s (
    id, strategy, symbol, timeframe, bar_time, detected_at, source,
    price, ema, atr, tolerance_pips, distance_pips,
    approach, outcome, trend, bias, counter_trend,
    ichimoku, ichimoku_score, plan
  )
  select
    x.id, x.strategy, x.symbol, x.timeframe, x.bar_time, x.detected_at, x.source,
    x.price, x.ema, x.atr, x.tolerance_pips, x.distance_pips,
    x.approach, x.outcome, x.trend, x.bias, x.counter_trend,
    x.ichimoku, x.ichimoku_score, x.plan
  from jsonb_to_recordset(payload) as x(
    id text, strategy text, symbol text, timeframe text,
    bar_time timestamptz, detected_at timestamptz, source text,
    price double precision, ema double precision, atr double precision,
    tolerance_pips double precision, distance_pips double precision,
    approach text, outcome text, trend text, bias text, counter_trend boolean,
    ichimoku jsonb, ichimoku_score smallint, plan jsonb
  )
  on conflict (id) do update set
    source        = excluded.source,
    outcome       = excluded.outcome,
    price         = excluded.price,
    ema           = excluded.ema,
    atr           = excluded.atr,
    tolerance_pips = excluded.tolerance_pips,
    distance_pips = excluded.distance_pips,
    trend         = excluded.trend,
    bias          = excluded.bias,
    counter_trend = excluded.counter_trend,
    ichimoku      = coalesce(excluded.ichimoku, s.ichimoku),
    ichimoku_score = coalesce(excluded.ichimoku_score, s.ichimoku_score),
    plan          = coalesce(excluded.plan, s.plan),
    -- never lose the moment it was first seen
    detected_at   = least(s.detected_at, excluded.detected_at)
  where s.source = 'live' or s.outcome = 'pending';

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- Only the service role may call it; the browser never reaches Supabase.
revoke execute on function public.upsert_signals(jsonb) from public;
revoke execute on function public.upsert_signals(jsonb) from anon;
revoke execute on function public.upsert_signals(jsonb) from authenticated;
