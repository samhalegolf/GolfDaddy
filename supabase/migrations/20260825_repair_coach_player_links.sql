-- Repair the coach <-> player links on app_accounts.
--
-- The relationship is stored twice, once on each side, and the two sides had
-- drifted:
--
--   * an account listed ITSELF in linked_player_ids, which put the coach in
--     their own Players list - tapping that row opened the coach's own profile,
--     which is the bug this migration accompanies;
--   * linked_player_ids held ids for accounts that no longer exist;
--   * five players carried linked_coach_ids pointing at a coach whose
--     linked_player_ids had never gained the matching entry, so they were
--     invisible in the roster;
--   * one player was in a coach's linked_player_ids with no reverse link.
--
-- The client and /api/coach-roster now read BOTH directions, so nothing depends
-- on this being clean any more - but leaving contradictory rows in place means
-- every future reader has to know the same trivia. This makes the two sides
-- agree, once.
--
-- Deliberately NOT in this migration: the duplicate app_profiles rows on
-- account acct_mq4k1ge6_5stlq. Those hold real bags and bubble profiles and
-- picking a winner is a judgement call, not a repair.

begin;

-- 1. Drop self-references. An account is never its own coach or its own player.
update app_accounts
set linked_player_ids = coalesce((
      select jsonb_agg(link_id) from jsonb_array_elements_text(linked_player_ids) as t(link_id)
      where link_id <> account_id
    ), '[]'::jsonb),
    updated_at = now()
where linked_player_ids ? account_id;

update app_accounts
set linked_coach_ids = coalesce((
      select jsonb_agg(link_id) from jsonb_array_elements_text(linked_coach_ids) as t(link_id)
      where link_id <> account_id
    ), '[]'::jsonb),
    updated_at = now()
where linked_coach_ids ? account_id;

-- 2. Drop ids that point at no account.
update app_accounts a
set linked_player_ids = coalesce((
      select jsonb_agg(link_id) from jsonb_array_elements_text(a.linked_player_ids) as t(link_id)
      where exists (select 1 from app_accounts b where b.account_id = link_id)
    ), '[]'::jsonb),
    updated_at = now()
where exists (
  select 1 from jsonb_array_elements_text(a.linked_player_ids) as t(link_id)
  where not exists (select 1 from app_accounts b where b.account_id = link_id)
);

update app_accounts a
set linked_coach_ids = coalesce((
      select jsonb_agg(link_id) from jsonb_array_elements_text(a.linked_coach_ids) as t(link_id)
      where exists (select 1 from app_accounts b where b.account_id = link_id)
    ), '[]'::jsonb),
    updated_at = now()
where exists (
  select 1 from jsonb_array_elements_text(a.linked_coach_ids) as t(link_id)
  where not exists (select 1 from app_accounts b where b.account_id = link_id)
);

-- 3. A link claimed by either side is a link. Make both sides say so.
with missing as (
  select c.account_id as coach_id, jsonb_agg(distinct p.account_id) as player_ids
  from app_accounts p,
       lateral jsonb_array_elements_text(coalesce(p.linked_coach_ids, '[]'::jsonb)) as x(cid)
  join app_accounts c on c.account_id = x.cid
  where p.account_id <> c.account_id
    and not (coalesce(c.linked_player_ids, '[]'::jsonb) ? p.account_id)
  group by c.account_id
)
update app_accounts a
set linked_player_ids = coalesce(a.linked_player_ids, '[]'::jsonb) || missing.player_ids,
    updated_at = now()
from missing
where a.account_id = missing.coach_id;

with missing as (
  select p.account_id as player_id, jsonb_agg(distinct c.account_id) as coach_ids
  from app_accounts c,
       lateral jsonb_array_elements_text(coalesce(c.linked_player_ids, '[]'::jsonb)) as x(pid)
  join app_accounts p on p.account_id = x.pid
  where c.account_id <> p.account_id
    and not (coalesce(p.linked_coach_ids, '[]'::jsonb) ? c.account_id)
  group by p.account_id
)
update app_accounts a
set linked_coach_ids = coalesce(a.linked_coach_ids, '[]'::jsonb) || missing.coach_ids,
    updated_at = now()
from missing
where a.account_id = missing.player_id;

commit;
