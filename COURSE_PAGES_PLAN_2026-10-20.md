# Public course pages — 2026-10-20

One public page per well-mapped course, so a search like *"Akarana golf course hole 7"* or
*"Waihi golf club garmin"* lands on Clarity showing **that course** on a phone, a Garmin and an
Apple Watch — and nothing else. It is a shop window for one course, not a course directory.

```
Google -> /courses/akarana-golf-course -> this course on phone / Garmin / Apple
                                        -> store badges
                                        -> "your course?" search  (mapped: go to its page,
                                                                   unmapped: tell us -> lead)
```

## What we already have (nothing here is new data)

| Need | Already exists |
|---|---|
| A URL-safe id per course | `courseId` is already a slug (`akarana-golf-course`) |
| Which courses are "decent" | `course-library.mjs`: `published=true` rows + a visual with `published_version > 0` |
| Real screenshots of the play screen | Marketing Snapshot Machine: `01-pre-lock`, `02-head-to-tee`, `03-approach` per course |
| Watch faces drawn as the watch draws them | `scripts/clarity-watch-preview.js` + `GET /api/course-watch-maps` |
| A search that only offers mapped courses | the `hasMap` filter in `clarity-watch-preview.js` over `/api/course-search` |
| Lead capture for an unmapped course | `POST /api/watch-preview-request` |
| Hole-by-hole par and length | the course scorecard (`course-scorecards.mjs`) |

The whole job is to put those behind a public, indexable URL.

## Pages

### `/courses/<courseId>` — the course page

Served by a new function `functions/course-page.mjs` (redirect `/courses/*` → it), **not** by the
client-side app. Google has to see the course name, the hole list and the images in the HTML it
fetches, so the page is rendered on the server and then enhanced by the same JS the watch preview
uses. Cached at the CDN (`Cache-Control: public, s-maxage=86400, stale-while-revalidate`) and
purged when the course republishes, so it costs nothing per visit.

Order on the page, top to bottom:

1. **Hero** — "{Course name} on Clarity Caddy." The `02-head-to-tee` frame as the picture,
   store badges right there. One line: *mapped {hole_count} holes, aerial imagery, watch ready.*
2. **Three device tabs — Phone / Garmin / Apple Watch.** Phone = the three snapshot frames.
   Garmin and Apple = the live watch renderers from `clarity-watch-preview.js`, locked to this
   course, with the existing tee / 180 m / 90 m position buttons. No course search in this
   section — the course is fixed.
