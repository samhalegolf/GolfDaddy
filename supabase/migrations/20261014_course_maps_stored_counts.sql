-- The counts course_maps_list used to compute on every read, stored on the row.
--
-- The view computed hole_count from holes_json and object/tee/green/fairway
-- counts by unpacking objects_json - 12 MB across 242 courses - for every row
-- on every call. Measured at 1.1 s warm, and past PostgREST's 8 s statement
-- timeout twice on 13 Oct 2026 (19:46 UTC) while the picker, course search
-- and the phone's library sync all read it. The counts only change when the
-- geometry does, so a trigger writes them once and the view is a plain read.
--
-- hole_count already existed, written by hand by whichever function published
-- the row; 30 courses published before it existed were null. The trigger owns
-- it now, so nothing writes it by hand any more and nothing is null.

alter table public.course_maps
  add column if not exists object_count integer,
  add column if not exists tee_count integer,
  add column if not exists green_count integer,
  add column if not exists fairway_count integer;

-- Single-quoted body rather than $$: the Supabase MCP connection this was
-- applied through never returned a $$-quoted CREATE FUNCTION. Same function.
create or replace function public.course_maps_sync_counts()
returns trigger
language plpgsql
as '
begin
  select count(*) into new.hole_count from jsonb_object_keys(coalesce(new.holes_json, ''{}''::jsonb));
  select count(*),
         count(*) filter (where e.value ->> ''type'' = ''tee''),
         count(*) filter (where e.value ->> ''type'' = ''green''),
         count(*) filter (where e.value ->> ''type'' = ''fairway'')
    into new.object_count, new.tee_count, new.green_count, new.fairway_count
    from jsonb_each(coalesce(new.objects_json, ''{}''::jsonb)) e(key, value);
  return new;
end;
';

drop trigger if exists course_maps_sync_counts on public.course_maps;
create trigger course_maps_sync_counts
  before insert or update on public.course_maps
  for each row execute function public.course_maps_sync_counts();

-- Backfill every row through the trigger. The no-op assignment changes nothing
-- itself; course_maps_bump_objects_revision sees the geometry unchanged and
-- leaves objects_revision alone.
update public.course_maps set id = id;

alter table public.course_maps
  alter column hole_count set not null,
  alter column hole_count set default 0,
  alter column object_count set not null,
  alter column object_count set default 0,
  alter column tee_count set not null,
  alter column tee_count set default 0,
  alter column green_count set not null,
  alter column green_count set default 0,
  alter column fairway_count set not null,
  alter column fairway_count set default 0;

-- Same columns in the same order as before, read straight off the row.
create or replace view public.course_maps_list with (security_invoker = on) as
 SELECT m.id,
    m.course_id,
    m.course_name,
    m.course_lat,
    m.course_lng,
    m.finder_lat,
    m.finder_lng,
    m.region,
    m.country,
    m.country_code,
    m.facility_key,
    m.course_aliases,
    m.published,
    m.published_at,
    m.created_at,
    m.updated_at,
    m.hole_count,
    m.object_count,
    m.tee_count,
    m.green_count,
    m.fairway_count,
    m.facility_name
   FROM public.course_maps m;

notify pgrst, 'reload schema';
