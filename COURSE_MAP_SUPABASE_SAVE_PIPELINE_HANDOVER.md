# Clarity Caddie — Course Map → Supabase Save Pipeline

Date: 2026-07-11
Branch: `feature/course-map-supabase-save-pipeline`

## What this adds

The mapping side already worked and was not touched:

```text
Course opened
→ gdKickWholeCourseAutoMapOnLoad (index.html) runs the GPS auto mapper for ALL holes
→ auto mapper (gd-course-library-pin-lock.js) saves greens/tees/fairways to the course library
→ gd-course-play-pipeline.js extracts every hole via mappedHolePlayData and keeps it locally
```

What was missing: nothing ever left the browser. The pipeline had a sync
queue but no caller and no transport (`network:"not-configured"`).

This branch adds the transport only:

```text
Pipeline finishes extracting the auto mapper output
→ fires its own debug events (automapper-completed / pipeline-course-ingested)
→ gd-course-play-supabase-sync.js listens, debounces, enqueues the pipeline's
  own sync envelope (full course + all hole geometry)
→ flushes the queue: POST /api/course-play-sync
→ functions/course-play-sync.js upserts into Supabase course_play_maps
→ queue item marked synced
```

Zero changes to the auto mapper or to gd-course-play-pipeline.js.
Extraction timing is unchanged — the transport only reacts to the pipeline's
existing "ingest finished" events, so it always reads geometry after the
auto mapper output has been ingested.

## Files

New:
- `scripts/gd-course-play-supabase-sync.js` — client transport (enqueue + flush, retry with backoff, offline outbox reuse of the pipeline queue, per-course change signature so unchanged courses are not re-uploaded)
- `functions/course-play-sync.js` — Netlify function: `upsert_course`, `get_course`, `list_courses`
- `supabase/course-play-maps-schema.sql` — `course_play_maps` table

Updated:
- `index.html` — one script tag after gd-course-play-pipeline.js
- `netlify.toml` — `/api/course-play-sync` redirect

## Deploy steps

1. Run `supabase/course-play-maps-schema.sql` in the Supabase SQL editor.
2. No new env vars — reuses `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
3. Deploy the branch.

Check:

```sql
select course_id, course_name, account_id, holes_count, holes_ready_count, data_version, updated_at
from public.course_play_maps order by updated_at desc limit 20;
```

In the browser console:

```js
window.GDCoursePlaySupabaseSync.pendingItems()   // should drain to []
window.GDCoursePlaySupabaseSync.syncActiveCourse() // manual kick
window.__gdDumpCoursePlayTimeline()              // supabase-sync-* events
```

## DB-first check (future step, hook already in place)

`window.GDCoursePlaySupabaseSync.checkRemote(courseId)` returns
`{exists, dataVersion, course}` from Supabase. When you're ready to skip
re-mapping for courses already in the database, call this before
`gdKickWholeCourseAutoMapOnLoad` and hydrate via
`GDCoursePlayPipeline.importCoursePlayPayload(result.course)` instead of
running the mapper. Not wired up yet on purpose — this branch is the clean
save pipeline only.

## Behaviour notes

- Signed-out users sync under `account_id = "anonymous"`; one row per account + course (upsert, `on_conflict=account_id,course_id`).
- Frame/tile caches are NOT uploaded — geometry only, per the pipeline's own `dbShareable:false` note on frame records.
- Failed posts stay in the pipeline queue and retry with backoff (15s → 5min cap, 8 attempts), plus on `online` and tab-visible events. Queued items from a previous session flush on startup.
