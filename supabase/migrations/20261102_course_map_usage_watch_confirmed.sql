-- Watch deliveries: count the watch confirming a map, not only the phone sending it.
--
-- Until now a watch "download" meant the phone had handed the map over, which is
-- not proof it landed: a Garmin that is switched off or out of range looked the
-- same as one that took it. App builds from November 2026 also count:
--
--   delivery-confirmed  - the watch's own inventory report said it holds every
--                         hole of the package the phone handed it this session
--
-- and give a delivery-failed a more exact reason (handover-failed, watch-offline,
-- watch-app-missing, too-large, watch-memory, transfer-failed). Outcomes need no
-- change here: the outcome check already accepts any short lower-case slug.
--
-- Still anonymous and aggregate-only, exactly as 20261022_course_map_usage_detail.sql:
-- a daily tally per course, with no account, guest id, device id or IP.

alter table public.course_map_usage_daily drop constraint if exists course_map_usage_daily_event_check;
alter table public.course_map_usage_daily add constraint course_map_usage_daily_event_check
  check (event in ('download', 'update', 'play', 'delivery-failed', 'delivery-confirmed'));
