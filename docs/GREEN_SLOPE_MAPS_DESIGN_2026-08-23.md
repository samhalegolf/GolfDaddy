# Green slope maps — design note

Status: theory, nothing built. Clarity Caddy.

## What already exists

The pipeline is closer to this than it looks. Reading it end to end:

| Piece | Where | State |
|---|---|---|
| Square, high-zoom green capture policy | `gd-visual-plan-core.mjs` `capturePolicy("green-surround")` — z20, 26m bleed, 1:1 lens | Exists, but see "what's broken" |
| DEM capture + terrain-RGB mosaic | `terrain-reference` role, `gd-imagery-sources.mjs` `reliefSpec()` | Working. z16 target, z17 cap |
| Elevation decode, blur, Horn slope/aspect, AO, m/px | `gd-relief-core.mjs` | Working. **Slope and aspect are already computed inside `hillshade()` and thrown away.** |
| Per-hole elevation published beside the frame | `h{n}.elevation.png` + sidecar meta (bounds, `metresPerPixel`, `elevationRange`, encoding) | Working, already downloaded by the app |
| Green polygon per hole | `greenShape` from the wand / automapper, carried through `holeAnchorPins` | Working |
| WebGL terrain-RGB renderer, in-shader height decode, shear inside the existing frame | `app/js/gd-terrain-mesh.js` + `painter.js` `attachMesh()` | Working |

So: HD green imagery, a DEM, a green outline, a shader that eats terrain-RGB. The missing pieces are a **green-scoped DEM capture**, a **surface fit**, and a **green-specific draw**.

---

## What's broken today

**1. The "super HD green" shot isn't super HD, and often isn't shot at all.**

`green-surround` asks for z20, but `captureGrid()` clamps it twice:

```js
const ceiling = Math.min(sourceCeiling, frameCeiling);
```

`frameZoom` is derived from the *hole* frame's 3072px cap, so on most holes the green gets clamped straight back to z19 — the corridor's zoom. And the planner then deletes it outright when the corridor footprint contains it. Both are correct decisions *for a hole frame*. They're wrong for a green view, because a green view is a **second frame with its own frameZoom**, and the clamp lifts on its own once you give it one.

**2. The DEM over a green is at z16 (~1.9 m/px), not the source's native z17 (~0.95 m/px).**

The course-wide `terrain-reference` is shot once at z16 and cropped per hole. Over a 35m green that's ~18×18 samples. At z17 it's ~37×37 — four times the samples, and it's essentially free: a green plus 25m bleed at z17 is one or two tiles.

**3. Stale comment.** The `terrain-reference` block in `planCourseVisualCaptures` still says relief "fetches a ready-made hillshade RASTER, and no region has a licensed one … which today nothing does." `reliefSpec()` now returns the DEM for exactly this role and it runs on every course. Delete the paragraph, it will mislead someone.

---

## The honest constraint

State this before designing anything, because it decides what the feature is allowed to claim.

- Best DEM you can get is **1m LiDAR** (LINZ NZ, 3DEP US), with **0.1m vertical quantisation** from terrain-RGB packing.
- A putting break is 2–3% over 3m — about **7cm of rise**. Your quantisation step is 10cm.

Per-pixel finite differences on the raw DEM will therefore produce **noise, not slope**. `gd-relief-core` already documents this failure mode ("concentric contour rings … reads as a topographic map printed on the fairway") and defeats it by blurring before differentiating. That works for a drawing. It won't survive being read as a number.

The way out is that a green is a *smooth low-order surface*. Fit it, and the quantisation averages down over ~1000 samples instead of being differenced across 2.

**What this feature can honestly claim:** which way the green falls, where the tiers are, roughly how steep each region is, where water runs off. Macro read.

**What it must never claim:** your putt breaks four inches right of the cup. That needs sub-decimetre survey data you don't have.

Ship it as *"how this green sits"*, not as a green book.

---

## Proposal

### Stage 1 — capture: a `green-detail` role

Two additions, both small:

