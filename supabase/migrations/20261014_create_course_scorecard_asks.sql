-- "Ask AI for this card": one row per course, the state of the last ask. Studio's Add
-- scorecard panel queues an ask through /api/course-scorecard-ask, the background function
-- asks Claude (with web search) for the course's pars and lengths and writes the answer back
-- here as the tab-separated text the scorecard paste box takes, and Studio polls the same
-- endpoint and drops that text into the paste box - nothing is stored as a scorecard until
-- the operator presses Import. Service role is the only database reader.

create table if not exists public.course_scorecard_asks (
  course_id text primary key,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  requested_at timestamptz not null default now(),
  requested_by text,
  started_at timestamptz,
  finished_at timestamptz,
  card_text text,
  unit text,
  source text,
  confidence text,
  notes text,
  error text,
  model text,
  usage jsonb
);

alter table public.course_scorecard_asks enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.course_scorecard_asks to service_role;

drop policy if exists "service role can manage scorecard asks" on public.course_scorecard_asks;
create policy "service role can manage scorecard asks"
on public.course_scorecard_asks
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
