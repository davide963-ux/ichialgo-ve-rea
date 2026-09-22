-- "Impulse origin" is one strategy's vocabulary; "anchor" is the job.
--
-- The lifecycle tracker uses this value for exactly one purpose: telling
-- "the same setup, still developing" apart from "a new setup in the same
-- direction". A strategy built on impulse legs sets it to where the leg
-- began; one built on ranges or sessions sets it to something else entirely.
-- The column should be named after what the tracker does with it, not after
-- how the first strategy happened to compute it.
alter table public.setup_state rename column impulse_origin to anchor;

comment on column public.setup_state.anchor is
  'Strategy-defined identity of the setup. A different value means a different setup, not an update to this one.';
