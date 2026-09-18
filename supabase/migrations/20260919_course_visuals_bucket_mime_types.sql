-- The course-visuals bucket has carried JPEG frames (h<N>.jpg, h<N>.green.jpg, overview.jpg)
-- and JSON sidecars/indexes since the cloud bake shipped, but the migration that created it
-- allowed only svg/png/webp - the live bucket was widened by hand. Record what is actually
-- stored so a fresh environment matches production.
update storage.buckets
set allowed_mime_types = array['image/svg+xml', 'image/png', 'image/webp', 'image/jpeg', 'application/json']
where id = 'course-visuals';
