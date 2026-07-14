# Claude Hole Labeller Archive

This folder preserves the retired Claude-based course hole labelling system for possible future research. It is no longer part of the active Clarity Caddie / GolfDaddy course-loading pipeline.

## What It Did

- Intercepted OSM guide fetches in the browser via `source/scripts/gd-claude-hole-labels.js`.
- Sent OSM hole/green geometry and course context to a backend service.
- Used Claude plus web/course-map evidence to infer missing OSM hole numbers.
- Returned labels to the app by injecting `tags.ref` values into OSM guide data.
- Fired `gd:hole-labels-ready` / `gd:hole-labels-failed` events so the AutoMapper path could retry with labelled OSM guides.

## Preserved Source

- `source/scripts/gd-claude-hole-labels.js`: browser adapter, prompt/job orchestration client, response application, local cache and event dispatch.
- `source/server/hole-labeler/caddy_osm_hole_labeler.py`: FastAPI service, prompt construction, Claude calls, response parsing, diagnostics and job endpoints.
- `source/server/hole-labeler/golf_hole_mapper.py`: earlier command-style mapper/research script.
- `source/server/hole-labeler/requirements.txt`: research backend dependencies.
- `render.yaml`: retired Render service configuration.

## Why It Was Removed

The system began firing but did not produce a usable course assignment in the latest observed run:

- `candidates_screened: 0`
- `described_shapes: 0`
- `match_attempts: 0`
- `screens_run: 0`
- `osm_holes: 18`
- `scorecard_holes: 18`
- `pages_found: 6`
- `unlabelled: 18`
- failure: `no candidate course map produced a clean assignment`

That failure mode made the active player/course-loading path depend on an expensive external model job that could still leave every hole unlabelled. The active system now uses the local/native Course Geometry Resolver after ordinary OSM AutoMapper and before the live-map green-tap fallback.

## Active Runtime Boundary

This archive must not be imported, loaded by `index.html`, deployed as part of the active app, or used as a fallback during GPS/course mapping. No active runtime file should set `window.gdClaudeHoleLabels`, call `/v1/osm-hole-labels`, listen for `gd:hole-labels-*`, or depend on `ANTHROPIC_API_KEY`.

## Revisiting Later

To revisit this research path, start from a separate branch and prove:

- deterministic handoff to AutoMapper without browser fetch monkey-patching;
- bounded model cost and no repeated jobs from map/course-key drift;
- usable visual evidence for every screened candidate;
- privacy review for all sent course/context payloads;
- robust failure semantics that never block native mapping or one-tap fallback;
- a real test course where the model resolves missing OSM refs better than the native resolver.

Do not add secrets, generated caches, private logs, screenshots with private data, or build output to this archive.
