-- Town/country for published course maps.
--
-- The picker shows "Auckland, New Zealand" under a course name so a player can
-- tell two clubs with the same name apart. Search results carry that from the
-- geocoder, but a course already in the database had nowhere to keep it, so a
-- saved course showed a blank subtitle while a search result showed a full one.
--
-- Nullable on purpose: a course published before this migration has no place
-- until the backfill reaches it, and "not yet known" is a real state the UI
-- handles by showing nothing rather than a guess.
--
-- country_code (ISO 3166-1 alpha-2) is stored alongside the display name
-- because the name varies by geocoder language and is not a safe key.

alter table public.course_maps
  add column if not exists locality text,
  add column if not exists country text,
  add column if not exists country_code text;

-- Finds the rows the backfill still has to visit without scanning the table.
create index if not exists course_maps_country_missing_idx
on public.course_maps (updated_at desc)
where country_code is null;
