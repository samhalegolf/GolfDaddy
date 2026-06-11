# Clarity Caddie Shot Data Handover

Updated: 2026-06-06 18:22 NZST

## Start Here

Project path:

`/Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current`

Local app:

`http://localhost:5173/`

Run locally:

```bash
npm start
```

Branch:

`main`

Main working file for this handover:

`index.html`

Important: this is local work and has not been deployed. The working tree is dirty with broader ongoing changes. Do not revert unrelated files.

## Current Product Direction

The active work is the Shot Data / Practice Data system:

- Practice Data uses uploaded launch monitor captures and photo OCR to build a stored practice shot library.
- The user wants practice data grouped by club and upload date, with plot filtering happening after the library.
- A detected cluster becomes the "Practice Bubble" when it meets the criteria.
- Verification across other clubs is a separate process and should feed "Clarity Coach Helper" style recommendations, not mark a bubble as failed.
- Projected bubbles are theoretical overlays: one club by default, optional all clubs / selected clubs, scaled from the same physics-style dispersion logic.
- Offset Hub is a subtler central underlay concept, separate from the more visible practice/course bubble overlays.

## Current UI State

Practice Data page:

- The Practice Bubble result card was removed from the main surface.
- The Practice Bubble value is stored/shown inside library/admin surfaces instead of sitting as its own large result block.
- "Practice Library" is now a single dropdown-style button.
- When the Practice Library button opens, the stored rows and filtering controls appear below it.
- The import actions are tucked behind an "Import" control at the bottom.
- The Practice Bubble Projector is a single dropdown control on the Practice Data page.
- Projector defaults to one-club projection, with options for all clubs and a bag widget/draft bag behaviour.

Course Data page:

- Course Library was moved toward the same library/dropdown structure as Practice Library.
- Course graph formatting was tightened to match the dynamic chart style.
- Sibling charts were updated to use the same core chart language where practical.

Comparison page:

- Practice Library and Course Library appear as large source tabs/cards.
- Practice Library is styled green to match rendered practice bubbles.
- Course Library is styled blue to match rendered course points/bubbles.
- The visible Practice Bubble Projector control was removed from the comparison page.
- The comparison chart now auto-renders the available projected Practice Bubble when the practice projection context can project, even if the user has not clicked render on the Practice page.
- The "Overlay Offset Hub" button remains available for the subtler offset hub overlay.

## Current Chart / Bubble Rules

The user asked for the chart to have clear internal physics:

- Everything should be graph-relative, not page-relative.
- Rotating the chart should not change the meaning of bubble orientation, points, or offsets.
- Practice and course plotted shots are now simple flat dots, not diamonds.
- Practice plotted shots are green.
- Course plotted shots are blue.
- The old dotted cluster outline was removed from the comparison chart.
- The visible practice bubble is a solid green oval from the simulated dispersion logic.
- The practice bubble has an indented/darker internal label that says `PRACTICE`.
- Bubble colors distinguish the type of bubble rather than changing by club.

Current overlay styling lives in:

- `gdShotBubbleOverlayTypeStyle`
- `gdShotBubbleOverlayLayerMarkup`
- `gdShotBubbleOverlayBubbleParts`
- `gdShotBubbleOverlayBubblePath`
- `gdShotChartLayout`
- `gdShotChartEnsureLateralRange`

## Important Code Anchors

Reusable library dropdown shell:

- `gdShotDataLibraryShellHTML`
- `gdToggleShotDataLibrary`
- `gdShotDataLibraryIsOpen`
- `gdCompareCourseCompact`
- `gdComparePracticeCompact`
- `gdRenderPracticeEvidenceList`
- `gdRenderCourseEvidenceList`

Practice projector:

- `gdPracticeProjectionContext`
- `gdPracticeProjectionControlsHTML`
- `gdRenderPracticeProjectionControls`
- `gdPracticeProjectionMode`
- `gdPracticeSetProjectionMode`
- `gdPracticeBagWidgetHTML`
- `gdRenderComparePracticeProjector`

Note: `gdRenderComparePracticeProjector` intentionally hides/clears the old comparison projector control. The comparison chart itself still uses the practice projection context.

Comparison chart:

- `gdCompareSvg`
- `gdCompareCoursePoints`
- `gdComparePracticePoints`
- `gdPaintCompareVisual`
- `gdRenderDataHubCards`
- `gdCompareSourceTab`
- `gdCompareSetSource`

Practice OCR / import:

- `gdRunPracticePhotoOcr`
- `gdImportExtractedPracticeScan`
- `gdBuildPracticeCellGrid`
- `gdRenderColumnOrderOcrSummary`
- `gdRenderValueGridCropPreview`
- `gdRunDirectColumnStripCrops`

Older OCR bridge handoff:

`PRACTICE_PHOTO_OCR_HANDOFF.md`

## Current Data State

The current local demo state is centered on imported/extracted 7 iron practice data:

- Club: `7i`
- Stored practice rows visible in the UI: `12`
- Practice Bubble value seen in the UI: about `R 6.8 deg`
- Offset Hub value seen during the session: about `R 1.6 deg`

The deploy chat should treat those numbers as current local sample/state, not as a permanent hardcoded product assumption.

## Known Caveats / Open Edges

- `index.html` has very large local changes: `git diff --stat -- index.html` showed over 12k changed lines.
- There are many unrelated modified/untracked files in the repo. Do not clean the tree or reset files without asking Sam.
- The comparison library dropdown bodies may still need a final product decision. The user wanted the extra stats/tolerance content removed from the visible comparison library area; verify whether hidden dropdown contents should also be removed or just kept out of the closed tab.
- The chart should be visually checked again after cache-busting because the browser can hold stale inline `index.html` state.
- The OCR/intake controls and cluster/bubble controls should remain separated conceptually. OCR debugging should live under debug/admin, while Practice Bubble controls should reflect the cluster-finding / dispersion engine.
- Left/right direction extraction from the OCR scan improved, but the native wiring should still be checked whenever new launch monitor image formats are added.

## Verification Already Run

Inline script parse check:

```bash
node -e 'const fs=require("fs"); const html=fs.readFileSync("index.html","utf8"); const scripts=[...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]); for (let i=0;i<scripts.length;i++){ new Function(scripts[i]); } console.log(`parsed ${scripts.length} inline scripts`);'
```

Result:

`parsed 34 inline scripts`

Whitespace check:

```bash
git diff --check -- index.html
```

Result:

clean.

## Suggested Next Checks

1. Open `http://localhost:5173/?codex_bust=shot-data-handoff` and visually check the Practice Data, Course Data, and Comparison pages.
2. On Comparison, confirm the practice bubble is always present when a practice bubble is available, without showing a separate projector control.
3. Confirm the green practice dots and blue course dots are visually distinct and flat.
4. Confirm the green Practice Library tab and blue Course Library tab match the rendered data colors.
5. Decide whether the comparison library dropdowns should contain any compact admin/tolerance body content, or be pure navigation/source tabs.
6. Before deploying, rerun the inline script parse check and `git diff --check`.

