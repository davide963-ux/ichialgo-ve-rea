-- The break-even stop locks in a pip instead of landing on the entry.
--
-- A stop resting exactly on the entry price gives the spread back every time
-- it is hit, and this rule scratches most of the trades it touches — so the
-- commonest outcome of the whole strategy was "lose the spread". Moving the
-- stop a pip the profitable side instead makes that outcome cost nothing.
--
-- `break_even` already held the price that TRIGGERS the move. This adds the
-- price the stop moves TO. Both are part of the ticket the trade was taken
-- with, so both are stored rather than recomputed: a config change must not
-- retroactively re-decide a trade that is already running.
--
-- Rows written before this keep a null break_even_stop. The resolver treats
-- a half-specified rule as no rule at all rather than guessing a
-- destination, so those trades run to their original stop or target — which
-- is how they were taken.

alter table signals
  add column if not exists break_even_stop double precision;
