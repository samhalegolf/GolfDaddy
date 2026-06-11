# Practice Photo OCR Handoff

Focus file: `index.html`

Do not deploy unless Sam asks.

## Current Decision

Freeze the squaring/flattening work. The current job is only:

`flat table image -> fitted rows/columns/cells -> output table`

Do not change the broad table square, whole-page value-shape finder, or 4-corner stretch method unless Sam explicitly asks. The fallback for bad geometry is a better photo or a later separate method, not hidden fallback logic.

Keep these paths intact:

- Broad screen/table square: `gdDetectLaunchMonitorTableQuad`, `gdNormalizeLaunchMonitorTable`, `gdWarpQuadToCanvas`
- Whole-page value-shape finder: `gdVisualValueClusterIsolation`, `gdVisualNumberBoxesForRow`, `gdVisualSupportedNumberRows`, `gdVisualNumberBoxTracks`, `gdRobustFitLine`
- Manual correction tool: `gdOpenPracticeManualQuadTool`, `gdRenderPracticeManualQuad`, `gdApplyPracticeManualQuad`
- Flat-image debug surface: `gdRenderValueGridCropPreview`

## Current UI State

- The scan checkpoint now emphasizes `Flat table image - bridge target`.
- The old column splitter is parked in a collapsed `Parked column splitter tool` panel.
- The source/geometry views are parked/collapsed so they are available but not the main work surface.
- The `Try column splitter` button still runs the old splitter path, but treat it as a tool/reference, not the final plan.
- The output should be a table again, via `gdRenderColumnOrderOcrSummary` or its replacement.

## Next Task

Build the bridge from the flat image to the output table:

1. Start from the straight flattened image only.
2. Find number/text boxes on that flat image.
3. Use those boxes to fit a TrackMan-style table template.
4. Draw vertical cut lines through the gaps between stacks of number boxes.
5. Fit row bands from the repeated value rows.
6. Produce a real table: rows x known columns.
7. Only after the table geometry is reliable, bring OCR cleanup/normalisation back.

## TrackMan Template Idea

Now that the image is straight, treat the values like repeatable TrackMan tiles.

Use the same “find text and box it” idea that helped the image flattening, but use it to size and fit the template:

- Detect boxes around numbers/text on the flat image.
- Do not treat those boxes as the final OCR answer yet.
- Use the boxes as anchors to infer column stacks, row spacing, and cell boundaries.
- Fit a template over the straight table: column x-bands, row y-bands, header/average/std-dev bands.
- Cut cells from the fitted template rather than freehand slicing columns.

## L/R Detail Plan

Run number extraction and direction-marker extraction as parallel passes.

For columns that need `L/R` detail, such as side angle, side spin, and offline:

- Use the fitted cell/template positions to know where each value ends.
- Try a tighter pass near the end of the number for the tiny marker.
- Alternatively, remove/mask known number glyphs from the cell image, then hunt only for `L` and `R`.
- Allocate found markers back to rows by page position.
- Preemptively blow up/sharpen the hard cells before OCR, instead of waiting for the first OCR run to fail.

## Non-Goals

- Do not tweak the squaring/flattening method in this phase.
- Do not reintroduce broad hidden OCR fallbacks.
- Do not normalize values before the flat-image table geometry is reliable.
- Do not make the parked column splitter dominate the UI again.
- Do not deploy.

## Useful Existing Pieces

- `gdDrawPracticeClusterOverlay`: shows fitted value boxes and stretch lines.
- `gdDrawPracticeColumnSplitOverlay`: old parked splitter overlay.
- `gdRunDirectColumnStripCrops`: old splitter path, useful for comparison only.
- `gdRenderColumnOrderOcrSummary`: table-shaped output surface.
- `gdBuildPracticeCellGrid`: older cell-grid direction worth checking, but rebuild around the flat template if needed.