```js
if (role === "green-detail") return Object.assign({
  role, label: "Green detail", quality: "green-hd",
  targetZoom: 20, minZoom: 19, maxZoom: 20,
  maxTiles: 120, bleedMeters: 22, bleedPx: 160,
  stitchLayer: 40, fixedZoom: true,
  ownFrame: true            // <- exempt from the hole's frameZoom clamp
}, greenSquareLens);

if (role === "green-elevation") return Object.assign({
  role, label: "Green elevation", quality: "green-dem",
  targetZoom: 20, minZoom: 17, maxZoom: 20,   // sourceCeiling pulls this to 17 on its own
  maxTiles: 24, bleedMeters: 28, bleedPx: 0,
  stitchLayer: 6, terrainStageOnly: true
}, greenSquareLens);
```

Then `specForItem` needs one more role on the DEM side:

```js
const wantsDem = item.role === "terrain-reference" || item.role === "green-elevation";
return wantsDem ? (source.terrain || null) : (source.imagery || null);
```

`ownFrame: true` means `frameZoomByHole` skips it — the green frame computes its own from its own (much smaller) bounds, so 3072px over a 60m green is ~0.02 m/px and the z20 imagery lands intact.

Cost per course: 18 extra imagery captures of ~4 tiles and 18 DEM captures of ~2 tiles. Trivial against the 320-tile corridor budget.

### Stage 2 — fit: `gd-green-surface-core.mjs`

New module, sits beside `gd-relief-core.mjs` and follows its shape — takes buffers, fetches nothing, testable.

```
in:  terrain-RGB buffer + bounds + metresPerPixel + greenShape polygon (lat/lng)
out: { grid, summary, confidence }
```

1. Decode via the existing `decodeElevation()`. Reuse it — it already handles all three encodings and the sanity gate.
2. Mask to `greenShape` plus a 7m collar. The collar matters: fitting to the polygon alone makes the edges of the fit wander, and the collar is where chipping happens anyway.
3. **Robust smooth fit.** Thin-plate spline, or a bicubic B-spline over a ~4m knot grid, solved with iteratively reweighted least squares so a bunker lip or a tree-shadow artefact inside the mask doesn't drag the surface. Regularisation tuned so the fit can represent a tier (a real ~0.5m step over ~5m) but not a 10cm quantisation staircase.
4. Sample the **analytic** gradient of the fit onto a regular 0.25m local-ENU grid: slope % and aspect (downhill bearing). No finite differences on raw heights, ever.
5. Derive the summary:
   - overall fall vector (area-weighted mean gradient)
   - high point / low point in green-local coordinates
   - tier ridges: local maxima of the fitted surface's second derivative along the fall direction
   - runoff edges: boundary cells with outward aspect and slope > ~4%

**Confidence, and the ability to say no.** Record the fit residual RMS. Two failure signals:

- **Residual too high** → you're fitting something that isn't a green (mask is wrong, or the DEM is junk).
- **Residual near zero** → you didn't get the 1m tier. `gd-imagery-sources` already records `nativeResolutionM: 1, fallbackResolutionM: 8` on the LINZ DEM and notes the fine grid "only exists where the LiDAR does", but there's no runtime way to know which you got. This is the detector: 8m data upsampled to z17 has essentially no content above 8m wavelength, so the residual after fitting an 8m-scale smooth collapses to nothing. Cheap and reliable.

On either signal, publish `confidence: "low"` and **the app shows no slope map**. Same philosophy as the existing "relief is a finish, not the frame" — a missing green map is fine, a wrong one is not.

### Stage 3 — publish

Alongside `h{n}.jpg` and `h{n}.elevation.png`:

- `h{n}.green.jpg` — the z20 green frame, north-up mercator, same `renderHoleSurfaceMercator` path
- `h{n}.green.elevation.png` — **the fitted surface re-encoded as terrain-RGB at 0.25 m/px**
- `h{n}.green.json` — summary, confidence, fit residual, DEM tier, bounds, polygon in frame pixels

