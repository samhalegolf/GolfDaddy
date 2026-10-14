-- Per-layer counts for the Course Database list, so each row shows at a glance
-- which kinds of object a course's map has (tee, green, fairway shape, bunker,
-- water, hazard, trees) without opening it.
--
-- Same approach as 20261014_course_maps_stored_counts: the existing trigger
-- writes them when the geometry is written, and the view is a plain read.
-- fairway_area is the drawn fairway SHAPE; fairway_count stays the centreline
-- count it always was. hazard_count folds in waste areas.
--
-- Tree pins (Find Trees) live in course_trees, not objects_json, so a trigger
-- there writes course_maps.tree_count. Stored on the map row rather than joined
-- in the view, so course_trees' RLS can never zero it for a list reader.

alter table public.course_maps
  add column if not exists fairway_area_count integer not null default 0,
  add column if not exists bunker_count integer not null default 0,
  add column if not exists water_count integer not null default 0,
  add column if not exists hazard_count integer not null default 0,
  add column if not exists tree_count integer not null default 0;

create or replace function public.course_maps_sync_counts()
returns trigger
language plpgsql
as '
begin
  select count(*) into new.hole_count from jsonb_object_keys(coalesce(new.holes_json, ''{}''::jsonb));
  select count(*),
         count(*) filter (where e.value ->> ''type'' = ''tee''),
         count(*) filter (where e.value ->> ''type'' = ''green''),
         count(*) filter (where e.value ->> ''type'' = ''fairway''),
         count(*) filter (where e.value ->> ''type'' = ''fairway_area''),
         count(*) filter (where e.value ->> ''type'' = ''bunker''),
         count(*) filter (where e.value ->> ''type'' = ''water''),
         count(*) filter (where e.value ->> ''type'' in (''hazard'', ''waste''))
    into new.object_count, new.tee_count, new.green_count, new.fairway_count,
         new.fairway_area_count, new.bunker_count, new.water_count, new.hazard_count
    from jsonb_each(coalesce(new.objects_json, ''{}''::jsonb)) e(key, value);
  return new;
end;
';

update public.course_maps set id = id;

create or replace function public.course_trees_sync_map_count()
returns trigger
language plpgsql
as '
begin
  if tg_op = ''DELETE'' then
    update public.course_maps set tree_count = 0 where course_id = old.course_id;
    return old;
  end if;
  update public.course_maps
     set tree_count = case when jsonb_typeof(new.trees) = ''array'' then jsonb_array_length(new.trees) else 0 end
   where course_id = new.course_id;
  return new;
end;
';

drop trigger if exists course_trees_sync_map_count on public.course_trees;
create trigger course_trees_sync_map_count
  after insert or update of trees or delete on public.course_trees
  for each row execute function public.course_trees_sync_map_count();

update public.course_maps m
   set tree_count = case when jsonb_typeof(t.trees) = 'array' then jsonb_array_length(t.trees) else 0 end
  from public.course_trees t
 where t.course_id = m.course_id;

-- New columns go on the end: create or replace view may only append.
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
    m.facility_name,
    m.fairway_area_count,
    m.bunker_count,
    m.water_count,
    m.hazard_count,
    m.tree_count
   FROM public.course_maps m;

notify pgrst, 'reload schema';
