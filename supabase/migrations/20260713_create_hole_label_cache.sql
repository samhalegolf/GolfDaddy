-- Persistent cache for the OSM hole-labeler service (server/hole-labeler).
-- Applied to project zcevluithwoumvafhmct on 2026-07-13 via MCP.
create table if not exists public.hole_label_cache (
  cache_key text primary key,          -- "lat,lng" rounded to 4dp, matches service cache key
  result jsonb not null,               -- {labels, course_name, source_map_url, schematic_png_b64}
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.hole_label_cache is
  'Persistent cache for the OSM hole-labeler service (server/hole-labeler). One row per course center; labels never change, so rows are effectively permanent.';

alter table public.hole_label_cache enable row level security;
-- No policies: only the service role (used by the labeler service) can read/write.
