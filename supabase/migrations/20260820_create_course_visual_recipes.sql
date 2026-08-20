create table if not exists public.course_visual_recipes (
  id text primary key,
  name text not null,
  preset_id text not null default 'clarity-course-natural-v1',
  course_overrides jsonb not null default '{}'::jsonb,
  sample_course_id text,
  sample_hole_number integer,
  is_active boolean not null default false,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists course_visual_recipes_name_idx
on public.course_visual_recipes (name);

create unique index if not exists course_visual_recipes_active_idx
on public.course_visual_recipes (is_active)
where is_active = true;

create index if not exists course_visual_recipes_updated_at_idx
on public.course_visual_recipes (updated_at desc);

alter table public.course_visual_recipes enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.course_visual_recipes to service_role;

drop policy if exists "service role can manage course visual recipes" on public.course_visual_recipes;
create policy "service role can manage course visual recipes"
on public.course_visual_recipes
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
