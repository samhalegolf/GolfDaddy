# Clarity Table OCR — project context (for a fresh reviewer)

Hand this to a model/reviewer alongside the Codex audit. It describes the goal,
the architecture, what's built, and the open problem, so you can reason without
re-deriving everything.

## Goal
Read a photo of a launch-monitor results **table** (screenshot of a sim like the
one exported by the user's monitor) and turn it into structured shot rows that
import into the app's "Clarity Shot Library". Columns are metrics (Ball Speed,
Launch Angle, Side Angle, Backspin, Sidespin, Descent Angle, Offline, Peak,
Carry, Total, To Pin — 11 columns). Rows are shots (13 data rows + AVERAGE +
STD DEV summary rows). Direction markers (R/L) appear on Side Angle, Sidespin,
Offline.

## Why the rebuild
The reader lived tangled inside a single 54k-line `index.html`, where unrelated
edits kept breaking its data flow. It has *worked before on the exact test
image* — this is not an accuracy-from-scratch problem, it's "get the working
design functioning reliably and stop it regressing." So the OCR reader was
lifted into an **isolated, testable module** and plugged back in.

## Hard boundary (do not change the left side)
```
[ APP — kept, untouched ]                         [ MODULE — the rebuild ]
 camera/upload -> 4-corner stretch -> flatten  ->  split -> headers -> extract -> rows -> import
```
The app's 4-corner stretch + flatten (`gdWarpQuadToCanvas`,
`gdNormalizeLaunchMonitorTable`) works well and is the module's INPUT. The module
only ever receives the **flattened value-grid image**.

## Files
- `scripts/clarity-table-ocr.js` — pure, DOM-agnostic module. Stages:
  - Stage 0 `groupComponentsIntoValues` — group ink components into tight value
    boxes with a data-driven gap threshold (prevents adjacent columns fusing).
  - Stage 1 `splitColumns` — corridor/clearance column split ported from the
    working code, plus `positionalDefuse` (last-resort split of an
    outlier-wide corridor when OCR fused values).
  - Stage 2 `allocateHeaders` / `resolveMetricKey` — resolve a strip's header
    text to a metric key via the alias registry, with a **fuzzy (Levenshtein)**
    fallback for OCR typos; `trimUnresolvedEdges` drops phantom edge columns.
  - Stage 3 `parseCell` — parse a cell string to `{value, direction, valid}`
    with per-metric plausibility validation (rejects garbage like launch=942031).
  - Helpers: `numberBoxesFromWords`, `headerTextForColumns`, `clusterValueRows`,
    `isSummaryLabel`.
- `scripts/clarity-table-ocr-pixels.js` — browser glue: binarise -> connected
  components -> row bands -> value boxes (`detectNumberBoxes`), plus `cropCanvas`.
- `scripts/gd-launch-monitor-alias-registry.js` — existing header alias registry
  (`canonicalKey(text) -> metricKey`, `entries`, `headerLabel`).
- `index.html` -> `gdClarityTableOcrScanFromCheckpoint(checkpoint, opts)` — the
  ADAPTER. Wired in as: `Scan` -> `gdPracticePrimaryScanAction` ->
  `gdRunDefaultPracticePhotoScanFromCheckpoint` -> this adapter. The old
  corridor/header/column pipeline is bypassed (dead code, purge later).
- `dev/table-ocr-*.test.js` — headless Node tests (boxes, split, semantics,
  words). Run `node dev/table-ocr-split.test.js` etc. All currently pass.
- `dev/table-ocr-harness.html` — browser harness to run on a flattened PNG and
  diff against ground truth.
- `dev/fixtures/launch-monitor-7i.groundtruth.json` — the 13 correct shot rows.

## Current adapter flow (per-box OCR)
1. `PIX.detectNumberBoxes(flat)` -> candidate boxes from pixels (reliable
   geometry; whole-image Tesseract was tried and MISSED ~1/3 of values + garbled
   headers, so it was abandoned).
2. OCR **each box on its own small crop** (accurate), each call bounded by
   `gdClarityOcrWithTimeout(..., 9000)`.
3. Classify: number-like -> `numberBoxes` (feed the cut); leftover text ->
   `textBoxes` (headers). This is "filter to number-like before the cut."
