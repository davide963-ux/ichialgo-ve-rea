-- Collapse the three selectable strategies into the one Ichimoku system.
--
-- WHY THE OLD ROWS KEEP THEIR OLD NAMES
-- ─────────────────────────────────────
-- The obvious move is `update signals set strategy = 'ichimoku'` so the
-- history page keeps showing its rows. That would be a lie, and an expensive
-- one, because it would put rows from four different rule sets under one
-- label and then average them into a single net-pips figure.
--
-- The 'oanda-pullback' and 'oanda-breakout' rows are the closest: their ENTRY
-- rules are the ones the unified system now runs. But their stops were a
-- fraction of the 26-bar range, and the unified system places stops on
-- STRUCTURE — beyond Kijun for a pullback, beyond the far cloud edge for a
-- breakout. Same entries, different risk, therefore different outcomes. Their
-- recorded result and result_pips answer a question nobody is asking any
-- more, so they stay where they are, under the name of the rule that produced
-- them. Reads filter on the live id (see STRATEGIES in server/db.mjs), which
-- means the history starts again from the next scan rather than inheriting a
-- record it did not earn.
--
-- Nothing is deleted. Every row is a real observation of a real bar and may
-- be worth re-reading later; what it must not do is contribute to a total
-- that claims to describe the strategy now running.

-- Which of the two entries fired. The system produces both from one pass, and
-- they are not interchangeable: the pullback risks roughly a third of what
-- the breakout does, so a result read without knowing which entry it came
-- from cannot be interpreted at all.
alter table signals
  add column if not exists entry_type text;

-- Knowable for the two retired OANDA rows from their strategy id alone, so it
-- costs nothing to fill in and makes them comparable as ENTRIES even though
-- their exits are not comparable.
update signals set entry_type = 'pullback'
where entry_type is null and strategy = 'oanda-pullback';

update signals set entry_type = 'breakout'
where entry_type is null and strategy = 'oanda-breakout';

-- The history page reads by strategy and orders by bar time; with four ids in
-- the table and only one of them live, that filter is now selective enough to
-- be worth an index.
create index if not exists signals_strategy_bar_time_idx
  on signals (strategy, bar_time desc);
