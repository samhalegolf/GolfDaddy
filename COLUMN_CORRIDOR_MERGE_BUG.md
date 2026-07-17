# Clarity Caddy — Column Corridor Merge Bug

Investigation summary for external review. Codebase: `GolfDaddy` repo, file `index.html` (single-file app, all functions below live in inline `<script>` blocks). Line numbers are current as of this write-up.

## 1. Symptom

On a real test photo (`IMG_5365.JPG`, 12 shot rows), the "column splitter" stage of the photo-scan pipeline (Value Corridor Mapping) mis-detects column boundaries:

- **Ball Speed** and **Side Angle** come back as `MISS` on every single row (12/12).
- **Launch Angle** comes back with impossible values: `1944.0`, `7123.0`, `716108.0`, `10258.6`.
- The debug panel shows corridor **C01** is 432px wide, while every other corridor is 120–160px wide.
- The header-evidence text captured for C01 contains fragments of three different header labels mashed together: `BALL SPEED`, `LAUNCH ANGLE`, and `SIDE ANGLE`. Only one label ("Launch") could be assigned to the whole corridor.
- The same thing happens at the right edge: corridor **C09** ("Total") is 342px wide (should be ~160px), consistent with **Total** and **To Pin** also merging.
- Because two corridors effectively vanished, everything after C01 also picked up wrong labels — "Offline" is assigned to two different corridors (C02 and C06).

Net effect: 3 real columns (Ball Speed / Launch Angle / Side Angle) get read as one column, and their digits get concatenated/garbled. Same for Total / To Pin. The other 7 columns read correctly.

## 2. What this is NOT

**Not the direction-masking system.** That's a separate, later stage (turns a confirmed value into an L/R marker) and only runs on values that were already read correctly. This bug happens earlier, before any value is even assigned to a metric.

**Not a difference between "column splitter" and "skewer."** These aren't two competing detection algorithms. "Skewer" (`valueSkewerX`) is a single diagnostic line drawn through the median x of the confirmed values inside a corridor — it's evidence/QA overlay, not a second cut-detection method. The actual column boundaries ("cuts") always come from one method: the clearance-corridor logic described below. Comment straight from the code (line 17182): *"Column cutouts use synthetic borders made from value-box spacing; the blue value skewer is evidence, not the cut line."*

## 3. Pipeline (call chain)

```
gdLmNumberBoxesFromCandidates(candidates, sourceImage, w, h)      [line 15335]
  → gdLmNumberBoxFromCandidate(candidate, ...)                     [line 15296]
      → gdLmCandidateDigitBoxes(candidate)                         [line 15276]  (see 4.2 below)
      → gdPixelTightDetectedValueOverlayBoxes(image, word, w, h)   [line 12558]  (fallback, actually used)
  → gdLmClearanceRowsFromNumberBoxes(boxes, cfg)                   [line 15459]
      → gdLmMergeValueBoxIntervals(items, cfg.mergeGap)            [line 15435]  ← merges adjacent boxes into one "interval" per row
  → gdLmClearanceCorridorBands(rows, cfg)                          [line 15479]  ← scans for x positions that are clear across most rows
  → gdLmPruneClearanceCuts(bands, cfg)                             [line 15529]
  → gdLmColumnsFromClearanceCuts(rows, cuts, cfg)                  [line 15544]  ← builds the final corridor list from surviving cuts
gdLmClearanceCorridorConfig(boxes, sourceWidth)                    [line 15419]  ← computes corridorWidth / mergeGap / edgeGuard
```

## 4. Root cause

### 4.1 Confirmed: `mergeGap` re-merges adjacent-but-distinct columns (leading hypothesis)

`gdLmClearanceRowsFromNumberBoxes` (line 15459) calls `gdLmMergeValueBoxIntervals(items, cfg.mergeGap)` (line 15435) on every row. This function's job is to glue together OCR fragments that belong to the *same* value — e.g. if Tesseract splits `94.4` into two word-boxes `94` and `.4`, they need to be treated as one interval so the gap search doesn't invent a fake column boundary in the middle of a single number.