4. `splitColumns(numberBoxes)`; `clusterValueRows(numberBoxes)`.
5. Header band = topmost text-box row; per column, join its text boxes ->
   header text -> `allocateHeaders` (fuzzy) -> `trimUnresolvedEdges`.
6. Requires >= 4 resolved headers, else stops and reopens the stretch tool.
7. Per row x column, join the number boxes in that cell -> `parseCell`. Skip
   AVERAGE/STD DEV rows (`isSummaryLabel` on the left-margin label).
8. Emit the scanner's structured output (rows of `{club, cells:[{key,value,
   direction,valid}]}`), then hand it through the SINGLE CHECKPOINT
   `gdClarityScanResultToPayload` -> native `clubGroups` (via `gdLmMetricForKey`)
   -> `gdImportLaunchMonitorPayload`. No text round-trip.
The whole run is a durable job (`gdPracticeStartImportJob`) with a `finally`
fail-boundary so a stall/early-return can't leave the UI stuck.

## Endpoint architecture (three parts, one checkpoint)
- **Scanner output format**: `[{ club, cells:[{key,value,direction,valid}] }]`.
- **Checkpoint / adapter**: `gdClarityScanResultToPayload(scanRows)` — the ONLY
  place scanner-format becomes library-format. Runs each value through the alias
  step `gdLmMetricForKey(key, value)`. Direction encoding: for direction columns
  (sideAngle/sideSpin/offline) Left = negative, Right = positive (matches the
  working pipeline at index.html ~12042).
- **Shot Library landing point**: payload `{label, inputType, clubGroups:[{
  originClubLabel, candidateClub, expectedDistanceM, metrics:[gdLmMetric...]}]}`
  -> `gdImportLaunchMonitorPayload` -> native store. Unchanged destination.

## History of resolved problems (all fixed, on branch)
- **Header allocation bounce** (deploy-preview 42): club `7i` read as `7` ->
  phantom left column -> everything shifted -> headers didn't line up; header
  band collapsed to `0-29`; `LAUNEH ANGLE` failed exact alias match. Fixed by:
  `trimUnresolvedEdges` (drop unresolved edge columns), self-locating header band
  (topmost text-box row), fuzzy Levenshtein alias fallback.
- **`Read 0 shots` / import hand-off** (Codex + Fable audit): the adapter
  serialized structured cells back to CSV text and fed `gdBuildLaunchMonitorText
  Capture`, which splits on whitespace and needs `label: value` pairs -> parsed
  nothing. Fixed by the direct three-part hand-off above (no text round-trip).
- Summary rows (AVERAGE/STD DEV) skipped; durable/timeout/cancelable scan job.

## Current status
No known structural blockers remain. The pipeline is proven headlessly (4 node
suites pass) and the import hand-off is now direct/aliased. Remaining risk is
ordinary ACCURACY tuning surfaced on a real scan (a header OCR-misread, a cell
crop slightly off) — visible as a wrong/missing value vs ground truth, not a
hang or a 0-shot bounce. Next: deploy the branch, scan, diff against
`dev/fixtures/launch-monitor-7i.groundtruth.json`, nudge anything off.

## Design decisions (settled via the Codex + Fable review)
1. Per-box small-crop OCR: KEEP (correctness first; bounded by the 9s timeout).
   Cheap wins later: skip boxes below summary rows; geometry-classify header-band
   boxes without OCR.
2. Club column: `trimUnresolvedEdges` works (13->11 this run). Add explicit
   club-column detection only if a real regression appears.
3. Header band: self-location works this run. "Top of each cutout" is more robust
   across monitors but not worth churning until a second layout fails.
4. Partial rows: unresolved headers become MISSING metrics, not a failed scan;
   keep the >=4-header gate only as the bounce floor.
5. Future polish (not blocking): per-column header text currently joins band
   boxes by x0 only; multi-line headers can interleave. Sort row-then-x if it
   misreads.

## How to verify
- Headless: `node dev/table-ocr-split.test.js` (and boxes/semantics/words). All
  pass today.
- Real pixels: deploy the `clarity-table-ocr-module` branch (Netlify deploy
  preview), scan a table, read the Admin stage markers (they print column count,
  resolved header text per strip, rows read).
- `main` is untouched; all work is on branch `clarity-table-ocr-module`.