That middle artefact is the load-bearing idea. `terrainRgbFromHeights()` already exists in `gd-relief-core`. By baking the *fit* back into the format the client already speaks, `GDTerrainMesh` needs no new decode path, no second format, and every consumer downstream is unchanged — it just gets a surface that's four times finer and free of quantisation. The 0.1m repacking step is now well below the fit's own smoothness, so it costs nothing.

### Stage 4 — draw

Four layers over the z20 aerial. The order matters and so does the restraint — this is where it goes silly.

**1. Slope tint.** Colour ramp on slope magnitude, but:
- **only inside the green polygon**, feathered ~1m at the edge so it isn't a sticker
- bands anchored to putting reality, not to the data's own range: `<1% / 1–2% / 2–3% / 3–4% / >4%`
- ~35% opacity over the aerial, so mowing lines and the actual green still read through
- a muted ramp (desaturated teal → sand → clay), not the full weather-map rainbow

**2. Downhill flow lines — the one that sells it.** Not an arrow grid; arrow grids look like wind maps. Instead seed points on a jittered ~2m grid and integrate short streamlines down the fitted gradient. Taper the head, fade the tail, make length proportional to slope so flat areas grow almost nothing. This is the layer that reads instantly as *water runs this way* and it's the difference between "pro tool" and "novelty overlay".

**3. Contours.** Iso-lines from the fitted surface at 15cm, with 30cm as a heavier index line. Because they come from the fit rather than the raw DEM, the contour-ring artefact `gd-relief-core` warns about cannot occur — that artefact *is* raw quantisation being contoured.

**4. The grid — how to do it without looking silly.**

Two rules:

- The grid must be **ground-projected, not screen-projected.** Draw a regular 2m lat/lng grid warped through the fitted surface using the same `d = h · pxPerMetre · tan(tilt)` shear `gd-terrain-mesh.js` already applies. A grid that bends *is* the slope information. A flat overlaid grid is decoration.
- **Modulate line opacity by local slope.** Invisible where flat, clear where it matters. A uniformly visible grid reads as a wireframe someone forgot to turn off; a grid that appears exactly where the ground moves reads as information.

Implementation is cheaper than it sounds. `gd-terrain-mesh.js`'s fragment shader already samples `heightAt()` four ways to build a normal — slope magnitude falls out of that for free. Add a `uMode` uniform and roughly:

```glsl
float slope = length(vec2(dzdx, dzdy));            // already computed for the normal
vec3 tint   = rampColour(slope);
float grid  = gridLine(vWorldMetres, 2.0);          // fract() on ground metres
base = mix(base, tint, uTintOpacity * insideGreen);
base = mix(base, vec3(1.0), grid * smoothstep(0.01, 0.03, slope) * 0.35);
```

Under ~20 lines in the shader, no new geometry, no new decode — because the texture it samples is the *fitted* surface, so per-fragment slope is now meaningful.

For the green view specifically, raise `exaggeration` from 2.5 to ~8–10. A hole moves 6m over 300m; a green moves 0.5–1.5m over 35m. The existing number is calibrated for the former and will render a green perfectly flat.

---

## Suggested order

1. Delete the stale `terrain-reference` comment. One minute, stops it misleading the next reader.
2. `green-elevation` capture role + the `specForItem` line. Now you have native-resolution DEM over every green and can look at what you actually got before building anything on it.
3. `gd-green-surface-core.mjs` — the fit, plus the confidence detector. This is the real work and the whole feature rests on it. Test it on Jacks Point against a green you know by eye.
4. Only if step 3's residuals look right: `green-detail` imagery + the green frame + the shader work.

Step 3 is the go/no-go. If the fit can't tell you which way a green you know falls, no amount of drawing fixes that, and the honest answer is that this feature waits for better elevation data.

## Open question

Whether the green view is a **separate view** (tap the green → dedicated screen) or a **zoom state** of the existing hole frame. Separate is cleaner — its own frame, own zoom, own draw settings, no interaction with the play surface's framing or tap maths. But it's a new screen. Worth deciding before Stage 4, since it determines whether `ownFrame` is a capture flag or a whole second render path.
