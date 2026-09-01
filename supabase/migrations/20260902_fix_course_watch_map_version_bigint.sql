-- Date.now() package versions are millisecond timestamps and exceed PostgreSQL integer.
-- Existing installations need this follow-up migration; new installations get bigint from
-- the create migration as well.
alter table public.course_watch_maps
  alter column watch_package_version type bigint;
