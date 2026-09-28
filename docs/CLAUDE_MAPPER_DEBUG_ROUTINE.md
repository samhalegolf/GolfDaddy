# Claude mapper-debug routine

When a course mapping job fails for good, the worker hands it to a Claude Code
Routine: a cloud session whose repo, connectors and network policy are fixed in
advance. Claude investigates, pushes any fix as a draft PR, and sends a report.
Nothing merges on its own.

## What the code does

- `functions/alert-utils.js` `fireClaudeRoutine` POSTs the failure to the routine's
  API trigger and returns the session link.
- `functions/course-mapper-worker-background.mjs` `requestMapperDebug` calls it from
  both terminal paths: a non-transient error, and a job reaped eight times. Transient
  failures (Overpass 504 and friends) are requeued and never fire.
- The outcome lands on the job row as `result.debugSession`, so a failed job in the
  admin view links to the session that looked at it, or says why none did
  (`missing_routine_url`, `throttled`, `provider_rejected`).
- One fire per hour, globally. Twenty courses failing on one bad deploy is one
  investigation. The prompt below tells Claude to check every failed job of the last
  hour, so the ones the throttle swallowed are still seen.
- A short "Claude is looking at this" email goes to `CLARITY_ALERT_EMAIL` with the
  session link. The report itself comes from the session.

## What the Routine receives

The fire text is built by `buildMapperDebugText` in
`functions/lib/gd-mapper-failure-kinds.mjs`, in this order:

1. **The operator's prompt for this kind of failure.** `classifyMapperFailure` sorts the
   job's error and diagnostics into one kind: `no-osm-data-with-scorecard`,
   `no-osm-data-no-scorecard`, `surfaces-only` (greens or fairways but no hole lines),
   `holes-unnumbered`, `partial-numbering`, `no-course-location`, `worker-died`, `other`.
   Each kind has a default prompt in that file; a row in `mapper_failure_prompts`
   overrides it. Edit them in Studio > Courses > Course Mapping > **Claude Debug
   Prompts** (`/api/course-mapper-prompts`, admin only). Placeholders such as
   `{{courseName}}`, `{{expectedHoles}}` and `{{greens}}` are filled from the job.
2. **The facts**: kind, job id, course id and name, centre, attempts, error, the OSM
   feature counts and whether a scorecard was found.
3. **Two captures**, satellite (Esri World Imagery, needs `ARCGIS_API_KEY`) and
   OpenStreetMap, of the same 4x4 tiles at zoom 16 around the centre, uploaded to the
   public `course-visuals` bucket under `mapper-debug/<date>/<job id>/` and linked by
   URL, with their bounds and the pixel-to-coordinate rule so Claude can draw greens
   and fairways from the imagery and return real coordinates.
4. **The output contract**: drawn or numbered geometry comes back as one fenced
   `json` block in the mapping overlay's own shape, `{ courseId, features: [{ id,
   kind: fairway | hole | green, hole, points: [{lat, lng}] }] }`. That is what
   Studio > Courses > Mapping Overlay saves through `/api/course-map-overlay` and what
   the next mapper run merges into the Overpass payload, so an operator pastes the
   block, saves, and requests a remap. Nothing saves it automatically.
5. **The diagnostics JSON**, cut to fit the 16000-character fire limit.

The captures and the prompt lookup only happen when the Routine is configured. The
mapper sweeper deletes capture folders older than seven days
(`purgeMapperDebugCaptures`). The job row records `failureKind`, and when a fire was
possible `debugPayload` (prompt source and capture URLs) next to `debugSession`.

Tests: `node dev/mapper-debug-routine.test.js`, `node dev/mapper-failure-kinds.test.js`,
`node dev/mapper-debug-payload.test.js`.

## One-time setup

1. Go to https://claude.ai/code/routines and create a routine.
   - Repository: `samhalegolf/GolfDaddy`
   - Environment: the one with the Supabase and GitHub connectors. Remove every
     connector the routine does not need. A routine can use any tool on an attached
     connector without asking, so the connector list is the permission scope.
   - Prompt: paste the block below.
2. Edit the routine, **Add another trigger**, choose **API**. Copy the URL and
   generate a token. The token is shown once.
3. In Netlify site settings, add:

   ```
   CLAUDE_MAPPER_ROUTINE_URL=https://api.anthropic.com/v1/claude_code/routines/<id>/fire
   CLAUDE_MAPPER_ROUTINE_TOKEN=<token>
   ```

   Optional: `CLAUDE_MAPPER_ROUTINE_THROTTLE_MINUTES` (default 60). The satellite
   capture uses the `ARCGIS_API_KEY` the app's live map already needs; without it the
   payload says `satellite: not captured (no-esri-key)` and the OSM capture still goes.

4. Redeploy. With the two vars unset the feature is off and the worker behaves as
   before.

The fire endpoint is in research preview. If Anthropic changes the beta header, it
lives in one place: `fireClaudeRoutine` in `functions/alert-utils.js`.

Docs: https://code.claude.com/docs/en/routines and
https://platform.claude.com/docs/en/api/claude-code/routines-fire.

## Routine prompt

Replace the two placeholders before pasting.

```
You are the on-call engineer for Clarity Caddy's course mapping system. A mapping
job has failed for good. Investigate it, fix what you can, and report back.

The failure to investigate is in the routine-fire-payload block: act on it. It
opens with the task for this kind of failure, written by the operator, then the
job id, course id, attempts, the error, links to a satellite and an OpenStreetMap
capture of the course with the rule for turning a pixel into a coordinate, the
shape any geometry you draw must come back in, and the diagnostics the run saved
before it died. Do the task first; the standing steps below still apply.

Where things live:
- Worker: functions/course-mapper-worker-background.mjs (claims course_mapper_jobs
  rows, queries Overpass, resolves geometry, writes course_maps).
- Geometry pipeline: functions/lib/gd-automapper-core.mjs and
  functions/lib/gd-geometry-resolver-core.mjs.
- Scorecard resolution: functions/lib/gd-scorecard-resolve.mjs.
- Tests: dev/course-mapper-worker.test.js, dev/mapper-transient-retry.test.js,
  dev/automapper-core.test.js and the other dev/course-*.test.js files. Run them
  with node.

Steps:
1. With the Supabase connector, read the failed row in course_mapper_jobs (id in
   the payload) and every other course_mapper_jobs row with status = 'failed'
   updated in the last hour. Read the course's course_maps row and its
   course_scorecards rows. Read only. Never insert, update or delete anything in
   the database, and never requeue a job.
2. Work out the root cause. Distinguish a data problem (bad centre coordinates,
   course missing from OpenStreetMap, no scorecard) from a code problem (a throw in
   the pipeline, a classifier that should have retried, a regression from a recent
   commit). Check git log for recent changes to the files above.
3. If it is a code problem, write a failing test that reproduces it, make the
   smallest fix that passes, and run the mapper test files. Push to a branch named
   claude/mapper-<short-description> and open a DRAFT pull request against main.
   Never merge, never push to main, never change files outside the mapping system
   unless the fix requires it.
4. If it is a data problem, do not touch the data. Say exactly which row and field
   is wrong and what the value should be.
5. Send the report by email to <YOUR ALERT EMAIL> with the subject
   "Mapper debug: <course id>". Keep it short and plain:
   - Root cause in one or two sentences.
   - What you changed, with the PR link, or "no code change".
   - What you could not resolve and what you need from a human.
   - Any other failed jobs from the last hour and whether they share the cause.
   Put the same report in the PR description if you opened one.

If the payload is missing or does not describe a mapping failure, stop and send a
one-line email saying so.
```
