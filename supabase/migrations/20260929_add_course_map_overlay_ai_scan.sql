-- AI scan state for the mapping overlay (functions/course-map-ai-scan.mjs and its
-- background half). A scan is asked for by the sync endpoint, which stores the request here
-- and pings the background function; the background function runs the model and writes the
-- outcome here. Studio polls this column through GET /api/course-map-overlay.
--
-- Shape while running:
--   { "status": "queued" | "running", "requestedAt", "requestedBy",
--     "georef": {...}, "image": { "mediaType", "data" (base64) }, "append": true, "notes": "" }
-- Shape when done:
--   { "status": "done" | "failed", "requestedAt", "finishedAt", "model", "usage": {...},
--     "summary": { fairways, greens, ... }, "dropped": [{index, reason}], "notes": "...",
--     "error": "..." }
-- The image is cleared when the scan finishes, so the column carries a picture only for
-- the minute or two a scan takes.
--
-- On the overlay row rather than a jobs table because there is exactly one scan in flight
-- per course at a time, its result IS the overlay, and a course with no overlay yet needs a
-- row to poll before any shape exists.

alter table if exists public.course_map_overlays
  add column if not exists ai_scan jsonb;

comment on column public.course_map_overlays.ai_scan is
  'AI scan of a satellite picture: request while queued/running (with the image), outcome when done/failed. Null = never scanned.';
