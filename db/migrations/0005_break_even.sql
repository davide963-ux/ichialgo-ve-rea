-- The stop moves to break-even once a trade is far enough in profit.
--
-- TWO THINGS THIS NEEDS FROM THE TABLE
--
-- 1. `break_even`: the price at which the stop jumps to the entry. It is
--    stored rather than recomputed because it is part of the TICKET — the
--    levels the trade was actually taken with. Recomputing it from the
--    config at read time would silently re-decide old trades every time the
--    config changed, which is the same reason stop_loss and take_profit are
--    columns rather than formulas.
--
-- 2. 'be' as a result. A trade scratched at break-even and a trade stopped
--    out for the full risk are different outcomes, and the whole point of
--    the rule is the difference between them. Both come out slightly
--    negative in pips once the spread is paid, so a pip total cannot tell
--    them apart and the question "how many losses did this avoid" would be
--    unanswerable from the stored history.
--
-- Existing rows keep a null break_even, which reads as "this trade ran
-- without the rule" — true, and better than back-filling a price the trade
-- was never taken with.

alter table signals
  add column if not exists break_even double precision;

alter table signals
  drop constraint if exists signals_result_check;

alter table signals
  add constraint signals_result_check
  check (result in ('open', 'tp', 'sl', 'be', 'nofill', 'expired'));
