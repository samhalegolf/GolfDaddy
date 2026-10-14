# Bunker, water and crossing-hazard finder — plan (2026-10-14)

Goal: bunkers, water and anything that crosses the line of play get found automatically along each hole's play line, the way "Find trees near play" finds trees. No boxes, no sample pins. Same live review: ← → sensitivity, Enter keeps, Esc throws away.

Companion to `TREE_FINDER_AUTO_PLAN_2026-10-14.md`; it reuses most of that work.

## 1. What we already have

- **The play line.** Every hole has (or can have) a `hole` feature: a polyline from the tee end to the green (`kind: "hole"`, `hole` number, OSM or drawn). That is the line this finder walks.
- **Where to look.** `GDOverlayShapes.playBand(w, h, {play, surfaces, woods, bandPx, clearPx})` already builds a "within X m of this, clear of everything drawn" mask. It takes rings; it needs to take a line too (one small addition, §3).
- **What turf looks like.** `autoTreeModel` already learns the turf colour from the fairway/green pixels on the picture (`colourField`, `colourModel`, `fieldSamples`). Sand, water and paths are all defined *relative to turf*, so the same reference works.
- **Turning a pixel mask into a shape.** The colour wand already does it: `maskOutline` → for a bunker `mergeBunker` + the 8-handle smooth outline, for water `softenOutline`, for a hazard the detailed outline (`keepColourSel`, `addFeature`). The finder drops its shapes down exactly that path.
- **Pictures.** `captureBox(points, {mpp, padM, maxSidePx})` stitches provider tiles and steps the zoom down when the box is too big. Same CORS rule as the tree finder: Mapbox stays dry.
- **Review UX.** `finder = {ids, runs, …}` + `dropFinderTrees(level)` handle the live level stepping and the one-undo-step drop. Generalise the name, keep the mechanism.
- **Downstream.** `bubble-visual.js` already draws `hazards.water`, `hazards.bunkers`, `hazards.hazards` (orange "other"). So a found `water`, `bunker` or `hazard` feature counts the moment it is saved — unlike single trees, nothing downstream needs changing.

Server wand (`/api/course-map-wand`) is *not* used: it finds an edge round a pin but has no idea what colour it is looking at. The finder has to know sand from water from a path, so it stays in the browser like the tree finder.

## 2. How it works

One button, one run per hole line (or every hole line when no hole is set): **"Find hazards along hole N"**. One run looks for all three kinds at once and the status says "Hole 7: 4 bunkers, 1 water, 1 crossing".

### 2a. Where it looks — the corridor

For each hole line:

1. Capture the line's bbox with `captureBox`, `padM = HAZARD_CORRIDOR_M` (start at **45 m** each side — a bunker further out than that is not in play off the line), at **0.4 m/px** (`HAZARD_FINDER_MPP`; bunkers are 6–30 m across, no need for the tree finder's 0.3). A 450 m hole is ~1100 px long — fits `TREE_FINDER_MAX_SIDE_PX` (1400). Longer holes: `captureBox` already drops a zoom level.
2. Corridor mask = `playBand` with `play` = the line painted `~2 px` wide (new `lineMask`), `bandPx = 45 m`, `clearPx = 3 m`, `surfaces` = every drawn fairway / green / tee / bunker / water / waste / hazard on the picture, `woods` = drawn `trees`. So it never re-finds something already drawn.
3. Turf reference = pixels inside drawn fairways and greens on this picture (as today). **Fallback when a hole has no fairway drawn yet:** the pixels under the line itself, 2–8 m either side, tee end and green end trimmed off — on almost every hole that strip is mostly fairway. Report "turf read from the hole line" in the status so it is visible.

### 2b. Bunkers — sand

Inside the corridor a pixel is **sand** when, against the turf model:

- **brighter** than turf by a margin (`SAND_BRIGHT_MARGIN`, start 15 L units; sand is the brightest thing on a course after a clubhouse roof),
- **not green**: `A ≥ −2` (red ≥ green),
- **warm**: `B > SAND_WARM_MIN` (yellow over blue) — this is what separates sand from a concrete or grey-gravel path,
- **smooth**: texture (same `tex` measure as `autoTreeModel`) at or below turf's — raked sand is flatter than mown grass.

Then: close small holes, connected blobs, keep blobs **8–1200 m²** (`WAND_PROFILES.bunker.areaM2`, already the agreed believable range), drop blobs that are thin (max depth of the distance transform < 1.5 m — a bright path edge or a mowing line). Each kept blob → `maskOutline` → `mergeBunker` (joins one that overlaps an existing bunker) → bunker feature, `source: "finder"`.

