# Terrain ingestion

Approve and configure an elevation provider once. From then on, Clarity works out which courses
it covers, fetches only the ground each course needs while baking, converts it to the Clarity
terrain format, and stores it as a versioned course asset. Wherever no better source exists,
the global dataset is used automatically.

Code: `functions/lib/terrain/`. Admin: Studio → Course database → **Terrain** tab, and
`/api/course-terrain`. Tests: `npm run test:terrain`.

## Where it sits

```
course_maps (geometry saved by Studio publish / AutoMapper)
   │  snapshot job queued (unchanged)
   ▼
course-visual-worker  runSnapshotJob
   │  courseBoundsFor(pkg)                   ← tees, greens, routes, green outlines
   ▼
ensureCourseTerrain   (gd-terrain-service)   ← reuse the current asset if still right, else:
   resolveTerrain     (gd-terrain-resolver)  ← registry + coverage + ranking → plan
   adapter.fetchTerrain (gd-terrain-adapters)← only course bounds + 450m margin
   reprojectToGrid / compositeLayers / fillGaps (gd-terrain-normalise)
   asset → course-visuals/<courseId>/terrain/v<N>/ + course_terrain row
   │
   ▼  (imagery gate - a course with no storable imagery stops here, WITH its terrain)
captures → runExportJob reads the terrain asset, crops it per hole → playSurface.elevation
   │
   ▼
Phone: 3D mesh, green contours, watch maps read playSurface.elevation (unchanged shape)
```

Terrain is baked **before** the imagery licence gate, and independently of it. Before this, a
course's elevation rode on its imagery entry, so a Northern Ireland course (no storable imagery)
had no baked terrain at all.

A `terrain` job kind on the same queue (`course_visual_jobs`) rebakes terrain on its own. When
it produces a new version and the course has published frames, it queues a re-export. Imagery
is never re-shot for a terrain change.

Runtime readers use the baked asset first and the resolver only as a fallback:

- the live 3D frame (`/api/live-terrain-frame`)
- the live-map hillshade (`/api/relief-tile`)
- the Studio relief preview (`/api/relief-preview`)

Each one cuts the window from the course's baked asset when the course is named and the asset
covers the window. Only ground no asset covers goes to the resolver.

## Provider registry (`gd-terrain-sources.mjs`)

| id | Region | Type | Resolution | Datum | Status |
|---|---|---|---|---|---|
| `linz-nz-elevation` | NZ | xyz-elevation (terrain-RGB) | 1m LiDAR / 8m | NZVD2016 | enabled (needs LINZ key) |
| `usgs-3dep` | US (CONUS) | arcgis-image-server (float32) | 1m / 10m | NAVD88 | enabled |
| `osni-ni-dtm10` | Northern Ireland | clarity-staged (Irish Grid TXT sheets) | 10m | Belfast MSL | approved, **not staged yet** |
| `gsi-jp-dem10b` | Japan | xyz-elevation (gsi-dem-png) | 10m | JGD2011 | enabled |
| `ga-au-dem-lidar-5m` | Australia | arcgis-image-server | 5m / 30m | AHD | disabled (endpoint retired) |
| `global-terrain-tiles` | everywhere | xyz-elevation (terrarium) | 25–30m | mixed MSL | enabled, always the fallback |

Each source must clear four gates before it is used:

- **Licence:** storage, derivatives and redistribution must all be granted. ShareAlike is refused.
- **Adapter:** one must exist for its `sourceType`.
- **CRS:** its horizontal CRS must be supported.
- **Configuration:** API key and/or staged copy must be in place.

A refused source is logged with its reason.

## The Clarity terrain asset

The format the mesh, green fit, export crop and watch maps already speak, now with provenance:

- `heights.png`: a terrain-RGB heightfield on a web-mercator pixel grid at an integer zoom
  (`originPx`, `captureZoom`, `width`, `height`). Heights are 0.1m-quantised metres.
- `mask.png`: 8-bit greyscale. `0` means no data, `1..254` is which source the pixel came
  from, and `255` means filled from nearest real ground.
- `manifest.json` is mirrored (minus arrays) into `course_terrain.manifest`. It holds:
  - the grid and the course and frame bounds
  - the margin and the elevation range
  - the output CRS (`EPSG:3857`), the source CRSs and the vertical datum
  - every source used, with id, dataset version, layer, resolution, licence, attribution,
    role (primary/detail/fill), pixel share and request stats
  - coverage: core, frame and filled fraction
  - the filled regions
  - quality: class, confidence and green detail
  - the strategy and the resolver's choice and log
  - provider failures
  - the format version and a resolver fingerprint (used to detect source updates)

Grid spacing is the best source's resolution ÷ 2, bounded between 0.75m and 3072px a side.
That works out at about 2.7m for a 10m source and about 0.9m for 1m LiDAR.

## Fallback behaviour

1. The resolver orders usable sources:
   - first, those whose declared coverage contains the course
   - then by quality class, then by resolution, then by priority
   - the global source always comes last
