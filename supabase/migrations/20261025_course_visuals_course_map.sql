-- The course map (functions/lib/gd-course-surface-core.mjs): the whole course as one surface,
-- and the outline drawn round it in Studio's 3D Course Viewer.
--
-- course_boundary  {ring: [{lat, lng}], areaM2, savedBy, savedAt} - written by Studio through
--                  /api/course-map. Ground outside the ring is not the course.
-- course_surface   the built course map: picture, elevation and the mercator geometry that
--                  places them, shaped like a hole frame's playSurface - written by the visual
--                  worker's course_surface job.
--
-- Columns of their own, not keys inside uploaded_assets or course_overrides: every published
-- export upserts the row with those, and must not take the outline or the course map with it.
-- Both null until there is something to hold.
alter table public.course_visuals
  add column if not exists course_boundary jsonb,
  add column if not exists course_surface jsonb;
