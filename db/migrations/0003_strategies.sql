-- Make the signal table hold more than one strategy's conditions.
--
-- WHY THE FOUR BOOLEANS HAD TO GO
-- ───────────────────────────────
-- 0002 added cloud_bullish, future_cloud_bullish, chikou_free and
-- tenkan_agrees, because there was one strategy with exactly those four
-- confirmations. There are now three, and they do not share a set:
--
--   ichimoku-kijun   ours: cloud colour, forward cloud, Chikou, Tenkan.
--   oanda-pullback   OANDA's: price vs cloud, Tenkan vs Kijun, a pullback
--                    that reached a line, and a confirming close on a candle
--                    of the trade's colour. Only ONE of those four overlaps
--                    with ours, and the article does not use Chikou here at
--                    all.
--   oanda-breakout   OANDA's: the break, the span twist, Chikou against the
--                    prior 26-period CLOSE (not its high or low, which is
--                    what ours compares), and a cloud-thickness grade that is
--                    explicitly not a gate.
--
-- Keeping named columns would mean a union of every condition any strategy
-- might ever have, almost all null on any given row, and a reader with no way
-- to tell "this check failed" from "this strategy does not have that check".
-- So the conditions are stored as the list each detector actually produced.
--
-- `checks` holds [{label, pass, detail, required}]. `score` stays — it is
-- worth indexing and grouping on — and `checks_total` joins it, because a
-- 3/3 and a 3/5 are not the same statement and a bare score cannot say which.
alter table signals
  drop column if exists cloud_bullish,
  drop column if exists future_cloud_bullish,
  drop column if exists chikou_free,
  drop column if exists tenkan_agrees;

alter table signals
  add column if not exists checks       jsonb,
  add column if not exists checks_total smallint,
  -- The cloud 26 bars ahead, as computed at the signal bar. Both OANDA
  -- strategies read it: the breakout requires the span twist, and the forward
  -- cloud is what their support/resistance zones are drawn from.
  add column if not exists senkou_ahead_a double precision,
  add column if not exists senkou_ahead_b double precision,
  -- |Senkou A − Senkou B| in pips. OANDA: "price breakouts and breakdowns
  -- through a thick Cloud are considered more significant."
  add column if not exists cloud_pips     double precision;

-- Rows from before this migration have a score out of four by construction:
-- only one strategy existed and it had four confirmations. Backfilling is
-- safe in a way that guessing their individual checks would not be, so the
-- total is restored and the checks are left null rather than invented.
update signals set checks_total = 4
where checks_total is null and strategy = 'ichimoku-kijun' and score is not null;
