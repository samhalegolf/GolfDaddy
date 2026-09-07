-- Two Studio-managed welcome templates instead of one.
--
-- The original table shipped with CHECK (template_key = 'player_welcome') - a single editable
-- welcome email. Signup now picks between Basic Sign Up and Comped Sign Up by what actually
-- happened to the player's entitlement, so the same table has to hold both. They are two
-- independent rows on purpose: the comped email is a different message with a different
-- promise, not the basic one with a paragraph bolted on, and they are expected to diverge.
--
-- Nothing new is created. Storage, RLS and the delivery log are exactly as they were;
-- gd-email-templates-core.js still owns the shell, the escaping and the final HTML, and a
-- missing row still falls back to the code-level defaults.

alter table public.caddy_email_templates
  drop constraint if exists caddy_email_templates_template_key_check;

alter table public.caddy_email_templates
  add constraint caddy_email_templates_template_key_check
  check (template_key in ('player_welcome', 'player_signup_basic', 'player_signup_comped'));

-- Whatever an admin had already written under 'player_welcome' IS the basic welcome email.
-- Carry it across rather than dropping them back to the shipped default. Comped starts from
-- the code default and is written the first time someone saves it in Studio.
insert into public.caddy_email_templates (template_key, content_json, updated_at, updated_by_auth_user_id)
select 'player_signup_basic', content_json, updated_at, updated_by_auth_user_id
from public.caddy_email_templates
where template_key = 'player_welcome'
on conflict (template_key) do nothing;
