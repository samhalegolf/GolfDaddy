# Auto tree finder — research and plan (2026-10-14)

Goal: trees get pinned automatically along the edges of fairways and greens that are already on the overlay, without anyone dragging boxes or placing sample trees first.

## 1. What we have today

- **Studio "Find trees" box** (`scripts/studio/courses/map-overlay/map-overlay-page.js` `runTreeFinder`, engine in `map-overlay-shapes.js` `treeFinder`). It needs 1–12 hand-placed trees this session to learn crown colour and size, then inside a dragged box it marks every pixel of that colour, opens/closes the mask, takes a distance transform, and the deepest peaks become tree centres. Six sensitivity levels (← →), Enter keeps, Esc discards. Capped at 150 trees a run.
- Imagery comes from `captureBox` — stitched tiles from the mounted provider at ~0.3 m/px, up to 1400 px a side. Only works on providers whose tiles are CORS-readable (LINZ, NAIP, etc.); Mapbox pictures are never stored.
- Features: `tree` = a small ring round one crown, `trees` = a wood/cluster polygon. Overlay cap is 1200 features (`OVERLAY_MAX_FEATURES`).
- **Downstream today, single `tree` features are not read by anything.** The watch's trees (`gd-watch-map-core.js buildHoleTrees`) are *made up* inside each `trees` polygon — ragged edge + packed interior, deterministic. `tree` features are kept "for when tree rendering lands".
- Fairways, greens, tees, bunkers, water are all polygons with an optional `hole` number, so "near a green or fairway" is just geometry we already hold.

So the gap is not detection — it's that the finder needs a human to (a) tell it what a tree looks like here and (b) tell it where to look. The auto version has to answer both itself.

## 2. Options researched

| Option | Verdict |
|---|---|
| **A. Make the existing finder self-seeding (RGB only)** — learn "tree colour" from the picture itself using the fairway/green pixels as the known-turf reference, and search a band round the played shapes | **Do first.** No new data, no new infra, reuses the engine and the live-review UX. |
| **B. Canopy height model (Meta/WRI CHM v2)** — global ~1.2 m/px tree-height raster, CC BY 4.0, served as Cloud-Optimised GeoTIFFs with HTTP range + CORS from `https://data.source.coop/tge-labs/meta-chm-v2/chm/` (one COG per zoom-10 quadkey, uint8 metres) | **Do second**, as a gate: "is there really something ≥3 m tall here?" Kills shadows, dark rough, hedges, mown tree lines. Caveat: imagery is 2009–2020 — stale vs. our aerials — and 0 means both "no tree" and "no data". Not a replacement for the colour pass; a filter on it. |
| C. LINZ 1 m DSM (surface model) minus the DEM we already fetch = exact canopy heights for NZ | Checked `linz/basemaps-config`: the `elevation` tileset is DEM only (87 layers, all `dem_1m`/`dem_8m`), no DSM tiles. DSMs exist only as LDS downloads. **Skip** unless we want to host our own. |
| D. OSM `natural=tree` points (we already import them on "Start fresh from OSM") | Sparse on almost every course. Use as extra seeds when present, nothing more. |
| E. The existing AI vision scan | Vision models are good at "trace the fairway", bad at "give me 180 precise crown centres". **Skip** as a detector. |
| F. ML crown detectors (DeepForest, detectree) | Python/PyTorch — not something a Netlify function or the browser runs. **Skip** for this stack. |

## 3. Phase 1 — self-seeding finder in Studio

All in the browser, in the overlay page and shapes module, no server change.

**Trigger.** New method under the Trees tool, `auto` (joins `single, oval, draw, find, colour`): a button "Find trees near play" that runs for the current hole, or for every hole when none is selected (walks the holes with a status line). Same live result as today: ← → sensitivity, Enter keeps, Esc throws away.

