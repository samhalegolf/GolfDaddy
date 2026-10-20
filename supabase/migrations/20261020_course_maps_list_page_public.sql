-- page_public on the picker's list view, so a course search can say which results have a
-- public course page (/courses/<course_id>) to link to. Appended: create or replace view may
-- only add columns on the end.

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
    m.tree_count,
    m.page_public
   FROM public.course_maps m;

notify pgrst, 'reload schema';
