-- A real publish counter for baked course visuals, and the geometry revision each bake
-- was made from.
--
-- course_visuals.published_version was NOT a counter. course-visual-worker-background.mjs
-- computed it as the digits scraped out of the export content hash:
--
--     parseInt(String(framesIndex.exportVersion || "v1").replace(/[^0-9]/g, ""), 10)
--     "r1alw6nz" -> 1,  "rq3mud4" -> 34,  and in production: akarana 1977, jacks-point 908
--
-- Two things were broken by that. It cannot be shown to anyone ("Akarana v1977" is not a
-- version), and because the freshness rule in app/js/course-versions.js is `remote >
-- local`, a re-bake whose hash happened to scrape a SMALLER number read as "not newer" -
-- the frame-update prompt silently never fired for that course.
--
-- published_version is left exactly as it is. Nothing that reads it changes meaning, and
-- the wrong numbers stay put as the record of what was there; the honest counter is a new
-- column beside it. The content hash remains the build id (diagnostics.framesIndexPath /
-- the frames/<hash>/ storage prefix) - it identifies the BUILD, which is what a hash is
-- good for. bake_number identifies the PUBLICATION, which is what a human reads.
--
-- bake_objects_revision is the course_maps.objects_revision the bake was made from. It is
-- what lets the displayed minor number reset on a re-bake: minor = the course's current
-- objects_revision minus this. It is also why a hole image can honestly say it is v1.2
-- while the course has already moved to v1.3 - the picture was baked from older geometry,
-- and that difference is exactly the thing worth being able to see.

alter table public.course_visuals
  add column if not exists bake_number integer not null default 0,
  add column if not exists bake_objects_revision integer;

-- Every course with frames published today becomes bake 1. There is no bake history to
-- recover - published_version never counted - so numbering restarts here rather than
-- inheriting a number that never meant anything.
update public.course_visuals
   set bake_number = 1
 where bake_number = 0
   and coalesce(published_version, 0) > 0;

-- Those bakes are treated as having been made from the geometry the course holds now.
-- It is the only defensible answer: revision 1 is where 20260918_add_course_map_objects_revision
-- started every existing course, so "baked from revision 1" and "course is at revision 1"
-- agree, and the existing library reads v1.0 rather than a fabricated v1.1.
update public.course_visuals v
   set bake_objects_revision = m.objects_revision
  from public.course_maps m
 where m.course_id = v.course_id
   and v.bake_objects_revision is null;
