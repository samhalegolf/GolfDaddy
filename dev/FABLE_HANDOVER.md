# Clarity Table OCR — Handover (per-strip value read bug)

## What we want (intended system)
Photo of a launch-monitor results table → flatten (4-corner stretch, **leave untouched**) →
read the values into the Clarity Shot Library. The design, stage by stage:

1. **Detect number boxes** from pixels (connected components → grouped value boxes). Geometry only.
2. **Split columns** on the vertical gaps between value boxes → cut lines.
3. **Cut each column into its OWN physical strip image** (a `<canvas>`), full height.
4. **Name each strip** by OCR-ing the text at its top (header) → metric key via the alias registry.
5. **Read each strip top-to-bottom** and slot values into row positions by y. A missed value just
   leaves a blank so everything stays aligned. **There is no "row grid"** — strips are read
   independently and lined up by position/index.
6. **Reassemble** rows by index, map each `metricKey` → native shot structure, save.
7. **Club** comes from the left "offcut" column (the same club repeats every row → majority vote).

Key principle the owner has repeated: the powerful OCR pass is used **only to find geometry**, then
those reads are **thrown away** and each strip is **re-scanned** for values. Misreads are fine as
placeholders; cleanup happens at the adapter. Do **not** reintroduce a detected "row grid",
column-count gating, or speed optimizations — those were tried and reverted.

## Current state
- Flatten, box detect, column split, strip cutting, header naming (≈10/12 named correctly), and
  club-from-offcut all **work**. The strip montage looks clean and correctly cut.
- **Broken: the per-strip value read.** Extraction output is mostly blank/garbage even though the
  strip images are clearly legible.

## The bug (symptoms from the live import preview)
Real table row 1 = `ballSpeed 94.4, launch 11.2°, sideAngle 3.7°, backspin 4596`.

Import preview produced:
```
row1: 0.0mph, 1.0°, -1.0°, 0      <- PHANTOM (matches nothing real)
row2: 94.4,   11.2°, 3.7°, 4596   <- real row 1, reads PERFECTLY across all columns
row3: 0.0,    2.8°,  3.7°, 4274   <- backspin=real row2, others wrong/blank
row4: 0.0,    2.8°,  3.8°, 4693   <- backspin=real row3
row5: 0.0,    12.6°, 3.5°, 0
row6: 0.0,    12.6°, 0.0°, 0
row7: 0.0,    12.4°, 0.0°, 5366
```
Two distinct problems:
1. **Phantom top row** — a sparse stray cluster at the very top of the grid becomes row 1 and shifts
   every real shot down a slot. (Being addressed: `dataRows` now drops rows with far fewer boxes than
   a real data row. Confirm this holds.)
2. **Systemic patchy read** — the FIRST real row reads perfectly across ALL columns, then later rows
   degrade; each strip reads a *different* subset of rows; `ballSpeed` is blank on almost every row.
   This is the core bug. A split in one column (there is a stray split down sideAngle) cannot cause
   this — it's in the reader, shared by all strips.

## Where the bug is — `gdClarityReadStripsIntoRows` (index.html)
The reader, per named strip:
- crops the strip top→`dataBottom+4`, **upscales ×2.6**, OCRs the whole thing as one block (psm 6),
- gets lines via `gdLmLinesFromOcrData`, divides each line `cy` by the upscale FACTOR back to flat
  coords, and slots into `dataRows` bands (`cy` within `[y0-tol, y1+tol]`, nearest-center wins),
- any band with no line gets a **targeted re-scan**: tight crop of just that row band, upscaled ×3.4,
  psm 7.

Reassembly (`perStrip.map(s=>s.cells[r])`) and payload (`gdClarityScanResultToPayload`, maps by
`cell.key`) are **correct and order-independent** — ruled out.

## Prime hypotheses to check (in order)
1. **psm 6 block read on a tall narrow strip is unreliable** — Tesseract's line segmentation on a
   1-column strip merges/drops lines, so only some rows produce a line. The per-miss psm-7 re-scan is
   supposed to recover the rest but appears not to. **Check the re-scan actually runs and returns text
   for a known-good band; consider reading each row band directly (psm 7 per band) instead of the
   block pass, or psm 4 (single column).**
2. **`dataRows` y-bands drift/misalign after the first row** — first real row reads perfectly, later
   rows patchy. Verify `clusterValueRows` band `[y0,y1]` positions actually match each real row's
   pixels down the whole strip (not just the top). If bands are too narrow or spaced wrong, both the
   block match and the re-scan crop miss.
3. **Plausibility dropping valid reads** — `gdClarityScanResultToPayload` drops any cell with
   `plausible===false`; `parseCell`/`metricPlausible` (scripts/clarity-table-ocr.js) may reject a
   valid read whose decimal was lost (e.g. `94.4`→`944` → implausible for ballSpeed → dropped →
   blank). Check whether ballSpeed is reading `944`-style and being discarded.

## Diagnostics already added (use them)
- **Stage 1 checkpoint** now prints a per-column breakdown: `c0[n]:sample,sample…`.
- **Extraction checkpoint** now prints a per-strip read dump: `ballSpeed: 94.4,·,·,…` (`·` = blank).
  This will show whether each strip is reading empty vs reading something we then discard.

## Key files / functions
- `index.html`: `gdClarityTableOcrScanFromCheckpoint` (adapter, Stage 1-3),
  `gdClarityReadStripsIntoRows` (**the reader — bug lives here**), `gdClarityCutStrips`,
  `gdClarityNameStrips`, `gdClarityStripProfile`, `gdClarityScanResultToPayload`,
  `gdClarityUpscaleCanvas`, `gdLmLinesFromOcrData`.
- `scripts/clarity-table-ocr.js`: `splitColumns`, `clusterValueRows`, `parseCell`, `metricPlausible`,
  `resolveMetricKey`, `stripBoundaries`.
- `scripts/clarity-table-ocr-pixels.js`: `detectNumberBoxes`, `cropCanvas`, `connectedComponents`.
- Deploy: edit root `index.html`, then `cp` to `dist/index.html` (publish dir). Module `<script>` tags
  carry a `?v=` cache-buster — bump it when a module file changes.

## Do NOT
- Reintroduce column-count gating or a "geometry vs OCR" mode switch (reverted).
- Chase speed — the owner does not care if a scan takes minutes; correctness only.
- Assume any fixed column order/count.
