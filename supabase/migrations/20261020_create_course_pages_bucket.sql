-- Images for the public course pages (functions/course-page.mjs).
--
-- One folder per course: <course_id>/web/02-head-to-tee.jpg and friends, written by the
-- marketing snapshot runner (marketing/course-page-assets.mjs) from the frames it
-- shoots, plus the 1200x630 og.png a shared link shows. Public bucket: the page
-- links straight to the files, so a visit costs the function nothing for images.
-- Nothing in the app reads this bucket.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('course-pages', 'course-pages', true, 4194304, array['image/png', 'image/jpeg'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
