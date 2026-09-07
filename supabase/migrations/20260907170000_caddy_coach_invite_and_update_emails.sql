-- Coach Invite vs Sign Up Welcome, plus the coach-update email and its throttle.
--
-- 1. The welcome template keys split. "Someone created an account FOR you" and "you signed
--    yourself up" are different events - a self-signup has no coach and already has a
--    password, so a shared template has to lie about one of them.
--
--      player_signup_basic   -> coach_invite_basic
--      player_signup_comped  -> coach_invite_comped
--      (new)                    player_signup_welcome
--      (new)                    coach_updated_account
--
-- 2. The throttle. coach_updated_account may reach a player once per 30 minutes; everything
--    inside the window is DROPPED, never queued. This needs its own tiny table rather than
--    riding on caddy_email_delivery_attempts: that table is an append-only log, so it can
--    only answer "has one been sent recently?" with a read, and a read-then-send leaves a
--    race where two saves a millisecond apart both pass. claim_caddy_email_throttle below
--    makes the check and the claim one atomic statement - the conflicting write is a no-op
--    inside the window, so exactly one caller is told to send.

-- ---------- 1. template keys ----------

alter table public.caddy_email_templates
  drop constraint if exists caddy_email_templates_template_key_check;

update public.caddy_email_templates set template_key = 'coach_invite_basic'  where template_key in ('player_welcome', 'player_signup_basic');
update public.caddy_email_templates set template_key = 'coach_invite_comped' where template_key = 'player_signup_comped';

alter table public.caddy_email_templates
  add constraint caddy_email_templates_template_key_check
  check (template_key in ('coach_invite_basic', 'coach_invite_comped', 'player_signup_welcome', 'coach_updated_account'));

-- The delivery log keeps its history under the old keys; only new rows use the new ones.
update public.caddy_email_delivery_attempts set template_key = 'coach_invite_basic'  where template_key in ('player_welcome', 'player_signup_basic');
update public.caddy_email_delivery_attempts set template_key = 'coach_invite_comped' where template_key = 'player_signup_comped';

-- ---------- 2. throttle ----------

create table if not exists public.caddy_email_throttle (
  recipient_email text not null,
  template_key text not null,
  sent_at timestamptz not null default now(),
  primary key (recipient_email, template_key)
);

alter table public.caddy_email_throttle enable row level security;
revoke all on public.caddy_email_throttle from anon, authenticated;

-- Returns true only to the caller that just claimed the window. The `where` on the conflict
-- branch is what makes it atomic: inside the window the update matches no row, nothing is
-- returned, and the caller is told not to send.
create or replace function public.claim_caddy_email_throttle(
  p_recipient_email text,
  p_template_key text,
  p_window_minutes integer
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claimed boolean;
begin
  insert into public.caddy_email_throttle as t (recipient_email, template_key, sent_at)
  values (lower(trim(p_recipient_email)), p_template_key, now())
  on conflict (recipient_email, template_key) do update
    set sent_at = now()
    where t.sent_at < now() - make_interval(mins => greatest(p_window_minutes, 0))
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

revoke all on function public.claim_caddy_email_throttle(text, text, integer) from public, anon, authenticated;
