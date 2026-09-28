-- The club's own course map for a course, stored with its overlay. A small schematic
-- (Studio scales it to 1200px on the long side, JPEG) the AI scan sends to the model as a
-- second image, to settle doubts - which corridor is the fairway, whether a mown patch is a
-- green - never as a source of coordinates. functions/course-map-overlay.mjs writes it,
-- functions/course-map-ai-scan-background.mjs reads it.
--
-- Shape: { "mediaType", "data" (base64), "name", "width", "height", "savedAt" }. Null = none.

alter table if exists public.course_map_overlays
  add column if not exists course_map jsonb;

comment on column public.course_map_overlays.course_map is
  'The club''s course map (schematic image) the AI scan sends as its second image. Null = none.';