Sensitivity levels (← →) scale the brightness margin and the colour spread, same six-step idea as `TREE_FINDER_LEVELS`.

Known confusions and what handles them: white links sand vs white path (warm test + thinness), sand vs a bare worn tee or dry patch (area and smoothness — a dry patch is textured), sand vs a bright roof (outside the corridor nearly always; when not, the human says no).

### 2c. Water

Inside the corridor a pixel is **water** when:

- **darker** than turf by a margin (`WATER_DARK_MARGIN`, start 12),
- **not green**: `A ≥ −TREE_GREEN_MIN` or `B < 0` (blue over yellow),
- **very smooth**: texture below turf's — flat water is the smoothest thing on the picture; a tree's shadow on rough is not,
- **not tall**: when the canopy heights are on and available (`canopyMask`), not under something ≥ 3 m — this is what drops tree shadows and the trees themselves.

Blobs ≥ 60 m² (`WAND_PROFILES.water.areaM2.min`), no upper cap (a lake), `softenOutline` as water does today, `source: "finder"`. Capped at `SOFT_MAX_STATIONS` points like any drawn water.

Honest limit: a murky brown pond reads like bare earth; a dark-green weedy pond reads like rough. Those will come through the crossing finder (2d) if they cross the line, otherwise they stay a hand job.

### 2d. Crossings — the lateral/"not fairway" test

This is the one the user described: anything that crosses the line of play that is not fairway. A creek bed, a drain, a scrub gully, a path, a ravine with no visible water.

