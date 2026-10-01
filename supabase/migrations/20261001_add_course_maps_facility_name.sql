-- The parent a multi-course facility's courses are listed under: "Millbrook Golf Resort",
-- with Remarkables, Coronet and Arrowtown beneath it. facility_key already groups the rows
-- (it is the pinned course's id); facility_name is what the group is called, so the picker
-- no longer has to guess it from the words the course names happen to share.
-- Stamped by the mapper worker on every course one scan publishes. Null for a single course.
alter table public.course_maps add column if not exists facility_name text;

-- The picker's list read (functions/course-maps.mjs LIST_COLUMNS) goes through this view.
-- Recreated as it stands in the database, with facility_name appended at the end.
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
    COALESCE(jsonb_array_length(jsonb_path_query_array(m.holes_json, '$.keyvalue()'::jsonpath)), 0) AS hole_count,
    o.object_count::integer AS object_count,
    o.tee_count::integer AS tee_count,
    o.green_count::integer AS green_count,
    o.fairway_count::integer AS fairway_count,
    m.facility_name
   FROM course_maps m
     LEFT JOIN LATERAL ( SELECT count(*) AS object_count,
            count(*) FILTER (WHERE (e.value ->> 'type'::text) = 'tee'::text) AS tee_count,
            count(*) FILTER (WHERE (e.value ->> 'type'::text) = 'green'::text) AS green_count,
            count(*) FILTER (WHERE (e.value ->> 'type'::text) = 'fairway'::text) AS fairway_count
           FROM jsonb_each(COALESCE(m.objects_json, '{}'::jsonb)) e(key, value)) o ON true;
