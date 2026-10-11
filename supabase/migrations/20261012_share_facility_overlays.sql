-- One overlay per facility.
--
-- The ground at a facility is shared, so its mapping overlay is too: it lives on the pinned
-- course (the row every sibling's facility_key names) and every course there reads and writes
-- that row (functions/lib/gd-overlay-owner.mjs). Before this, each course had its own, and a
-- course split off another - Foyle's 18 off its par 3 - opened an empty overlay while every
-- shape on its ground sat on the sibling's row.
--
-- This folds the overlay rows siblings already have into their facility's row:
--   no row on the owner yet   the sibling's row moves to the owner as it is (Te Arai North)
--   the owner has a row       the sibling's shapes and play orders are added to it - shapes
--                             the owner already has (same id) are kept, not doubled - and if
--                             that added anything it goes back to draft, since what it holds
--                             has not been signed off together. Foyle's 18 held six shapes the
--                             par 3's row already had, so Foyle just loses the duplicate row.
-- The owner's AI scan state and course map win; the sibling's fill in only where the owner
-- has none. Only siblings whose facility row exists in course_maps are touched.

with sibling as (
  select o.*, m.facility_key as owner_id
  from public.course_map_overlays o
  join public.course_maps m on m.course_id = o.course_id
  where m.facility_key is not null
    and m.facility_key <> o.course_id
    and exists (select 1 from public.course_maps f where f.course_id = m.facility_key)
),
moved as (
  update public.course_map_overlays o
  set course_id = s.owner_id
  from sibling s
  where o.course_id = s.course_id
    and not exists (select 1 from public.course_map_overlays x where x.course_id = s.owner_id)
  returning o.course_id
),
added as (
  select s.course_id, s.owner_id, s.play_orders, s.ai_scan, s.course_map,
    coalesce((
      select jsonb_agg(f)
      from jsonb_array_elements(coalesce(s.features, '[]'::jsonb)) f
      where not exists (
        select 1 from public.course_map_overlays owner, jsonb_array_elements(coalesce(owner.features, '[]'::jsonb)) g
        where owner.course_id = s.owner_id and g->>'id' = f->>'id'
      )
    ), '[]'::jsonb) as features
  from sibling s
  where s.course_id not in (select course_id from moved)
)
update public.course_map_overlays owner
set features = coalesce(owner.features, '[]'::jsonb) || a.features,
    play_orders = coalesce(owner.play_orders, '[]'::jsonb) || coalesce(a.play_orders, '[]'::jsonb),
    ai_scan = coalesce(owner.ai_scan, a.ai_scan),
    course_map = coalesce(owner.course_map, a.course_map),
    status = case when jsonb_array_length(a.features) > 0 or jsonb_array_length(coalesce(a.play_orders, '[]'::jsonb)) > 0
                  then 'draft' else owner.status end,
    updated_at = now()
from added a
where owner.course_id = a.owner_id;

delete from public.course_map_overlays o
using public.course_maps m
where m.course_id = o.course_id
  and m.facility_key is not null
  and m.facility_key <> o.course_id
  and exists (select 1 from public.course_map_overlays x where x.course_id = m.facility_key);
