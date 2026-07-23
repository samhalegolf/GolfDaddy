-- Practice email photo lane: private Storage bucket for photos attached to
-- practice-data intake emails, so the "pending_photo" batches created by
-- practice-email-intake.js have somewhere durable to put the image bytes
-- (Resend's own attachment URLs are not guaranteed to stay valid) and the
-- frontend can later fetch them back via a short-lived signed URL to feed
-- into the existing in-app photo OCR scanner.
--
-- Applied directly to the live project via Supabase MCP on 2026-07-23;
-- this file is the source-of-truth record of that change.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'practice-photos',
  'practice-photos',
  false,
  15728640,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif']
)
on conflict (id) do nothing;

drop policy if exists "service role can manage practice photos" on storage.objects;

create policy "service role can manage practice photos"
on storage.objects
for all
using (bucket_id = 'practice-photos' and auth.role() = 'service_role')
with check (bucket_id = 'practice-photos' and auth.role() = 'service_role');
