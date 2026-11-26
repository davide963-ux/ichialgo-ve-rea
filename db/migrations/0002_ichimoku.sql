-- Retire the EMA50-touch columns; store Ichimoku's own instead.
--
-- WHY THE OLD ROWS ARE KEPT AND THE OLD COLUMNS ARE NOT
-- ────────────────────────────────────────────────────
-- The strategy changed shape, not just parameters. There is no EMA and no
-- average true range any more, so `ema`, `atr` and `tolerance_pips` describe
-- a calculation the code can no longer perform, and `approach`, `trend`,
-- `bias` and `counter_trend` describe a direction rule that was WRONG — it
-- took the side price arrived from rather than the side of the cloud.
-- Carrying those columns forward would invite someone to read a number that
-- nothing can reproduce.
--
-- The rows themselves stay. `direction`, `entry`, `stop_loss`, `take_profit`
-- and `result_pips` still mean exactly what they meant: a ticket, and what
-- price did to it. Deleting that would be throwing away observations to tidy
-- a schema.
--
-- What makes keeping them safe is that nothing MIXES them with the new ones:
-- `recentSignals` and `signalStats` both filter on `strategy`, so the history
-- page's totals are about one strategy at a time. A row with
-- strategy = 'ema50-touch' is a record, not an input.
--
-- WHY 'nofill' STAYS IN THE CHECK CONSTRAINT
-- ──────────────────────────────────────────
-- The new strategy cannot produce one. Entry is the close of the signal bar,
-- which is a price that traded by definition, so there is no limit order to
-- miss. The value is left in the constraint because the legacy rows use it,
-- and a check that rejects data already in the table cannot be added.
alter table signals
  drop column if exists price,
  drop column if exists ema,
  drop column if exists atr,
  drop column if exists tolerance_pips,
  drop column if exists approach,
  drop column if exists outcome,
  drop column if exists trend,
  drop column if exists bias,
  drop column if exists counter_trend,
  drop column if exists ichimoku,
  drop column if exists ichimoku_score;

-- The lines, as they stood on the signal bar. Stored rather than recomputed:
-- re-deriving them later from a different candle window would quietly answer
-- a different question from the one asked at the time.
--
-- Nullable, because the legacy rows have no value for them and inventing one
-- would be worse than a null.
alter table signals
  add column if not exists kumo        text check (kumo in ('above', 'below')),
  add column if not exists kijun       double precision,
  add column if not exists tenkan      double precision,
  add column if not exists senkou_a    double precision,
  add column if not exists senkou_b    double precision,
  -- The 26-bar high-low range in pips: this strategy's unit of distance, and
  -- what the stop is a fraction of. Kijun is this range's midpoint, which is
  -- why no separate volatility measure is stored.
  add column if not exists range_pips  double precision,
  -- The four confirmations and their total. Kept individually as well as
  -- summed so the history can answer WHICH check failed, not only how many.
  add column if not exists score                smallint,
  add column if not exists cloud_bullish        boolean,
  add column if not exists future_cloud_bullish boolean,
  add column if not exists chikou_free          boolean,
  add column if not exists tenkan_agrees        boolean;

-- The history page and the scanner both work one strategy at a time now that
-- two of them share the table.
create index if not exists signals_strategy_bar_idx on signals (strategy, bar_time desc);