2. Sources are fetched in that order until one covers at least 98% of the mapped course (the
   **anchor**). Links courses keep sea inside their bounds, so 98% rather than 100%.
3. Each source that fails is recorded in `manifest.failures` with its code and the next one is
   tried. Failure codes: `timeout`, `rate-limited`, `network`, `http`, `malformed`, `coverage`.
4. Better sources ranked above the anchor that delivered some ground win where they have it.
   Sources below fill gaps. Both happen **only when the vertical datums are identical**.
   A different or unknown datum is never blended, because it would draw a step along the seam.
5. Whatever is still empty is filled from the nearest real ground and marked in the mask. The
   export refuses to fit a green that sits on filled ground.
6. If even the global source fails:
   - a course with an existing asset keeps it, and the failure is recorded on the row
   - a course without one gets `status: failed`
   - the snapshot carries on either way. Terrain never fails a course.
7. An asset that fell back because the preferred source failed is retried once the failure is
   24 hours old, not on every snapshot.

## Terrain quality

Thresholds are in `gd-terrain-config.mjs`. They are working defaults, not guarantees.

| Source resolution | Class | Green detail | Behaviour |
|---|---|---|---|
| > 15m | global | `none` | Broad landscape only; no slope lines |
| 2.5–15m | regional | `coarse` | Fairway shape, green surrounds; slope lines **off** |
| ≤ 2.5m, uniform | high-res / lidar | `allowed` | Slope lines on |
| ≤ 2.5m with a coarser tier (LINZ 1m/8m) | lidar | `conditional` | Lines on only where the green fit's own measured gate passes |

How the gate is applied:

- The export skips the green-surface fit when green detail is `coarse` or `none`.
- `playSurface.elevation.terrain.greenDetail` travels to the phone.
- `app/js/live-terrain.js greenReadable()` reads that verdict first, then the source spacing.
- The admin "Green lines on coarse elevation" switch still overrides the gate (now on published
  bakes as well as live frames).

## Adding a provider

Example: a 1m national LiDAR WMS-free tile service, or a new country.

1. Check the licence: storage, derivatives and redistribution must all be granted. Check the
   endpoint, resolution, CRS and vertical datum against the provider's own documentation.
2. Add one entry to `TERRAIN_SOURCES`:

```js
{
  id: "ea-england-lidar-1m",              // stable - stored in provenance
  name: "Environment Agency LiDAR DTM 1m",
  regions: ["GB-ENG"],
  coverage: { type: "polygon", rings: [[[-5.8, 50.0], [1.8, 50.9], /* … */]] },
  sourceType: "xyz-elevation",            // or arcgis-image-server, clarity-staged
  urlTemplate: "https://…/{z}/{x}/{y}.png",
  encoding: "terrain-rgb", maxUsefulZoom: 17,
  resolutionM: 1, fallbackResolutionM: 2,
  horizontalCrs: "EPSG:3857", verticalDatum: "ODN",
  licence: { name: "OGL v3", url: "…", storage: true, derivatives: true, redistribution: true, commercial: true, attributionRequired: true },
  attribution: { text: "© Environment Agency …", url: "…" },
  priority: 85, qualityClass: "lidar", enabled: true, datasetVersion: "2025"
}
```

3. If the provider only publishes files (like OSNI's sheets), use `sourceType: "clarity-staged"`
   with `staged: { bucket: "terrain-sources", tileSizeM }` and `datasetVersion: null`. Then:

```
node scripts/terrain/stage-terrain-source.mjs --source <id> --version <name> --input <files|dir> --upload
```

   Set `datasetVersion` to the printed name. Each course reads only the staged tiles under it.
4. Queue the courses it now improves: `POST /api/course-terrain {action:"rebuild-source", sourceId}`.
   This queues 25 per call; call again for the next batch. Every other covered course picks it
   up on its next snapshot.

Provider notes:

- **USGS** (`usgs-3dep`) is already registered.
- **LINZ** is registered for NZ.
- **OSNI** needs its sheets staged once:
  1. Download "OSNI Open Data – 10M DTM" sheets 1–293 (OGL) from Open Data NI.
  2. Run the staging script.
  3. Set `datasetVersion`.
- A **new format** (GeoTIFF/COG, WCS, LAS/LAZ) needs an adapter in `gd-terrain-adapters.mjs`
  plus its type in `IMPLEMENTED_SOURCE_TYPES`. Until then the resolver refuses entries of that
  type with the reason.
- A **new CRS** goes in `gd-terrain-crs.mjs` as a projection plus a `towgs84` datum shift.

## Finding upgrade opportunities

- `GET /api/course-terrain?report=upgrades` lists baked courses whose terrain could be better. It
  also groups courses on the global source by region, each with whether a regional source is
  configured and why it is not usable.
- `GET /api/course-terrain?report=sources` shows each registry entry, whether it is usable now,
  and how many courses use it.

That list is the brief for a research pass. Find a source, validate it, add it to the registry,
and every course in the region upgrades.
