-- Documents a table that has been live since the visual-engine server worker shipped
-- (functions/course-visual-jobs.mjs, functions/course-visual-worker-background.mjs,
-- functions/course-visual-sweeper.mjs) but never had a migration file. `create table if
-- not exists` is a no-op against the live table; this closes the gap so the schema is
-- reviewable instead of only inferable from application code.
--
-- Columns and indexes are read directly off the queries the code already issues:
--   courseBuildState()      course_visual_jobs.mjs:83-91   course_id + order by created_at desc
--   auto dedupe             course_visual_jobs.mjs:186     requested_by + created_at
--   one-live-job dedupe     course_visual_jobs.mjs:195     course_id + kind + status + updated_at
--   claimJob()              course-visual-worker-background.mjs:98-110  status=eq.queued, order by created_at asc
--   reapStaleJobs()         course-visual-worker-background.mjs:474-492  status=eq.running + updated_at

create table if not exists public.course_visual_jobs (
  id uuid primary key default gen_random_uuid(),
  course_id text not null,
  kind text not null default 'snapshot',
  status text not null default 'queued',
  recipe jsonb,
  result jsonb,
  error text,
  requested_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists course_visual_jobs_course_id_idx
on public.course_visual_jobs (course_id, created_at desc);

create index if not exists course_visual_jobs_status_idx
on public.course_visual_jobs (status, updated_at);

create index if not exists course_visual_jobs_course_kind_status_idx
on public.course_visual_jobs (course_id, kind, status, updated_at);

create index if not exists course_visual_jobs_requested_by_idx
on public.course_visual_jobs (requested_by, created_at);

alter table public.course_visual_jobs enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.course_visual_jobs to service_role;

drop policy if exists "service role can manage course visual jobs" on public.course_visual_jobs;
create policy "service role can manage course visual jobs"
on public.course_visual_jobs
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
