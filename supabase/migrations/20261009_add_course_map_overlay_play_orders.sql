-- Play orders: courses an admin builds by hand from the holes on the ground.
--
-- Billingbear Park is two nines, numbered 1-9 twice in OSM. The automatic split read it as one
-- course and published nine holes. Where the split gets it wrong, or names it badly, an admin now
-- says it outright in the Mapping Overlay: "+ New play order", name it, click its holes in the
-- order they are played. A hole may sit in several play orders (two 18s over the same three
-- nines), so a play order is a list of hole references, not a property of a hole.
--
-- Each entry: { id, name, courseId, holes: ["osm:way/123" | "link:l-abc", ...] }
--   osm:way/N   an OSM golf=hole line
--   link:ID     the overlay shapes linked as one hole (Studio's Link tool)
-- courseId is fixed when the play order is first saved and never changes after, so renaming a
-- play order renames its course without moving its rounds, visuals or watch maps.
--
-- When a ready overlay has play orders the mapper publishes exactly those, one course_maps row
-- each, instead of separating the site itself (functions/lib/gd-play-order-core.mjs).

alter table if exists public.course_map_overlays
  add column if not exists play_orders jsonb not null default '[]'::jsonb;

comment on column public.course_map_overlays.play_orders is
  'Hand-built courses: [{id, name, courseId, holes:["osm:way/N"|"link:ID", ...]}]. When the overlay is ready and this is not empty, the mapper publishes one course per play order instead of separating the site itself.';
