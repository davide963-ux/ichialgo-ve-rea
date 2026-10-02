-- One entry, one stop, one target.
--
-- The three-rung ladder was structurally losing. The first rung sat at the
-- nearest opposing level — the likeliest place for price to turn — and
-- reaching it banked NOTHING; it only pulled the stop to breakeven. So the
-- commonest winner paid 0R while every loser paid −1R, and the system
-- profited only when price broke clean through the level it was aimed at.
-- Measured on a pure random walk it lost 0.14R per trade, where a system
-- gated at 1.2R should sit at zero.
--
-- One target removes the trap rather than compensating for it: the target is
-- a win worth its reward/risk, the stop is −1R, and there is no third outcome
-- that silently converts winners into scratches. `tp1_hit` and the breakeven
-- result go with it, since nothing can produce them any more.
--
-- The table is empty, so nothing is migrated.
alter table public.signals rename column take_profit1 to take_profit;
alter table public.signals drop column take_profit2;
alter table public.signals drop column take_profit3;
alter table public.signals drop column tp1_hit;

comment on column public.signals.take_profit is
  'The single take-profit level. Reaching it closes the trade as a win.';

-- 'tp' replaces tp1/tp2/tp3; 'be' can no longer occur.
alter table public.signals drop constraint if exists signals_result_check;
alter table public.signals add constraint signals_result_check
  check (result in ('pending', 'tp', 'sl', 'expired', 'invalidated'));

drop function if exists public.mark_breakeven(text);
