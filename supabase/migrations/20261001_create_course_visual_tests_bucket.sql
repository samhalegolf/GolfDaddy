-- Private bucket for TEST bakes (functions/lib/gd-test-bake-core.mjs).
--
-- Test bakes run the normal capture + bake from a source whose output may be looked at but
-- not published (Mapbox). They must never be reachable by players, so they live here rather
-- than in the public course-visuals bucket: private, read only by the service role, and shown
-- in Studio through short-lived signed links (functions/course-test-bakes.mjs). Everything in
-- it sits under a date folder and is purged after 7 days by course-visual-sweeper.mjs.
--
-- The visual worker also creates this bucket on first use, so a test bake works before this
-- migration is applied; this file is the record of what it should be.

insert into storage.buckets (id, name, public, file_size_limit)
values ('course-visual-tests', 'course-visual-tests', false, 20971520)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit;
