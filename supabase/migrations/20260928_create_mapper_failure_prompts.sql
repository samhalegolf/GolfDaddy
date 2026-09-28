-- The operator's prompt per kind of mapping failure, read by the mapper worker when it
-- hands a terminal failure to the Claude mapper-debug Routine (docs/CLAUDE_MAPPER_DEBUG_ROUTINE.md).
-- The kinds themselves live in functions/lib/gd-mapper-failure-kinds.mjs with a default
-- prompt each; a row here overrides the default for that kind. No row means the default.
-- Edited from Studio > Courses > Course Mapping > Claude Debug Prompts via
-- /api/course-mapper-prompts (admin only); service role is the only database reader.

create table if not exists public.mapper_failure_prompts (
  kind text primary key,
  prompt text not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.mapper_failure_prompts enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.mapper_failure_prompts to service_role;

drop policy if exists "service role can manage mapper failure prompts" on public.mapper_failure_prompts;
create policy "service role can manage mapper failure prompts"
on public.mapper_failure_prompts
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
