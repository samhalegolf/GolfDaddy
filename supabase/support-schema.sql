create extension if not exists pgcrypto;

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  status text not null default 'new',
  source text not null default 'clarity-caddie-web',
  happened text not null,
  expected text,
  contact text,
  context jsonb not null default '{}'::jsonb
);

alter table public.support_tickets enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.support_tickets to service_role;

create policy "service role can manage support tickets"
on public.support_tickets
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
