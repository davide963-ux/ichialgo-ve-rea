-- Follow the impulse_origin → anchor rename into the RPC.
--
-- plpgsql resolves column names on FIRST EXECUTION, not at creation, so a
-- function left pointing at a renamed column is created happily and then
-- fails at runtime — the same way `close_signal` did with its ambiguous
-- `price` parameter. Renaming a column is therefore never complete until
-- every function that names it has been reissued.
create or replace function public.save_setup_state(payload jsonb)
returns integer
language plpgsql
set search_path to ''
as $function$
declare
  affected integer;
begin
  insert into public.setup_state (
    key, symbol, timeframe, direction, status,
    first_bar_time, last_bar_time, anchor, emitted_confidence, emitted_at
  )
  select
    x.key, x.symbol, x.timeframe, x.direction, x.status,
    x.first_bar_time, x.last_bar_time, x.anchor, x.emitted_confidence, x.emitted_at
  from jsonb_to_recordset(payload) as x(
    key text, symbol text, timeframe text, direction text, status text,
    first_bar_time timestamptz, last_bar_time timestamptz,
    anchor double precision, emitted_confidence smallint, emitted_at timestamptz
  )
  on conflict (key) do update set
    direction = excluded.direction,
    status = excluded.status,
    first_bar_time = excluded.first_bar_time,
    last_bar_time = excluded.last_bar_time,
    anchor = excluded.anchor,
    emitted_confidence = excluded.emitted_confidence,
    emitted_at = excluded.emitted_at;

  get diagnostics affected = row_count;
  return affected;
end;
$function$;
