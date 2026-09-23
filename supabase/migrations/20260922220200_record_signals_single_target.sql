-- Follow the ladder removal into record_signals.
--
-- plpgsql resolves column names on FIRST EXECUTION, so a function still
-- naming take_profit1/2/3 is created happily and then fails at runtime on the
-- very first signal — the same trap that caught save_setup_state and
-- close_signal. A column change is never finished until every function naming
-- it has been reissued.
create or replace function public.record_signals(payload jsonb)
returns integer
language plpgsql
set search_path to ''
as $function$
declare
  inserted integer;
begin
  insert into public.signals (
    id, strategy, symbol, timeframe, bar_time, detected_at,
    direction, signal, confidence, market_condition, setup_status,
    price, atr, entry, stop_loss, take_profit,
    stop_pips, stop_distance_atr, analysis, reasons, warnings
  )
  select
    x.id, x.strategy, x.symbol, x.timeframe, x.bar_time,
    coalesce(x.detected_at, now()),
    x.direction, x.signal, x.confidence, x.market_condition, x.setup_status,
    x.price, x.atr, x.entry, x.stop_loss, x.take_profit,
    x.stop_pips, x.stop_distance_atr, x.analysis,
    coalesce(x.reasons, '{}'), coalesce(x.warnings, '{}')
  from jsonb_to_recordset(payload) as x(
    id text, strategy text, symbol text, timeframe text,
    bar_time timestamptz, detected_at timestamptz,
    direction text, signal text, confidence smallint, market_condition text,
    setup_status text, price double precision, atr double precision,
    entry double precision, stop_loss double precision,
    take_profit double precision,
    stop_pips double precision, stop_distance_atr double precision,
    analysis jsonb, reasons text[], warnings text[]
  )
  on conflict (id) do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$function$;
