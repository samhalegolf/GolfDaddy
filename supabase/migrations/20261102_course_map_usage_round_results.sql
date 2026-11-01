-- How an opened round went: one anonymous outcome per round, from app/js/round-usage.js.
--
-- A 'play' says a round was opened - from the course or from the sofa, the same row. App
-- builds from November 2026 also count, once the round is over:
--
--   round  outcome: played | part-round | stopped-early | off-course | on-watch
--
-- worked out on the phone from the holes it moved through and whether a GPS fix ever put
-- it on the course (near the tee or green of the hole in play). Only the outcome is sent:
-- no position, time or id. The outcome check already accepts these slugs.

alter table public.course_map_usage_daily drop constraint if exists course_map_usage_daily_event_check;
alter table public.course_map_usage_daily add constraint course_map_usage_daily_event_check
  check (event in ('download', 'update', 'play', 'round', 'delivery-failed', 'delivery-confirmed'));
