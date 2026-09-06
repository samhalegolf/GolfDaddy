-- Canonical Caddy player identities. Accounts and Auth remain optional edges.
create table if not exists public.caddy_players (
  id uuid primary key default gen_random_uuid(),
  display_name text not null default 'Player',
  normalized_email text,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  account_id text unique,
  profile_id text unique,
  bag_json jsonb not null default '[]'::jsonb,
  profile_json jsonb not null default '{}'::jsonb,
  bubble_json jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active','merged','archived')),
  merged_into_player_id uuid references public.caddy_players(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (normalized_email is null or normalized_email = lower(normalized_email))
);
create index if not exists caddy_players_unclaimed_email_idx
  on public.caddy_players (normalized_email) where auth_user_id is null and status = 'active' and normalized_email is not null;

create table if not exists public.caddy_coach_player_assignments (
  id uuid primary key default gen_random_uuid(),
  coach_player_id uuid not null references public.caddy_players(id),
  player_id uuid not null references public.caddy_players(id),
  status text not null default 'active' check (status in ('active','removed')),
  assigned_at timestamptz not null default now(),
  assigned_by_auth_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (coach_player_id <> player_id),
  unique (coach_player_id, player_id)
);
create index if not exists caddy_coach_assignments_player_idx on public.caddy_coach_player_assignments(player_id, status);

create table if not exists public.caddy_player_merge_aliases (
  id uuid primary key default gen_random_uuid(),
  source_player_id uuid not null unique references public.caddy_players(id),
  canonical_player_id uuid not null references public.caddy_players(id),
  source_profile_id text,
  source_account_id text,
  merged_by_auth_user_id uuid references auth.users(id) on delete set null,
  merged_at timestamptz not null default now(),
  check (source_player_id <> canonical_player_id)
);
create table if not exists public.caddy_player_merge_events (
  id uuid primary key default gen_random_uuid(),
  source_player_id uuid not null references public.caddy_players(id),
  canonical_player_id uuid not null references public.caddy_players(id),
  merged_by_auth_user_id uuid references auth.users(id) on delete set null,
  decisions jsonb not null default '{}'::jsonb,
  affected_counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Non-destructive initial identity backfill: one player per active app profile.
insert into public.caddy_players (display_name, normalized_email, auth_user_id, account_id, profile_id, bag_json, profile_json)
select p.name, nullif(lower(trim(p.email)), ''),
  case when a.profile_id = p.profile_id then p.auth_user_id else null end,
  case when a.profile_id = p.profile_id then p.account_id else null end,
  p.profile_id, p.bag_json, p.profile_json
from public.app_profiles p left join public.app_accounts a on a.profile_id = p.profile_id
on conflict (profile_id) do nothing;
update public.caddy_players cp
set bubble_json = b.model_json, updated_at = now()
from public.bubble_player_models b
where b.player_id = cp.profile_id and b.status = 'ready' and cp.bubble_json = '{}'::jsonb;

alter table public.caddy_players enable row level security;
alter table public.caddy_coach_player_assignments enable row level security;
alter table public.caddy_player_merge_aliases enable row level security;
alter table public.caddy_player_merge_events enable row level security;
revoke all on public.caddy_players, public.caddy_coach_player_assignments, public.caddy_player_merge_aliases, public.caddy_player_merge_events from anon, authenticated;

create or replace function public.caddy_claim_or_create_player(
  p_auth_user_id uuid, p_email text, p_name text, p_account_id text, p_profile_id text
) returns public.caddy_players language plpgsql security definer set search_path = public as $$
declare v_player public.caddy_players; v_candidate_count integer;
begin
  select * into v_player from caddy_players where auth_user_id = p_auth_user_id and status = 'active' for update;
  if found then return v_player; end if;
  select count(*) into v_candidate_count from caddy_players
    where normalized_email = lower(trim(p_email)) and auth_user_id is null and status = 'active';
  if v_candidate_count > 1 then raise exception 'Multiple unclaimed players match this email'; end if;
  select * into v_player from caddy_players where normalized_email = lower(trim(p_email)) and auth_user_id is null and status = 'active' for update;
  if found then
    update caddy_players set auth_user_id=p_auth_user_id, account_id=coalesce(account_id,p_account_id), profile_id=coalesce(profile_id,p_profile_id), updated_at=now() where id=v_player.id returning * into v_player;
    return v_player;
  end if;
  insert into caddy_players(display_name,normalized_email,auth_user_id,account_id,profile_id)
  values (coalesce(nullif(trim(p_name),''),'Player'),nullif(lower(trim(p_email)),''),p_auth_user_id,p_account_id,p_profile_id)
  returning * into v_player;
  return v_player;
end $$;

create or replace function public.caddy_set_coach_assignment(
  p_coach_player_id uuid, p_player_id uuid, p_active boolean, p_actor uuid
) returns public.caddy_coach_player_assignments language plpgsql security definer set search_path = public as $$
declare v_assignment public.caddy_coach_player_assignments;
begin
  if p_coach_player_id = p_player_id then raise exception 'A player cannot coach themselves'; end if;
  insert into caddy_coach_player_assignments(coach_player_id,player_id,status,assigned_by_auth_user_id)
  values(p_coach_player_id,p_player_id,case when p_active then 'active' else 'removed' end,p_actor)
  on conflict(coach_player_id,player_id) do update set status=excluded.status, assigned_by_auth_user_id=excluded.assigned_by_auth_user_id, updated_at=now()
  returning * into v_assignment;
  return v_assignment;
end $$;

create or replace function public.caddy_merge_preview(p_source uuid, p_target uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s caddy_players; t caddy_players;
begin
  if p_source=p_target then raise exception 'Cannot merge a player into themselves'; end if;
  select * into s from caddy_players where id=p_source;
  select * into t from caddy_players where id=p_target;
  if s.id is null or t.id is null or s.status <> 'active' or t.status <> 'active' then raise exception 'Both active players are required'; end if;
  return jsonb_build_object('source',to_jsonb(s),'target',to_jsonb(t),'warnings',jsonb_build_array(
    case when s.auth_user_id is not null and t.auth_user_id is not null then 'Both players have Auth logins; explicit high-risk confirmation required.' end,
    case when jsonb_array_length(s.bag_json)>0 and jsonb_array_length(t.bag_json)>0 then 'Both players have bags; choose explicitly unless one is generated.' end
  ) - 'null');
end $$;

create or replace function public.caddy_execute_player_merge(
  p_source uuid, p_target uuid, p_actor uuid, p_decisions jsonb default '{}'::jsonb, p_confirm_two_auth boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare s caddy_players; t caddy_players; v_counts jsonb := '{}'::jsonb; v_rows integer := 0;
begin
  if p_source=p_target then raise exception 'Cannot merge a player into themselves'; end if;
  select * into s from caddy_players where id=p_source for update;
  select * into t from caddy_players where id=p_target for update;
  if s.id is null or t.id is null or s.status <> 'active' or t.status <> 'active' then raise exception 'Both active players are required'; end if;
  if s.auth_user_id is not null and t.auth_user_id is not null and not p_confirm_two_auth then raise exception 'Two Auth logins require explicit confirmation'; end if;
  -- Conflict choices are explicit; neither a real bag nor Bubble is overwritten implicitly.
  if coalesce(p_decisions->>'bagChoice','target') = 'source' then
    update caddy_players set bag_json=s.bag_json, profile_json=s.profile_json, updated_at=now() where id=p_target;
  end if;
  if coalesce(p_decisions->>'bubbleChoice','target') = 'source' then
    update caddy_players set bubble_json=s.bubble_json, updated_at=now() where id=p_target;
  end if;
  -- Legacy ownership columns are text and mostly lack foreign keys. Repoint
  -- only the known Caddy data stores; Booking CRM tables are intentionally out
  -- of scope. Each update preserves all rows and is counted for the audit.
  if s.profile_id is not null and t.profile_id is not null then
    update public.bubble_player_models set player_id=t.profile_id, account_id=coalesce(t.account_id,account_id), updated_at=now() where player_id=s.profile_id; get diagnostics v_rows = row_count; v_counts=v_counts||jsonb_build_object('bubble_player_models',v_rows);
    update public.captured_surfaces set player_id=t.profile_id, account_id=coalesce(t.account_id,account_id), updated_at=now() where player_id=s.profile_id or account_id=s.account_id; get diagnostics v_rows = row_count; v_counts=v_counts||jsonb_build_object('captured_surfaces',v_rows);
    update public.shot_library_batches set player_id=t.profile_id, account_id=coalesce(t.account_id,account_id), updated_at=now() where player_id=s.profile_id or account_id=s.account_id; get diagnostics v_rows = row_count; v_counts=v_counts||jsonb_build_object('shot_library_batches',v_rows);
    update public.practice_import_batches set player_id=t.profile_id, profile_id=t.profile_id, account_id=coalesce(t.account_id,account_id), updated_at=now() where player_id=s.profile_id or profile_id=s.profile_id or account_id=s.account_id; get diagnostics v_rows = row_count; v_counts=v_counts||jsonb_build_object('practice_import_batches',v_rows);
    update public.practice_native_shots set player_id=t.profile_id, profile_id=t.profile_id, account_id=coalesce(t.account_id,account_id), updated_at=now() where player_id=s.profile_id or profile_id=s.profile_id or account_id=s.account_id; get diagnostics v_rows = row_count; v_counts=v_counts||jsonb_build_object('practice_native_shots',v_rows);
    update public.practice_email_addresses set player_id=t.profile_id, profile_id=t.profile_id, account_id=coalesce(t.account_id,account_id), updated_at=now() where player_id=s.profile_id or profile_id=s.profile_id or account_id=s.account_id; get diagnostics v_rows = row_count; v_counts=v_counts||jsonb_build_object('practice_email_addresses',v_rows);
    update public.practice_email_intake_events set profile_id=t.profile_id, account_id=coalesce(t.account_id,account_id), updated_at=now() where profile_id=s.profile_id or account_id=s.account_id; get diagnostics v_rows = row_count; v_counts=v_counts||jsonb_build_object('practice_email_intake_events',v_rows);
    update public.user_entitlements set user_id=coalesce(t.account_id,user_id), profile_id=t.profile_id, updated_at=now() where user_id=s.account_id or profile_id=s.profile_id; get diagnostics v_rows = row_count; v_counts=v_counts||jsonb_build_object('user_entitlements',v_rows);
    update public.video_transfer_sessions set player_id=t.profile_id, account_id=coalesce(t.account_id,account_id), updated_at=now() where player_id=s.profile_id or account_id=s.account_id; get diagnostics v_rows = row_count; v_counts=v_counts||jsonb_build_object('video_transfer_sessions',v_rows);
  end if;
  -- Preserve source coach relationships, deduplicated by the relational key.
  insert into caddy_coach_player_assignments(coach_player_id,player_id,status,assigned_at,assigned_by_auth_user_id)
  select coach_player_id, p_target, status, assigned_at, assigned_by_auth_user_id from caddy_coach_player_assignments
   where player_id=p_source and coach_player_id<>p_target
  on conflict(coach_player_id,player_id) do update set status='active', updated_at=now();
  delete from caddy_coach_player_assignments where player_id=p_source or coach_player_id=p_source;
  insert into caddy_player_merge_aliases(source_player_id,canonical_player_id,source_profile_id,source_account_id,merged_by_auth_user_id)
  values(p_source,p_target,s.profile_id,s.account_id,p_actor)
  on conflict(source_player_id) do update set canonical_player_id=excluded.canonical_player_id, merged_by_auth_user_id=excluded.merged_by_auth_user_id, merged_at=now();
  update caddy_players set status='merged', merged_into_player_id=p_target, updated_at=now() where id=p_source;
  insert into caddy_player_merge_events(source_player_id,canonical_player_id,merged_by_auth_user_id,decisions,affected_counts)
  values(p_source,p_target,p_actor,coalesce(p_decisions,'{}'::jsonb),v_counts);
  return jsonb_build_object('ok',true,'source_player_id',p_source,'canonical_player_id',p_target,'affected_counts',v_counts);
end $$;

revoke all on function public.caddy_claim_or_create_player(uuid,text,text,text,text), public.caddy_set_coach_assignment(uuid,uuid,boolean,uuid), public.caddy_merge_preview(uuid,uuid), public.caddy_execute_player_merge(uuid,uuid,uuid,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.caddy_claim_or_create_player(uuid,text,text,text,text), public.caddy_set_coach_assignment(uuid,uuid,boolean,uuid), public.caddy_merge_preview(uuid,uuid), public.caddy_execute_player_merge(uuid,uuid,uuid,jsonb,boolean) to service_role;
