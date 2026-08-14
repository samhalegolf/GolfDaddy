-- Practice email: stored addresses and verified senders.
--
-- The address used to be DERIVED - practice+<slugged profile uuid>@domain -
-- which made it thirty characters of hex nobody could read out, and meant it
-- could never be changed or revoked, because there was nothing to change. It is
-- stored now, so a player can be given a readable address and it can be turned
-- off if it ever leaks.
--
-- A readable address is a guessable address, so the security that used to come
-- from the address being unguessable has to become real: mail from a sender the
-- player has not approved is imported and FLAGGED, so the player can see who
-- sent it and approve them once or delete the import.

create extension if not exists pgcrypto;

create table if not exists public.practice_email_addresses (
  id uuid primary key default gen_random_uuid(),
  -- The full address exactly as the player is shown it, lower-cased.
  address text not null unique,
  -- The local part on its own, so a collision check does not have to parse.
  local_part text not null,
  player_key text not null,
  player_id text,
  account_id text,
  profile_id text,
  -- Inactive addresses stay in the table: the row is the record of what that
  -- address used to mean, and deleting it would make old mail unattributable.
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists practice_email_addresses_local_part_idx
on public.practice_email_addresses (local_part);

create index if not exists practice_email_addresses_player_key_idx
on public.practice_email_addresses (player_key);

create index if not exists practice_email_addresses_account_idx
on public.practice_email_addresses (account_id);

create table if not exists public.practice_email_senders (
  id uuid primary key default gen_random_uuid(),
  player_key text not null,
  -- Lower-cased sending address. One row per address a player has approved.
  sender_email text not null,
  -- How it came to be trusted: 'signup' for the account's own address, added
  -- automatically at allocation, or 'approved' when the player approved a
  -- sender whose import arrived flagged.
  source text not null default 'approved' check (source in ('signup', 'approved', 'admin')),
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists practice_email_senders_unique_idx
on public.practice_email_senders (player_key, sender_email);

-- Whether the sender was on the approved list when the mail arrived. The import
-- happens either way; this is what the flag in the app is drawn from, and what
-- approving a sender clears. The same answer is written into each batch's
-- metadata as senderVerified, because that is the row the lane renders.
alter table public.practice_email_intake_events
add column if not exists sender_verified boolean not null default false;

alter table public.practice_email_addresses enable row level security;
alter table public.practice_email_senders enable row level security;

grant select, insert, update, delete on public.practice_email_addresses to service_role;
grant select, insert, update, delete on public.practice_email_senders to service_role;

drop policy if exists "service role can manage practice email addresses" on public.practice_email_addresses;
create policy "service role can manage practice email addresses"
on public.practice_email_addresses
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service role can manage practice email senders" on public.practice_email_senders;
create policy "service role can manage practice email senders"
on public.practice_email_senders
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