3. **Hole by hole** — a plain table: hole, par, length from one tee (the scorecard's default
   men's tee), and a small Garmin face per hole if cheap.
   This is the part search engines actually match on ("hole 12", "par", "metres") and it is real
   content, not padding.
4. **"Looking for your course?"** — the picker, reused from the watch preview, but it is framed
   as *find yours*, not *browse ours*:
   - a mapped result → link straight to its `/courses/<id>` page
   - an unmapped result → "{name} isn't mapped yet — leave your email and we'll tell you when
     it is" → `/api/watch-preview-request` with the course name attached.
   There is no "all courses" link anywhere. Discovery is search-shaped, so the site never looks
   like a database — and every unmapped search is a demand signal for what to map next.
5. **Footer** — store badges again, privacy/terms/support links (the pages the gate already
   allows through).

### What is deliberately **not** built

- No `/courses` index page, no A–Z, no "browse by region", no course count anywhere.
- No ratings, reviews, booking, green fees, phone numbers. Clarity's angle is the mapping, so the
  page stays about the mapping.
- The existing `watch-preview.html` stays as it is (gated, `noindex`). It becomes the generic
  fallback; the course pages are the indexable version of the same idea.

## Which courses get a page

A page exists only when `page_public` is on, `published = true` and the visual has
`published_version > 0`. A scorecard is not a condition - several of the richest maps (Tara Iti,
Twin Isles, Wairakei, Chamberlain Park) have no card yet, and the visuals are the point - but
without one the page has no hole table, so running Update Scorecards on them is worth doing
before launch. The watch packages are not a condition either:

- **Garmin** is always available. `course_garmin_maps` is pure geometry drawn from `objects_json`,
  builds in seconds, and `GET /api/course-watch-maps?watch=garmin` already wakes the builder when
  the package is missing or behind (368 courses have one today).
- **Apple** is the image bake (`course_watch_maps`, minutes per course, background function) and
  is built lazily: the page function wakes the bake for a published course on first view (a new
  public wake path alongside the admin POST, same pattern as the Garmin GET), and the Apple tab
  shows "building this course's Apple Watch map" until it lands. The first batch is pre-baked so
  launch pages never show that state.

Among eligible courses, object count (`course_maps.object_count`, with `bunker_count` /
`water_count` / `tree_count`) decides priority: the more objects, the better the hazard
recognition and watch maps look, and those are the whole pitch. On top of that one explicit switch, so a half-decent
course never goes public by accident: **a `page_public` boolean on the course row**, set from the
Studio course row ("Publish course page"). Default `false`. The function returns a plain 404 for
anything else (not a redirect to welcome — a 404 is what we want Google to see for a course that
isn't ready).

## Being found

- `sitemap.xml` — a tiny function listing every `page_public` course, last-modified from
  `published_at`. Submit once to Search Console. This is for crawlers only; humans never see it.
- `robots.txt` — allow `/courses/`, keep `/app`, `/studio`, `/demo` disallowed.
- Per page: `<title>` *"{Course} — hole maps on Garmin, Apple Watch & phone | Clarity Caddy"*,
  meta description written from the data (hole count, location, holes), `<link rel=canonical>`,
  Open Graph image = the hero frame, and JSON-LD `GolfCourse` (name, geo, address if we have it,
  `numberOfHoles`) plus `SoftwareApplication` for the app.
- `welcome.html` links to **three or four** featured course pages ("See it on a real course:").
  Google needs a path in from the landing; a handful of hand-picked links reads as examples, not a
  directory.
- `web-app-gate.js`: add `/courses/`, `/sitemap.xml`, `/robots.txt` to what passes through.
  Everything else stays gated exactly as now.

## Images

The Snapshot Machine already produces the right frames; today they land in `marketing-output/`
on a laptop. Step: have `run-snapshots.mjs` (or the Studio run) also upload the three PNGs to
Supabase storage under `course-pages/<courseId>/`, plus a 1200×630 crop of frame 02 for Open
Graph. The page function reads them from there. Re-running the machine after a remap refreshes
them; nothing else has to change.

## Build order

1. **Function + template + gate** — DONE 2026-10-20. `functions/course-page.mjs` routes itself
   with `config.path = "/courses/:courseId"` (no toml redirect needed); the gate passes
   `/courses/`; non-public courses get a noindex 404; `page_public` migration applied and
   switched on for the ten first-batch courses. Test: `npm run test:course-page`.
   Found on the way: `akarana-golf-club` has `facility_key = maungakiekie-golf-club`, so its
   page would pick up Maungakiekie's card - the facility link needs fixing in Studio before
   Akarana's page is trusted. CDN cache is a day with no purge on republish yet.
2. **Images** — DONE 2026-10-20. `marketing/course-page-assets.mjs` + `--upload` /
   `--upload-only <run>` on the snapshot runner: web-size JPEGs and a 1200x630 share card, made
   in the runner's own Chromium (no sharp), into the public `course-pages` bucket (migration
   applied). The page lists the folder and uses what is there; no frames, no pictures. Still
   to do by hand: run the uploader for the first batch (needs SUPABASE_URL and the service key
   in the shell) - see marketing/README.md.
3. **Device tabs** — mount the Garmin/Apple renderers from the watch preview on the page,
   course-locked, position buttons kept.
4. **Picker section** — reuse the search; mapped → page link, unmapped → request form.
5. **Sitemap, robots, JSON-LD, welcome links; submit to Search Console.**
6. **Studio toggle** for `page_public` so publishing a page is one click.
7. Tests in `dev/` in the existing style: the function renders for a public course and 404s for a
   private one; the gate passes `/courses/*`; the sitemap lists only public courses; the
   template references only files the deploy copies.

## Decisions (2026-10-20)

1. **No email gate on course pages.** The visuals are open. Leads come from the store badges and
   the "your course isn't mapped yet" form only. `watch-preview.html` keeps its gate as before.
2. **Hole table shows one tee.** The course's standard men's tee (the scorecard's default tee);
   par and length per hole, no multi-tee columns.
3. Clubs: nothing goes public until `page_public` is flipped per course, so any courtesy contact
   with a club happens before the flip and needs no code.

## First batch (queried 2026-10-20)

Published with a published visual, ranked by objects. Garmin works for all of them; "apple" marks
the ones whose image package already exists — the rest get pre-baked before launch.

| course_id | objects | bunkers / water / trees | apple | notes |
|---|---|---|---|---|
| `tara-iti` | 741 | 537 / 1 / 26 | — | |
| `maungakiekie-golf-club` | 690 | 154 / 4 / 491 | ready | snapshots already shot |
| `twin-isles-country-club` | 525 | 372 / 35 / 209 | — | |
| `los-angeles` | 471 | 304 / 2 / 2153 | — | |
| `augusta-national` | 467 | 113 / 17 / 1387 | — | scorecard present |
| `wairakei-international` | 436 | 234 / 42 / 571 | — | |
| `akarana-golf-club` | 395 | 124 / 18 / 770 | — | snapshots already shot; scorecard present |
| `millbrook-remarkables-18` | 366 | 184 / 43 / 276 | ready | snapshots already shot; display name needs cleaning ("Course 1 - 6298m North-West") |
| `chamberlain-park` | 340 | — | ready | |
| `waitemata` | 300 | — | ready | scorecard present |

Scorecards are keyed by lowercased club name in `course_scorecards.course_key`, not by
`course_id`; the page function must resolve them the way `course-scorecards.mjs` already does
rather than joining on the id. Which of the above actually have one is settled by that resolver,
not by the rough name match used here.
