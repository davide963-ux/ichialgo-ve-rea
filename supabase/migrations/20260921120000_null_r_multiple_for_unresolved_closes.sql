-- An expired or invalidated trade has no R.
--
-- expireStale closes stale trades by calling close_signal with a placeholder
-- price of 0, and the old arithmetic happily turned that into a ~-13R loss.
-- One of those wipes out a dozen real wins and there is nothing in the data to
-- show it is fictional.
--
-- 'expired' means the trade never resolved; 'invalidated' means the setup
-- stopped being valid before price decided. Neither is a measured result, so
-- r_multiple is NULL and the metrics layer — which already skips null R —
-- leaves them out of win rate, average R and profit factor. They still appear
-- in the history, counted and visible, just not scored.
create or replace function public.close_signal(
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
    closed_price = case when p_outcome in ('expired', 'invalidated') then null else p_price end,
    closed_at = now(),
    r_multiple = case
      -- No measured outcome: not a win, not a loss, not a zero.
      when p_outcome in ('expired', 'invalidated') then null
      when s.entry is null or s.stop_loss is null or s.entry = s.stop_loss then null
      when p_outcome = 'be' then 0
      else (case when s.direction = 'long' then p_price - s.entry else s.entry - p_price end)
           / abs(s.entry - s.stop_loss)
    end
  where s.id = p_signal_id and s.result = 'pending';

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke execute on function public.close_signal(text, text, double precision) from public, anon, authenticated;
