-- Durable job queue for server-side AutoMapper runs, mirroring course_visual_jobs'
-- shape (supabase/migrations/20260730_create_course_visual_jobs.sql) so the two pipelines
-- share one proven pattern (atomic claim-by-status-flip, per-course+kind dedupe, stale-job
-- reaping) while staying separate tables: geometry resolution and image rendering are
-- different responsibilities with different failure modes, and folding AutoMapper into
-- course_visual_jobs as a third `kind` would couple their status/dedupe/rate-limit rules
-- for no benefit (see the course-package migration plan's stage 2 rationale).
--
-- mapper_version is what gives "the same course at the same mapper version is not
-- reprocessed" real teeth: a job dedupe/freshness check compares this against the
-- geometry_version already stored on course_maps, not just recency, so bumping the mapper
-- algorithm can deliberately force every course to be remapped.

create table if not exists public.course_mapper_jobs (
  id uuid primary key default gen_random_uuid(),
  course_id text not null,
  kind text not null default 'automap',
  status text not null default 'queued',
  mapper_version text,
  result jsonb,
  error text,
  requested_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists course_mapper_jobs_course_id_idx
on public.course_mapper_jobs (course_id, created_at desc);

create index if not exists course_mapper_jobs_status_idx
on public.course_mapper_jobs (status, updated_at);

create index if not exists course_mapper_jobs_course_kind_status_idx
on public.course_mapper_jobs (course_id, kind, status, updated_at);

create index if not exists course_mapper_jobs_requested_by_idx
on public.course_mapper_jobs (requested_by, created_at);

alter table public.course_mapper_jobs enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.course_mapper_jobs to service_role;

drop policy if exists "service role can manage course mapper jobs" on public.course_mapper_jobs;
create policy "service role can manage course mapper jobs"
on public.course_mapper_jobs
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
