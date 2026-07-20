-- Client error telemetry.
--
-- Errors were captured in memory by clarity-support.js and only ever
-- transmitted if a user manually filed a support ticket, so a failure nobody
-- reported was invisible. Four bugs found in one day - a CORS block that fell
-- back to local accounts, a blank screen, a swallowed ReferenceError in password
-- reset, and a pull path that was never called - all failed silently and none
-- would have produced a ticket.
--
-- Rows are deduplicated by fingerprint rather than appended, so a bug firing in
-- a loop becomes one row with a high count instead of thousands of rows. That
-- keeps the table small enough to read at a glance and makes frequency the
-- signal rather than volume.

create extension if not exists pgcrypto;

create table if not exists public.client_error_events (
  id uuid primary key default gen_random_uuid(),
  -- source + normalised message + platform + version. Stable across occurrences
  -- of the same bug, different for genuinely different bugs.
  fingerprint text not null,
  source text not null,
  level text not null default 'error',
  message text not null,
  detail text,
  count integer not null default 1,
  platform text,
  app_version text,
  route text,
  account_id text,
  user_agent text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists client_error_events_fingerprint_unique
on public.client_error_events (fingerprint);

-- The two questions actually asked of this table: what is happening now, and
-- what is happening most.
create index if not exists client_error_events_last_seen_idx
on public.client_error_events (last_seen_at desc);

create index if not exists client_error_events_count_idx
on public.client_error_events (count desc, last_seen_at desc);

create index if not exists client_error_events_platform_idx
on public.client_error_events (platform, last_seen_at desc)
where platform is not null;

alter table public.client_error_events enable row level security;

grant select, insert, update, delete on public.client_error_events to service_role;

-- Service role only. The reporting endpoint writes with the service key; no
-- client ever reads this table, and an anon-readable error log would leak
-- internal paths and account ids.
drop policy if exists "service role can manage client error events" on public.client_error_events;
create policy "service role can manage client error events"
on public.client_error_events
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