**Where it looks.** For the hole's fairway(s) and green(s):
1. Band = the polygons buffered out to `TREE_BAND_M` (start at 40 m) minus the polygons buffered out to `TREE_CLEAR_M` (3 m).
2. Subtract every played surface on the course (fairway, green, tee, bunker, water, waste) plus 3 m, and any existing `trees` polygon or `tree` (that is the finder's `avoid` list, which it already supports).
3. Capture that band's bbox with `captureBox` at `TREE_FINDER_MPP`. A long hole at 0.3 m/px overflows 1400 px, so run one capture per fairway polygon and one per green rather than one per hole — captureBox already steps the zoom down if it must.

The band is passed to `treeFinder` as a pixel mask (`inside`), the way the grow wands already take an `inside` mask, instead of a rectangle `box`.

**What a tree looks like — with no samples.** Turf is the thing we *do* know: sample Lab colour from inside the hole's fairway and green (same `circleSamples`/`fieldSamples` helpers). Then, inside the band, a pixel is a crown candidate when all three hold:
- **darker** than the turf median L by a margin (crowns are 15–30 L units darker than mown grass in summer aerials),
- **still green** — a* negative, b* positive. This is what drops tree *shadows* (dark but grey/blue) and bare ground.
- **textured** — local standard deviation of L over a crown-sized window above turf's. Rough and mown tree lines are smooth; crowns are not.

Those candidate pixels become the `colourModel` pool, and from there it is the existing engine unchanged (threshold at a level → open/close → distance peaks → non-overlap). If hand-placed samples exist this session, use them instead — today's behaviour wins when a human has spoken.

**Crown size.** No samples means no measured radius. Default `radiusPx` from 4.5 m (the watch's own crown range is 3.5–6.5 m) and let the peak depth size each tree as it does now (0.5–2.2 × radius).

**Output.** `tree` features with `source: "finder"`, `hole` set, in one undo step per run. Per-run cap stays 150; a per-course run reports "Hole 7: 38 trees" as it goes.

**Tests.** `dev/map-overlay-shapes.test.js` gets a synthetic image case: flat turf polygon, a row of dark-green textured discs beside it, a dark grey shadow blob, and a dark smooth rough patch → finder returns the discs only, nothing inside the turf, nothing on the shadow.

## 4. Phase 2 — canopy-height gate

A small Netlify function `/api/canopy-height?north&south&east&west` that:
1. Works out the zoom-10 quadkey(s) covering the bounds, fetches the COG header + the needed window with `geotiff.js` range reads (same polite-fetch wrapper the tile fetcher uses), caches the tile in Supabase storage keyed by quadkey (a tile is a few MB; a course touches one or two).
2. Returns a small uint8 grid of heights for the bounds, in EPSG:3857 so it lines up with the capture.

Studio then multiplies the colour candidates by `height ≥ TREE_MIN_HEIGHT_M` (3 m) before peak-picking, and can take crown radius from the height blob's width when it is larger than the colour blob. Heights also give the watch something real to size trees by later.

**Before building this:** one `curl -r 0-1023 https://data.source.coop/tge-labs/meta-chm-v2/chm/3113330001.tif` from an unrestricted machine (that quadkey is Auckland) to confirm the path pattern and that range reads work. Both of my sandboxes allow-list that host away, so I could read the README but not the tile. If the path differs, `tiles.parquet` in the same bucket has a `cog_url` column per tile.

Licence is CC BY 4.0 — needs an attribution line next to the LINZ one in the imagery credits.

## 5. Phase 3 — make single trees count (your call)

Today an auto-pinned tree changes nothing on the watch or in the bubble. Two ways to make the work land:
- **Watch:** `buildHoleTrees` stamps the hole's `tree` features first (real position, real radius), then only invents trees inside `trees` polygons that have no single trees in them. Needs the surface pass to carry `tree` objects per hole the way it carries `trees`.
- **Bubble / plays-like:** treat a dense run of single trees as a `trees` hazard ring for the reveal (`bubble-visual.js` already draws `hazards.trees`).

This is a separate piece of work and I would not fold it into Phase 1.

## 6. Limits to decide up front

- **1200-feature overlay cap.** A tree-lined 18 could produce 800–1500 single trees. Options: raise the cap for `tree` only, or store finder trees as `{lat,lng,r}` triples in a separate `trees_auto` column rather than full ring features. I lean to the second — rings for a tree are 8 points of padding we never read.
- **Provider must be readable.** Same rule as the box finder: no CORS, no finder. Mapbox stays dry-run.
- **Season.** Deciduous trees in a winter survey are grey sticks; the colour pass will miss them and the CHM gate is the only thing that finds them. Worth surfacing "N trees found from height only" in the status so it is visible when that happens.
- **Band width** 40 m is a guess for "in play". Make it a session setting like `treeFinderLevel` so it can be tuned per course without a redeploy.

## 7. Build order

1. Band geometry + `inside` mask for `treeFinder` (shapes module) — tests first.
2. Turf-referenced colour model (`autoTreeModel(field, turfSamples, bandMask)`).
3. `auto` method + button + per-hole / all-holes loop + status in the overlay page.
4. Decide the storage cap question (§6) and apply it.
5. Phase 2 function + Studio gate, once the tile path is confirmed.
6. Phase 3 if wanted.

## Questions for you

1. Phase 1 only first, or do you want the canopy-height gate in the same pass?
2. Storage: raise the 1200 cap, or keep auto trees as compact triples?
3. Do you want trees on the watch from this (Phase 3), or is the overlay data the goal for now?

## Sources

- Meta/WRI canopy height, cloud-native mirror (COGs, quadkeys, CC BY): https://data.source.coop/tge-labs/meta-chm-v2/README.md and https://source.coop/tge-labs/meta-chm-v2
- Original dataset registry entry: https://registry.opendata.aws/dataforgood-fb-forests/
- LINZ Basemaps elevation tileset config (DEM only): https://raw.githubusercontent.com/linz/basemaps-config/master/config/tileset/elevation.json
- Individual tree detection from RGB aerials (local-maxima/crown delineation background): https://scholar.korea.ac.kr/handle/2021.sw.korea/113937 and https://mdpi-res.com/d_attachment/remotesensing/remotesensing-12-04104/article_deploy/remotesensing-12-04104.pdf