1. Walk the hole line tee → green in 1 m steps. At each step read the colour of a short strip across the line (±4 m) and score it with `spreadDistance` against the turf model.
2. A **run** is a stretch along the line, **≥ 3 m and ≤ 80 m long**, where the strip is not turf (`spreadDistance > CROSSING_TOL`, levelled by ← →), not inside anything already drawn, and not within the first 15 m from the tee or the last 20 m into the green (tee boxes and green surrounds are not crossings).
3. Grow each run sideways: `growRegion` seeded from the run's own pixels with the run's own colour model, reach `CROSSING_REACH_M` (start 60 m) — the same engine as the line wand. A crossing that genuinely crosses reaches the corridor edge on both sides; one that is a blob on the line (a bunker in the middle of the fairway, say) does not — but 2b will have taken that already, and the avoid list keeps 2d off it.
4. Classify the grown shape by its majority pixels:
   - water-like (2c's test) → `water`
   - bright, grey (not warm), and thin everywhere (max depth < 2.5 m) and long (length > 6 × width) → **a path** (see question 1)
   - anything else → `hazard` (that is exactly what the `hazard` kind is for: "gorse, scrub, a ravine — anything that is not water")

A crossing can be two things at once (a creek with scrub banks). Majority wins; the human can split it with the colour wand. Keep it simple first.

### 2e. Output and review

- All found shapes in one `finder` run, one undo step, `source: "finder"`, `hole` set from the line.
- Live review as today: ← → re-runs the thresholds (the pictures and fields are kept, so it is quick), Enter keeps, Esc throws the lot away. Status per hole: "Hole 7: 4 bunkers, 1 water, 1 crossing (hazard)".
- Avoid list = every existing bunker / water / hazard / waste on the picture plus 3 m, so re-running is safe.
- Seams: a kept water/hazard runs through `sealSeams` as a drawn one does, so it meets the fairway in the middle.

## 3. Code changes

**`map-overlay-shapes.js`** (pure, testable):

- `lineMask(w, h, line, widthPx)` — paint a polyline. `playBand` gains `opts.lines` next to `opts.play`.
- `turfModelFor(image, turfMask | lineStrip)` — pull the turf-reading part out of `autoTreeModel` so both finders share it (`autoTreeModel` then calls it; nothing else changes there).
- `sandMask(field, tex, turf, band, level)`, `waterMask(field, tex, turf, band, tall, level)` — the pixel tests in 2b / 2c.
- `blobs(mask, w, h, {minAreaPx, maxAreaPx, minDepthPx})` — connected components with area and depth, returning one mask each. (`connected` + `distanceTo` already exist; this just loops them.)
- `lineRuns(field, line, turfModel, {stepPx, halfPx, tol, minPx, maxPx, skipStartPx, skipEndPx})` — 2d step 1–2.
- `classifyBlob(field, tex, mask, turf, tall)` → `"water" | "path" | "hazard" | "bunker"`.
- `hazardFinder(image, opts)` → `{find(level) -> {bunkers:[ring], water:[ring], crossings:[{ring, kind}]}}`, same shape as `treeFinder`'s `{find}` so the page treats it alike.
- Constants in one block with the tree ones: `HAZARD_CORRIDOR_M 45`, `HAZARD_CLEAR_M 3`, `SAND_BRIGHT_MARGIN 15`, `SAND_WARM_MIN 4`, `WATER_DARK_MARGIN 12`, `CROSSING_MIN_M 3`, `CROSSING_MAX_M 80`, `CROSSING_REACH_M 60`, `CROSSING_SKIP_TEE_M 15`, `CROSSING_SKIP_GREEN_M 20`, `HAZARD_FINDER_LEVELS` (six).

**`map-overlay-page.js`:**

- `HAZARD_FINDER_MPP = 0.4`.
- `playLines()` — the hole lines to walk: `kind === "hole"` for the hole in hand or all; when a hole has no line but has a linked/numbered tee and green, a straight tee-centre → green-centre line (flag it in the status as "no hole line — straight line used").
- `hazardRun(line)` mirrors `nearPlayRun`: capture, corridor, turf, canopy, `hazardFinder`.
- `runHazardsAlongPlay()` mirrors `runNearPlay()`.
- `dropFinderTrees(level)` → `dropFinderShapes(level)` handling kinds; bunkers via `mergeBunker` + smooth outline, water via `softenOutline`, hazard via detailed outline — i.e. the same three branches `keepColourSel` already has, pulled into one `placeFound(kind, points, hole)` used by both.
- UI: a button in the rail under **Bunker**, **Water** and **Hazard** tools alike (same button, label "Find hazards along hole N / every hole"), hint text, status, the ←/→/Enter/Esc wiring extended to `finder.kind === "hazards"`. Corridor width as a session setting beside `treeBandM` (`hazardCorridorM`, 20–80 m).
- Credit line for canopy heights already handled by `renderCredit`.

**Tests** `dev/map-overlay-shapes.test.js` — synthetic picture, flat green turf with a hole line down it:
- a warm bright round blob beside the line → one bunker, nothing else;
- a grey bright thin strip crossing the line → one crossing, kind `path`;
- a dark blue smooth blob 20 m off the line → one water;
- a dark grey smooth blob touching a dark-green textured disc (shadow + tree) → nothing when `tall` is given, water otherwise (documents the limit);
- a dark brown textured band crossing the line → one crossing, kind `hazard`;
- the same picture with the blobs inside drawn shapes → nothing (avoid list works).

Nothing on the server. No new data source. No schema change: `bunker`, `water`, `hazard` features with `source: "finder"` are what the overlay stores today.

## 4. Build order

1. `lineMask`, `turfModelFor` refactor, `blobs` — tests first.
2. `sandMask` + `waterMask` + `classifyBlob` + `hazardFinder` without crossings; page button, run, review, drop. Try on two or three courses.
3. `lineRuns` + crossings.
4. Corridor width setting, straight-line fallback, polish.

## 5. Limits worth knowing up front

- **Needs hole lines.** Courses with no OSM hole lines and none drawn get the straight tee→green fallback, which cuts corners on doglegs — so the corridor should be wider there (use 60 m) and the status should say so.
- **Overlay cap** is 1200 shapes. A bunkered 18 is 60–120 bunkers; fine.
- **Imagery season/time.** Low sun = long tree shadows across fairways = false crossings. The canopy gate helps with water; for crossings the "not under a tall thing *and* not next to one" rule is weaker. Expect the human to say no to a few.
- **Dark green weedy ponds** and **brown ponds** will not read as water; they read as hazard when they cross the line, or get missed when they are off to the side.

## Questions for you

1. **Paths.** There is no `path` kind on the overlay today and a cart path is not a hazard in golf. When the finder finds one crossing the line, should it (a) add a new `path` kind (the watch/bubble could then say "path at 240 m" — but that is downstream work), (b) place it as a `hazard`, or (c) just say "1 path crossing at 240 m" in the status and place nothing? I lean (c) now, (a) later if you want it on the watch.
2. **Must a crossing cross?** Should a non-turf run on the line only count when the grown shape reaches both sides of the corridor, or is anything non-turf sitting on the line (a scrub patch the line clips) in? I have written it as "anything on the line", with crossings naturally wider; say if you want it stricter.
3. **One button or three?** One "Find hazards along hole N" that finds all three at once (as written), or a button under each tool finding only that kind?
