-- Admin-configurable content only. gd-email-templates-core.js remains the sole
-- owner of the Clarity email shell and performs the final escaping/rendering.
create table if not exists public.caddy_email_templates (
  template_key text primary key,
  content_json jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by_auth_user_id uuid references auth.users(id) on delete set null,
  check (template_key = 'player_welcome')
);

create table if not exists public.caddy_email_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  player_id uuid references public.caddy_players(id) on delete set null,
  recipient_email text not null,
  template_key text not null,
  sent_at timestamptz not null default now(),
  sent_by_auth_user_id uuid references auth.users(id) on delete set null,
  provider_message_id text,
  status text not null check (status in ('sent', 'failed')),
  failure_detail text
);
create index if not exists caddy_email_delivery_attempts_player_template_idx
  on public.caddy_email_delivery_attempts (player_id, template_key, sent_at desc);

alter table public.caddy_email_templates enable row level security;
alter table public.caddy_email_delivery_attempts enable row level security;
revoke all on public.caddy_email_templates, public.caddy_email_delivery_attempts from anon, authenticated;
