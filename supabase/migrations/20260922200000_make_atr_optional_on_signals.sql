-- ATR is one indicator's opinion, not a property every strategy has.
--
-- `atr` and `stop_distance_atr` were made mandatory by the strategy that
-- happened to be running when this table was created. A strategy that sizes
-- stops from structure, a fixed distance or a percentage has no ATR to
-- report, and should not have to invent one to record a signal.
--
-- Both columns stay: a strategy that DOES use ATR still writes them, and
-- normalised distances remain the best way to compare setups across pairs.
-- They are simply no longer required. The table is empty, so nothing is
-- backfilled.
alter table public.signals alter column atr drop not null;

comment on column public.signals.atr is
  'ATR at the signal bar, when the strategy uses ATR. Null otherwise.';
comment on column public.signals.stop_distance_atr is
  'Stop distance in ATR multiples, when the strategy uses ATR. Null otherwise.';
