-- Facility organise, phase 1 (FACILITY_ORGANISE_PLAN_2026-10-01.md): every run's plan - what it
-- renamed, and what it would do next once an admin approves it (combinations, splits, courses
-- no card explains). Studio reads the latest run per facility. Service role only: the plan names
-- courses before anyone has agreed to them, so it is not public.
create table if not exists public.facility_organise_runs (
  id uuid primary key default gen_random_uuid(),
  facility_key text not null,
  plan jsonb not null default '{}'::jsonb,
  applied jsonb not null default '[]'::jsonb,
  requested_by text,
  created_at timestamptz not null default now()
);
create index if not exists facility_organise_runs_facility_idx on public.facility_organise_runs (facility_key, created_at desc);
alter table public.facility_organise_runs enable row level security;
