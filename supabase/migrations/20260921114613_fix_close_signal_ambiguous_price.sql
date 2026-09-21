-- `price` named both a parameter and a column, so `closed_price = price` was
-- ambiguous and the function failed at runtime rather than at creation time —
-- plpgsql bodies are only parsed when first executed. Every parameter is now
-- p_-prefixed, which makes the collision impossible to reintroduce.
--
-- Parameter names cannot be changed by CREATE OR REPLACE, hence the drops.
drop function if exists public.close_signal(text, text, double precision);
drop function if exists public.mark_breakeven(text);

create function public.close_signal(
  p_signal_id text,
  p_outcome text,
  p_price double precision
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
    result = p_outcome,
    closed_price = p_price,
    closed_at = now(),
    r_multiple = case
      when s.entry is null or s.stop_loss is null or s.entry = s.stop_loss then null
      when p_outcome = 'be' then 0
      else (case when s.direction = 'long' then p_price - s.entry else s.entry - p_price end)
           / abs(s.entry - s.stop_loss)
    end
  -- The guard that makes concurrent checkers safe: first close wins, the rest
  -- affect zero rows and cannot overwrite a resolved trade.
  where s.id = p_signal_id and s.result = 'pending';

  get diagnostics affected = row_count;
  return affected;
end;
$$;

create function public.mark_breakeven(p_signal_id text)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected integer;
begin
  update public.signals s set tp1_hit = true, stop_loss = s.entry
  where s.id = p_signal_id and s.result = 'pending' and s.tp1_hit = false and s.entry is not null;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke execute on function public.close_signal(text, text, double precision) from public, anon, authenticated;
revoke execute on function public.mark_breakeven(text) from public, anon, authenticated;
