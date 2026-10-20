-- "Before you search, leave an email so we can tell you when a map is updated."
-- The course picker asks once per device, before the first typed search, and the player can
-- skip it (scripts/gd-course-search-email.js). Written by /api/course-map-contact
-- (functions/course-map-contact.mjs). One row per address; user_id is only filled in when a
-- signed-in player gave it. The address is used for nothing but map-update emails.
-- Service role is the only reader or writer.

create table if not exists public.course_map_update_contacts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.course_map_update_contacts enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.course_map_update_contacts to service_role;

drop policy if exists "service role can manage course map update contacts" on public.course_map_update_contacts;
create policy "service role can manage course map update contacts"
on public.course_map_update_contacts
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
