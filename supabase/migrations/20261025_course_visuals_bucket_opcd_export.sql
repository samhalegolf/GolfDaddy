-- The OPCD / GSPro export (functions/lib/gd-opcd-export-job.mjs) writes beside the frames in
-- course-visuals under <courseId>/opcd/<version>/: a 16-bit RAW heightmap, a float32 GeoTIFF,
-- GeoJSON, CSVs, a Markdown README and the Clender SVG. The first live run was refused at the
-- first file (415 invalid_mime_type for application/octet-stream), because the bucket only
-- ever allowed the frame types. Allow what the export writes, and raise the size cap: a 4097
-- sample frame is a 33.6 MB RAW and a 67 MB float32 TIFF, over the 25 MB the bucket had.
update storage.buckets
set allowed_mime_types = array[
      'image/svg+xml', 'image/png', 'image/webp', 'image/jpeg', 'application/json',
      'application/octet-stream', 'image/tiff', 'application/geo+json', 'text/csv', 'text/markdown'
    ],
    file_size_limit = 104857600
where id = 'course-visuals';
