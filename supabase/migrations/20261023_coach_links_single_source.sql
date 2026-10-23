-- One place for coach <-> player links: app_accounts.linked_player_ids /
-- linked_coach_ids.
--
-- 20260905234029_canonical_players_identity.sql added a second store,
-- caddy_coach_player_assignments, written only by Admin > Users. Nothing else
-- read it: the coach roster, invites, invite codes, the Booking hand-off and
-- unlink all use the app_accounts arrays. So "Assign Sam Hale" saved, showed in
-- Admin, and never reached the coach's player list. Admin now writes the arrays
-- (functions/caddy-admin-users.js), and the second store goes.

-- 1. Carry any active assignment across before the table goes. Both directions,
--    as functions/auth-utils.js linkCoachToPlayer writes them.
update public.app_accounts c
set linked_player_ids = c.linked_player_ids || to_jsonb(p.account_id), updated_at = now()
from public.caddy_coach_player_assignments a
join public.caddy_players cp on cp.id = a.coach_player_id
join public.caddy_players p on p.id = a.player_id
where a.status = 'active' and c.account_id = cp.account_id and p.account_id is not null
  and p.account_id <> cp.account_id and not c.linked_player_ids ? p.account_id;

update public.app_accounts pa
set linked_coach_ids = pa.linked_coach_ids || to_jsonb(cp.account_id), updated_at = now()
from public.caddy_coach_player_assignments a
join public.caddy_players cp on cp.id = a.coach_player_id
join public.caddy_players p on p.id = a.player_id
where a.status = 'active' and pa.account_id = p.account_id and cp.account_id is not null
  and p.account_id <> cp.account_id and not pa.linked_coach_ids ? cp.account_id;

-- 2. Merge keeps the source's coach links by copying them onto the surviving
--    account, in the arrays instead of the dropped table.
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
  -- Preserve source coach links on the surviving account, both directions.
  if s.account_id is not null and t.account_id is not null and s.account_id <> t.account_id then
    update app_accounts set linked_player_ids = linked_player_ids || to_jsonb(t.account_id), updated_at=now()
     where linked_player_ids ? s.account_id and not linked_player_ids ? t.account_id and account_id <> t.account_id;
    get diagnostics v_rows = row_count; v_counts=v_counts||jsonb_build_object('coach_links',v_rows);
    update app_accounts ta set linked_coach_ids = (
        select coalesce(jsonb_agg(distinct x), '[]'::jsonb)
        from jsonb_array_elements_text(ta.linked_coach_ids || sa.linked_coach_ids) x where x <> t.account_id
      ), updated_at=now()
      from app_accounts sa where ta.account_id=t.account_id and sa.account_id=s.account_id;
  end if;
  insert into caddy_player_merge_aliases(source_player_id,canonical_player_id,source_profile_id,source_account_id,merged_by_auth_user_id)
  values(p_source,p_target,s.profile_id,s.account_id,p_actor)
  on conflict(source_player_id) do update set canonical_player_id=excluded.canonical_player_id, merged_by_auth_user_id=excluded.merged_by_auth_user_id, merged_at=now();
  update caddy_players set status='merged', merged_into_player_id=p_target, updated_at=now() where id=p_source;
  insert into caddy_player_merge_events(source_player_id,canonical_player_id,merged_by_auth_user_id,decisions,affected_counts)
  values(p_source,p_target,p_actor,coalesce(p_decisions,'{}'::jsonb),v_counts);
  return jsonb_build_object('ok',true,'source_player_id',p_source,'canonical_player_id',p_target,'affected_counts',v_counts);
end $$;

-- 3. The second store and its only writer.
drop function if exists public.caddy_set_coach_assignment(uuid,uuid,boolean,uuid);
drop table if exists public.caddy_coach_player_assignments;