The problem: this merge is purely geometric (`box.x0 - previous.x1 <= mergeGap`) and has no way to tell "two fragments of one value" apart from "two different values in adjacent columns that happen to sit close together." In this photo, Ball Speed / Launch Angle / Side Angle are spaced closer together than the other columns, so their individual (already correctly separated) number boxes get glued into one wide interval before the gap-search even runs. Once that happens, `gdLmClearanceCorridorBands` (line 15479) can never find a clean divider there — the interval already spans across the true boundary — so no cut is placed, and the whole span collapses into one corridor (C01). Same mechanism explains the Total / To Pin merge at C09.

`cfg.mergeGap` comes from `gdLmClearanceCorridorConfig` (line 15419):
```js
corridorWidth: Math.max(8, Math.min(28, sourceLimit, medianWidth * .38))
mergeGap: Math.max(4, Math.min(16, corridorWidth * .65))
```
So `mergeGap` is somewhere in the 4–16px range depending on the median value-box width for this photo — evidently still wide enough to bridge the real gap between Ball Speed and Launch Angle (and Total/To Pin) in this particular image.

**This matches what's visible in the debug photo overlay**: the individual green "confirmed value" boxes drawn per-word (via `gdPixelTightDetectedValueOverlayBoxes`, called directly against the raw photo at line 12843, for the debug view) are correctly separated — no merging visible there. That confirms the per-value tightening itself is fine; the merge happens one step later, in the row-interval construction that's specific to the corridor-detection path.

### 4.2 Confirmed dead code: the "confirmed digit" preference path is unreachable

`gdLmCandidateDigitBoxes` (line 15276) prefers three metadata fields, in order:
```js
candidate?.pixelTightDigitBoxes,
candidate?.confirmedDigitComponentBoxes,
candidate?.tightComponentBoxes
```
None of these three field names are ever *assigned* anywhere in the file — confirmed via full-file search for `fieldName:` (object literal) and `.fieldName =` (assignment). Every candidate falls through to the second branch in `gdLmNumberBoxFromCandidate` (line 15315), which calls `gdPixelTightDetectedValueOverlayBoxes` directly against the raw OCR word box. So this looks like the "tightened tolerance / confirmed-digit" refinement that was intended to feed corridor mapping, but it was never wired up to actually populate those fields — it's a dead preference branch, not currently doing anything. It isn't the direct cause of the merge (4.1 is), but it's a real gap between what the code was meant to do and what it does, worth cleaning up regardless.

### 4.3 Ruled out: edge-guard blocking a divider near the left/right frame edge

`gdLmClearanceCorridorBands` (line 15526) excludes any candidate cut within `cfg.edgeGuard` of either frame edge:
```js
edgeGuard: Math.max(8, corridorWidth * .65)
```
Given `corridorWidth` is capped at 28, `edgeGuard` tops out around 18px. The two missing dividers inside C01 would need to fall roughly a third and two-thirds of the way across a 432px span (~x=140 and x=290) — nowhere near an 18px edge margin. Mathematically this shouldn't be able to explain the C01 merge. Worth a second look only if 4.1's fix doesn't fully resolve things.

## 5. Not yet done

No fix has been applied to the corridor-detection logic. This write-up is diagnosis only, for review before deciding on the change, since this stage is foundational (it currently produces correct output for the other 9 of 11 columns, so any fix needs to be scoped carefully to not regress those).

## 6. Suggested direction (for review, not yet implemented)

The most targeted fix consistent with 4.1: detect corridors that come out anomalously wide relative to the median corridor width (e.g. >1.6x), and re-run the interval/gap search *inside just that span* with a substantially tighter `mergeGap`, splicing any new valid cut back into the column list. This is additive — it only engages for outlier-width corridors, so it shouldn't touch the 9 columns that already read correctly. Separately, 4.2 (dead metadata fields) could be either wired up properly (if there's a real per-candidate "confirmed digit component" source meant to feed it) or removed if it's stale.
