-- "Email me when this course is ready" no longer needs an account. The player types the
-- address they want told (functions/course-map-notify.mjs), so a row is one address per
-- course, and user_id is only filled in when a signed-in player asked. The ready email asks
-- an address with no account to sign up.

alter table public.course_map_notify_requests
  alter column user_id drop not null;

alter table public.course_map_notify_requests
  drop constraint if exists course_map_notify_requests_course_id_user_id_key;

alter table public.course_map_notify_requests
  add constraint course_map_notify_requests_course_id_email_key unique (course_id, email);
