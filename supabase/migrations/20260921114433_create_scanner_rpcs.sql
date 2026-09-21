-- Record emitted signals.
--
-- ON CONFLICT DO NOTHING, not an upsert: the id is deterministic, and a signal
-- is a statement about a moment. If the scanner runs twice over the same bar
-- the second run must change nothing — in particular it must never overwrite a
-- row whose trade has since resolved. The tracker decides what is new; this
-- function only guarantees the database agrees.
create or replace function public.record_signals(payload jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  inserted integer;
begin
  insert into public.signals (
    id, strategy, symbol, timeframe, bar_time, detected_at,
    direction, signal, confidence, market_condition, setup_status,
    price, atr, entry, stop_loss, take_profit1, take_profit2, take_profit3,
    stop_pips, stop_distance_atr, analysis, reasons, warnings
  )
  select
    x.id, x.strategy, x.symbol, x.timeframe, x.bar_time,
    coalesce(x.detected_at, now()),
    x.direction, x.signal, x.confidence, x.market_condition, x.setup_status,
    x.price, x.atr, x.entry, x.stop_loss, x.take_profit1, x.take_profit2, x.take_profit3,
    x.stop_pips, x.stop_distance_atr, x.analysis,
    coalesce(x.reasons, '{}'), coalesce(x.warnings, '{}')
  from jsonb_to_recordset(payload) as x(
    id text, strategy text, symbol text, timeframe text,
    bar_time timestamptz, detected_at timestamptz,
    direction text, signal text, confidence smallint, market_condition text,
    setup_status text, price double precision, atr double precision,
    entry double precision, stop_loss double precision,
    take_profit1 double precision, take_profit2 double precision,
    take_profit3 double precision,
    stop_pips double precision, stop_distance_atr double precision,
    analysis jsonb, reasons text[], warnings text[]
  )
  on conflict (id) do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

-- Persist the tracker. Last write wins: there is one scanner, and the state is
-- a cache of what it already emitted rather than a ledger.
create or replace function public.save_setup_state(payload jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected integer;
begin
  insert into public.setup_state (
    key, symbol, timeframe, direction, status,
    first_bar_time, last_bar_time, impulse_origin, emitted_confidence, emitted_at
  )
  select
    x.key, x.symbol, x.timeframe, x.direction, x.status,
    x.first_bar_time, x.last_bar_time, x.impulse_origin, x.emitted_confidence, x.emitted_at
  from jsonb_to_recordset(payload) as x(
    key text, symbol text, timeframe text, direction text, status text,
    first_bar_time timestamptz, last_bar_time timestamptz,
    impulse_origin double precision, emitted_confidence smallint, emitted_at timestamptz
  )
  on conflict (key) do update set
    direction = excluded.direction,
    status = excluded.status,
    first_bar_time = excluded.first_bar_time,
    last_bar_time = excluded.last_bar_time,
    impulse_origin = excluded.impulse_origin,
    emitted_confidence = excluded.emitted_confidence,
    emitted_at = excluded.emitted_at;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- Resolve a trade.
--
-- The guard `where result = 'pending'` is what makes this safe to call from a
-- checker that may run concurrently with itself: whichever call lands first
-- closes the trade, the rest affect zero rows. Without it a late TP check
-- could overwrite an SL that already happened.
--
-- r_multiple is computed here, from the row's own entry and stop, so it cannot
-- disagree with the levels that were actually recorded.
create or replace function public.close_signal(
  signal_id text,
  outcome text,
  price double precision
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected integer;
begin
  update public.signals s set
    result = outcome,
    closed_price = price,
    closed_at = now(),
    r_multiple = case
      when s.entry is null or s.stop_loss is null or s.entry = s.stop_loss then null
      when outcome = 'be' then 0
      else (case when s.direction = 'long' then price - s.entry else s.entry - price end)
           / abs(s.entry - s.stop_loss)
    end
  where s.id = signal_id and s.result = 'pending';

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- TP1 moves the stop to entry. The trade stays open; worst case becomes zero.
create or replace function public.mark_breakeven(signal_id text)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected integer;
begin
  update public.signals s set tp1_hit = true, stop_loss = s.entry
  where s.id = signal_id and s.result = 'pending' and s.tp1_hit = false and s.entry is not null;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke execute on function public.record_signals(jsonb) from public, anon, authenticated;
revoke execute on function public.save_setup_state(jsonb) from public, anon, authenticated;
revoke execute on function public.close_signal(text, text, double precision) from public, anon, authenticated;
revoke execute on function public.mark_breakeven(text) from public, anon, authenticated;
