-- Shared cache of scorecards resolved from club websites.
--
-- Resolving a scorecard means fetching and parsing a club's own site, which is
-- slow, fragile, and identical for every player at that course. Caching it in
-- localStorage per device meant every player paid that cost once, and paid it
-- again on every reinstall. This table makes the resolve happen once globally.
--
-- Rows are written by /api/scorecard-store on behalf of an authenticated user
-- and read by anyone, so quality is enforced at write time (see the function):
-- a row only replaces an existing one when it carries at least as much usable
-- data, which stops a thin parse overwriting a complete one.

create table if not exists public.course_scorecards (
  course_key text primary key,
  course_name text not null default '',
  source text not null default '',
  provider text not null default '',
  source_url text not null default '',
  hole_count integer not null default 0,
  -- How many holes carry a usable distance. This is the quality score that
  -- decides whether an incoming scorecard is allowed to replace this row.
  distance_count integer not null default 0,
  holes_json jsonb not null default '[]'::jsonb,
  -- Every source the resolver read, kept so a later parse improvement can be
  -- re-derived without re-fetching the club site.
  sources_json jsonb not null default '[]'::jsonb,
  resolved_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists course_scorecards_updated_idx
on public.course_scorecards (updated_at desc);

alter table public.course_scorecards enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.course_scorecards to service_role;

-- No anon or authenticated policy: the table is reached only through
-- /api/scorecard-store, which holds the service key and applies the quality
-- gate. Direct client writes would bypass that gate entirely.
drop policy if exists "service role can manage course scorecards" on public.course_scorecards;
create policy "service role can manage course scorecards"
on public.course_scorecards
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
