# Clarity Scorecard OCR — project context

Companion to `CLARITY_TABLE_OCR_CONTEXT.md`. That one describes the practice
photo scanner; this is the copy of it that reads scorecards.

## Goal

Read a photo of a golf **scorecard** and produce `[{hole, par, distanceM}]` per
course on the page — enough for the geometry resolver to fingerprint a course
against its mapped loops (`SCORECARD_ENGINE_SPEC_2026-08-25.md`, Part B).

Not a playable card. Three fields per hole, gaps allowed.

## Why a copy rather than a shared module

The practice reader is proven on its own image and the whole reason it was
lifted out of `index.html` was that unrelated edits kept breaking it. Teaching it
a second layout would put that back. The geometry — value grouping, the
corridor column split, the outlier re-split, positional de-fuse — is copied
verbatim and marked as such at the top of the file; if it changes in one, change
it in both, deliberately.

## What was dropped

**The user-moves-lines step.** The practice scanner's failure path is
`gdOpenPracticeManualQuadTool()` — "drag the four pins onto the value-grid
corners" — and it takes that path four separate times: no flat image, fewer than
four columns, fewer than four resolved headers, and no usable rows. None of that
is here. `scanScorecard` runs on the image it is handed and returns
`{ok:false, stage, error, detail}` naming the stage that stopped it. Framing is
the caller's problem. A caller that has a flattener passes the flattened image
in; nothing in the module knows about one.

**The header alias registry.** A launch-monitor column is identified by reading
its header and matching `LAUNCH ANGLE` against an alias list (with a Levenshtein
fallback, added because `LAUNEH ANGLE` broke the exact match). A scorecard strip
is identified by its **values** instead, so no word on the card has to be read
correctly for the card to parse.

**The direction deep-scan.** No R/L markers on a scorecard.

## The transpose

A launch-monitor table is metrics across, shots down. A card is the other way
round: holes across, and each row labelled down the side.

```
Hole          1    2    3   ...  Out   10  ...  In    Tot
Index        15    1   11             4
Par           5    4    4   ...  36    4   ...  36    72
Championship 530  444  355  ... 3433  433  ... 3345  6778
```

So the **strips are rows**, and identifying a strip means answering "is this the
hole row, par, the stroke index, or a tee?".

## Files

- `scripts/clarity-scorecard-ocr.js` — pure, DOM-agnostic. Ported geometry
  (`splitColumns`, `clusterValueRows`, `groupComponentsIntoValues`,
  `stripBoundaries`) plus:
  - `trimOuterMargins` — pulls the outermost column boundaries in off x=0 to the
    values they contain. New here: `columnsFromCuts` runs its first boundary from
    the image edge, which on a card swallows the whole tee-name margin.
  - `readInteger` — OCR-tolerant integer parse that refuses words. `OUT` must not
    become `0UT`.
  - `classifyStrip` — the identification. Ordered most-specific first, because
    the ranges nest.
  - `labelForStrip`, `unitFromText`, `buildGrids`.
- `scripts/clarity-scorecard-ocr-pixels.js` — pixel glue. Runs **headless**
  (plain `{width,height,data}` buffers, canvas only at the edge) and picks ink
  polarity per scanline from the region's edge pixels, so a tee row reversed out
  of a colour band is not erased.
- `scripts/clarity-scorecard-scan.js` — the processor. Six stages, an injected
  `recognize(image, opts)`, no UI.
- `dev/scorecard-image-fixture.js` — test-only: renders a card from a 5x7 bitmap
  font into raw pixels, and reads glyphs back by template match.
- `dev/scorecard-ocr-*.test.js` — `npm run test:scorecard-ocr`.
- `dev/scorecard-ocr-harness.html` — browser harness, real Tesseract.

## Stages

| # | stage | what it does |
|---|---|---|
| 1 | `boxes` | pixels → connected components → row bands → value boxes |
| 2 | `read` | one small crop per box through the injected recognizer |
| 3 | `columns` | number-like boxes only → hole columns (ported corridor split) |
| 4 | `strips` | row bands → strips; the left margin read per band for a label |
| 5 | `identify` | each strip classified by its values, then rescoped to hole columns |
| 6 | `grids` | strips → grids of strings for `gd-scorecard-parse-core` |

Stage 5 runs twice on purpose. Out / In / Total are columns like any other until
a hole strip has been found, and a `3433` sitting in one of them pushes a tee row
out of every plausible distance range. The second pass drops the columns the hole
strip gave no number for and re-classifies. The hole strip itself needs no
rescoping: a totals heading is a word, so it never produced a number up there.

## The handover

Stage 6 emits **grids of strings**, and `parseScorecardCards(grids)` from
`functions/lib/gd-scorecard-parse-core.mjs` turns those into engine cards. That
is the same function, and the same card shape, the club-website path uses.

This is deliberate. The practice side ended up with two pipelines, two row shapes
and two storage tables, and the better one was the one nothing consumed
(`PRACTICE_DATA_PLAN_2026-08-13.md`). A photo lane with its own resolver would be
that again. Here the photo is just another adapter in front of one parser.

Consequences worth knowing:

- **Tee sets need no identification.** Every distance strip becomes a tee row;
  `preferredTee` takes second-from-longest. Matching is on relative structure, so
  picking the wrong tee costs nothing (Part A of the spec).
- **Labels are optional.** A distance strip whose label was unreadable becomes
  `Tee 1`, `Tee 2`. A readable one keeps its name because it lands in
  `teeOptions`, which is worth having and safe to be wrong about.
- **Units.** Only reported when a word on the card said so; otherwise null, and
  `toMetres` falls back to its magnitude test. A stated unit beats a guessed one,
  a guessed one beats nothing.
- **No 18-hole gate.** Twelve clean holes fingerprint a course.

## Two courses on one page

A hole strip opens a card. A second hole strip either continues it (10-18 under
1-9, a card printed in two halves) or starts a new one (1-18 again, two courses).
The test is **hole-number overlap**, and it is made in `buildGrids` rather than
left to the caller: get it wrong and Te Ārai North and South merge into one
36-hole card. A continuation emits a grid with no label so the parse core folds
it in; a new card emits a labelled one so it does not.

## Verified

`npm run test:scorecard-ocr` — three suites, all passing:

- `scorecard-ocr-strips` — identification and grid building, pure values in.
- `scorecard-ocr-split` — the column split on card geometry: 21 columns at a
  tight pitch, a wide label margin, fused reads, blank cells.
- `scorecard-ocr-image` — **end to end on real pixels**, which the practice
  reader has never had. A rendered card → detection → per-box reads → strips →
  identification → grids → `parseScorecardCards` → assertions against the
  rendered truth. Five cards: a full 18-across with totals and three tees, a
  stacked front/back nine, two courses on one page, a reversed-out tee row, and a
  card with cells blanked out.

## Known limits

- **Framing.** No perspective correction anywhere in this path. A card
  photographed at an angle will split badly and the scan will say so at the
  `columns` or `identify` stage. That is the deliberate trade for dropping the
  corner-stretch tool; auto-flattening is a separate job in front of this one.
- **Accuracy is the recognizer's.** The headless tests use a bitmap-font matcher,
  which proves the pipeline, not Tesseract's hit rate on a photographed card.
  That is what `dev/scorecard-ocr-harness.html` is for.
- **Not wired into the app.** Nothing calls `scanScorecard` yet; it is a module
  plus a harness. Wiring it to the course mapper's `scorecardEvidence` handoff
  (`functions/course-mapper-worker-background.mjs:1219`) is the next job.
