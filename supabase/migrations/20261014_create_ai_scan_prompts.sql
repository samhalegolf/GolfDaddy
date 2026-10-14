-- The operator's words for each AI help task on the Mapping Overlay page (Studio > Courses >
-- Mapping Overlay > AI help). The tasks themselves - find greens, trace outlines, shape my
-- pins, refit, custom - live in functions/lib/gd-ai-scan-core.mjs with a default prompt and a
-- default answer shape (pins or outlines) each; a row here overrides both for that task. No
-- row means the defaults. Written through /api/course-map-ai-prompts (admin only); the scan
-- background function reads it when a request names a task without carrying its words.
-- Service role is the only database reader.

create table if not exists public.ai_scan_prompts (
  task_id text primary key,
  prompt text not null,
  output text not null default 'outlines' check (output in ('pins', 'outlines')),
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.ai_scan_prompts enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.ai_scan_prompts to service_role;

drop policy if exists "service role can manage ai scan prompts" on public.ai_scan_prompts;
create policy "service role can manage ai scan prompts"
on public.ai_scan_prompts
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
