# Course discovery — 2026-10-04

The picker's search has one job: **find a real golf course or club and return coordinates we can trust.**
It does not need a scorecard, holes, an OSM polygon or an existing Clarity map to return a valid result.
Those belong to the mapping pipeline after the player has picked a course.

```
SEARCH -> golf listings (Clarity, Mapbox, Nominatim) -> trustworthy coordinates -> player picks
       -> mapping pipeline: existing Clarity map | OSM seed | manual/image mapper
```

This keeps the single render owner from `COURSE_SEARCH_AUDIT_2026-09-09.md`. There is still one
`view` model and one `render()`. Country and region groups are new *phases* of that model, not new
render paths.

## What was wrong (confirmed against the code before changing it)

1. **One provider, client-side.** The picker called Nominatim from the phone. Any club OSM does not
   know (common outside Europe, NZ and the US) could not be found.
2. **The query was rewritten.** `"Duchess Golf Club"` was sent as `"Duchess Golf Club golf course"`.
3. **No real classification.** Any result whose text contained `golf|course|club|links` was kept.
   That let through ranges, shops, simulators and "Club Road".
4. **Short names collapsed.** `cleanName("Ba Golf Club")` gives `"ba"`, and local matching used
   `includes`, so "Ba" matched Balgove, Barnbougle and so on.
5. **Same name, different country, merged into one row.** `mergeDedupe` keyed on the name slug
   only. "Royal Golf Club" in Canada and in Sweden became one row, sitting at whichever point was
   nearer the player, and both shared one course id.
6. **Ranking could put a nearby partial match above an exact name.** Name match was a score bonus
   (−55), but distance (up to −34), recents (−14) and maps (−12) were added on top. So a nearby,
   recent, mapped partial match could beat an exact name further away.
7. **No country or region filtering, and no condensing.** A worldwide name returned a flat list of
   12 rows.
8. **Non-Latin queries cleaned to "".** Korean and Japanese searches were then ranked by distance,
   as if nothing had been typed.

## Architecture

| Piece | File |
|---|---|
| Endpoint (provider I/O, ground check, scorecard confirm) | `functions/course-search.mjs` → `/api/course-search` |
| Pure decisions (normalise, dedupe, confidence, rank, group) | `functions/lib/gd-course-search-core.mjs` |
| Golf vocabulary (classification, expansion, matching) | `functions/lib/gd-golf-vocabulary.mjs` |
| Picker | `scripts/inline/gd-course-picker-search-v2.js` |

`GET /api/course-search?q=&country=&region=&lat=&lng=[&debug=1]` returns
`{results, groups, ambiguous, diagnostics[, debug]}`. Each result has
`{name, lat, lng, country, countryCode, region, source, providerId, confidence, courseId, hasMap, …}`.

`GET /api/course-search?confirm=1&name=&lat=&lng=&region=&country=` runs the late scorecard check.

### Providers and the fallback ladder

The providers are Clarity `course_maps_list`, Mapbox Search Box `/forward` (POIs), and Nominatim.
Each rung runs only if the rungs before it came back weak, meaning no golf listing with an exact
or strong name match:

1. The exact typed text.
2. The same text with the providers' own golf filters (`poi_category=golf_course` for Mapbox,
   `layer=poi` for Nominatim).
3. A relaxed name: distinctive words plus "golf".
4. Local or alias terms for the selected country, for example `golfklubb` in Sweden. At most two.

Country is sent as a provider filter (`country=` for Mapbox, `countrycodes=` for Nominatim,
`country_code=eq.` for Clarity). Region is turned into a bounding box (Mapbox `bbox`, Nominatim
`viewbox` with `bounded=1`). Neither is ever glued onto the name.

### Dedupe

Two listings are the same place only if they are **close and their names agree**:

- Within 600 m with the same distinctive words, or
- Within 250 m where one name's words are a subset of the other's, and neither side belongs to a
  Clarity facility.

Two different Clarity courses are never merged. The canonical record is chosen in this order:
Clarity, then OSM, then Mapbox.

### Confidence

Evidence is added up, cheapest first. The numeric score is never shown to players.

| Evidence | Points |
|---|---|
| Clarity map with holes | +60 (always confirmed) |
| OSM course polygon (the listing itself, or one within 750 m) | +50 |
| 3+ `golf=hole` within 1 km | +40 |
| 3+ greens, tees, fairways or bunkers within 1 km | +30 |
| 15+ ha of outdoor or recreation land within 800 m | +20 |
| Scorecard page (late and async, ambiguous candidates only) | +30 strong / +20 |
| Course words in the name, in any language in the vocabulary | +15 |
| Provider category is golf course | +15 |
| Indoor, simulator or mini golf | −40 |
| Golf shop | −35 |
| Driving range | −30 |
| Academy | −15 |
| Commercial or industrial ground with no golf or outdoor evidence | −30 |

Classification: ≥60 is `confirmed_course`, ≥30 is `likely_course`, anything lower is
`possible_golf_facility`. Players see confirmed and likely courses. Possible ones appear only in
the admin debug view, unless the scorecard check later confirms them.

**Missing OSM data counts as neutral, never negative.** If Overpass is down or has no data, a POI
with course words in its name and a golf category still scores 30, which is `likely_course`.

The ground check is **one** batched Overpass query for up to 10 candidates. It runs with an 8 s
budget through the shared, throttled Overpass client.

### Grouping

The server decides the grouping from the data, never from a particular course name:

- With no country selected: show country groups if there are 3 or more countries, or more than 8
  results across 2 or more countries.
- Inside a country: split by region only if there are still more than 8 results across 2 or more
  regions.
- At most 6 groups are shown; the rest are combined into "Other".

The picker shows country rows, then region rows. When a group is opened, the existing list or
area flow runs, with a back row at the top.

### Admin debug

As an admin account, run `GDCoursePicker.setSearchDebug(true)` in the console. The picker then
sends `debug=1` and shows a diagnostics panel under the list. The panel shows provider counts,
which ladder rungs ran, the dedupe count, countries, and each candidate's evidence and confidence.

## Configuration

- `MAPBOX_PUBLIC_TOKEN`: the existing `pk.` token. Without it, Mapbox is skipped and the
  diagnostics say so. If the token has URL restrictions, server-side calls with no Referer may be
  refused, so allow them in the token settings.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: already set for the other functions.
- `BRAVE_SEARCH_API_KEY`, or `GOOGLE_CSE_KEY` with `GOOGLE_CSE_ID`: already used by scorecard
  search. Without them, the confirm step reports `unavailable` and ambiguous candidates stay hidden.

## Known limits

- The Mapbox Search Box parameters (`types=poi`, `poi_category=golf_course`) and Nominatim
  `layer=poi` were written from their documentation. They have not been exercised live from the
  build environment, which had no outbound network. Each provider fails soft.
- Mapbox search results are licensed for display and selection. Dedupe makes Clarity or OSM
  coordinates canonical whenever they exist. If a course is found only through Mapbox, its Mapbox
  point travels into the mapping flow. Check that this fits the Mapbox terms on the plan in use.
- Nominatim now runs from the function's IP rather than each phone. It is throttled to 1 request
  per second per instance, with a 5-minute response cache, but heavy use would need a dedicated
  geocoder.
