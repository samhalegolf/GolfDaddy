# GSPro / OPCD export

Studio › Course Database › Terrain tab › **Export for GSPro**. One click writes the inputs
an OPCD (Open Platform Course Design) Unity build starts from, into the public
`course-visuals` bucket under `<courseId>/opcd/<version>/`, and lists them with links.

It does not build a GSPro course. The Unity/Blender/Inkscape work of the OPCD workflow is
still done by a person; this replaces the LiDAR download, reprojection and tracing that
workflow otherwise begins with.

## What is written

| File | What |
| --- | --- |
| `heightmap.raw` | 16-bit unsigned little-endian, 2^n+1 square (1025 / 2049 / 4097) at 1 m, north row first. 0 = base elevation, 65535 = base + range (both whole metres, in the manifest and README). |
| `heightmap.tif` | The same samples as float32 metres, GeoTIFF in the course's UTM zone. Open in QGIS to check orientation and to clip/reproject for OPCD's own tools. |
| `heightmap-preview.png` | 8-bit greyscale of the same rows, to eyeball against the aerial. |
| `surfaces.geojson` | WGS84. `kind`: terrain_frame, fairway, green, green_centre, tee, tee_area, bunker, water, woods, hazard, waste, hole_route. Point features carry `x_m`/`z_m` in the terrain frame. |
| `trees.csv` | Studio-placed and finder-found trees: lat/lng, UTM, frame metres, ground height, crown radius, height (`canopy` where the Meta/WRI raster measured it, `estimated` = 2.4 × crown radius otherwise). |
| `holes.csv` | Tee and green per hole with frame metres and ground height, par and route length where the scorecard is known. |
| `manifest.json` / `README.md` | Frame, encoding, Unity Import Raw settings, provenance and attributions. |

## The frame

A UTM square (EPSG:326xx / 327xx by the course centre) of side 1024, 2048 or 4096 m,
whichever first holds the play geometry plus a 100 m margin, origin snapped to whole metres.
Unity terrain coordinates: X = easting − originE, Z = northing − originN, Y = height − base.
A course wider than 4096 m is exported clipped and the manifest says so.

## Where the ground comes from

The course's baked terrain asset (`functions/lib/terrain/`), sampled Catmull-Rom onto the
metre grid. It is the same heights the phone's mesh and green contours read. A course with no
asset gets one baked as the job's first step. Ground the asset does not cover is
nearest-filled and the fraction reported; a course on the global 30 m fallback exports, but
the manifest and the Studio row flag that it is not LiDAR.

## Unity import

Terrain › Terrain Settings › Import Raw: Depth 16 bit, Byte order Windows, Resolution as the
manifest, **Flip Vertically on**, Terrain width/length = side, height = range. Verify against
`heightmap.tif` before building on it.

## Code

- `functions/lib/gd-opcd-export-core.mjs` — pure: frame, sampling, encodings, writers
- `functions/lib/gd-opcd-export-job.mjs` — the job on injected deps
- `functions/course-visual-worker-background.mjs` — runs kind `opcd_export` on the visual queue
- `functions/course-opcd-export.mjs` — `/api/course-opcd-export` (admin): queue, status, links
- `scripts/studio/gd-admin-course-terrain.js` — the Studio section
- `dev/opcd-export.test.mjs` — `npm run test:opcd`
