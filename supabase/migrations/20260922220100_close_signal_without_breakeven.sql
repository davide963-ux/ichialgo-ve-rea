-- Drop the breakeven branch from close_signal.
--
-- 'be' can no longer be produced: there is one target and one stop, and
-- nothing moves the stop mid-trade. Leaving the branch in would be a route
-- for a 0R result to reappear without any code path that creates it.
--
-- R is still computed in SQL rather than by the caller, so the number in the
-- row cannot disagree with the levels in the same row.
create or replace function public.close_signal(p_signal_id text, p_outcome text, p_price double precision)
returns integer
language plpgsql
set search_path to ''
as $function$
declare
  affected integer;
begin
  update public.signals s set
    result = p_outcome,
    closed_price = case when p_outcome in ('expired', 'invalidated') then null else p_price end,
    closed_at = now(),
    r_multiple = case
      -- No measured outcome: not a win, not a loss, not a zero.
      when p_outcome in ('expired', 'invalidated') then null
      when s.entry is null or s.stop_loss is null or s.entry = s.stop_loss then null
      else (case when s.direction = 'long' then p_price - s.entry else s.entry - p_price end)
           / abs(s.entry - s.stop_loss)
    end
  where s.id = p_signal_id and s.result = 'pending';

  get diagnostics affected = row_count;
  return affected;
end;
$function$;
