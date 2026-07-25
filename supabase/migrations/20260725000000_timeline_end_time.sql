-- Optional end time on a timeline entry, so an appointment or activity that spans a
-- range (not just a single moment) can record when it finished, not just when it started.
-- Stored the same way as `time` — a locale-formatted display string ("10:30 AM"), not a
-- sortable timestamp — since that's what the existing `time` column already does and the
-- app only ever parses these back client-side for display (see timeDisplayTo24h).

alter table public.timeline_entries add column end_time text;
