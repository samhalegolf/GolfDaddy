# Clarity Caddie Fresh Chat Handoff

Updated: 2026-06-06 NZST

Use this file to start a fresh Codex chat. It combines the current Shot Data / Practice Data product state with the deploy details.

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

Main working file for current product work:

`index.html`

Important:

- Current Shot Data / Practice Data work is local and has not been deployed.
- Production is still the older Netlify deploy listed below.
- The working tree is dirty with broad ongoing changes. Do not reset, clean, or revert unrelated files.
- Do not deploy unless Sam explicitly asks.

## Current Product Priority

The active work is the Shot Data / Practice Data system:

- Practice Data uses uploaded launch monitor captures and photo OCR to build a stored practice shot library.
- Practice data should be grouped by club and upload/import date.
- Plot filtering should happen after the stored library is built.
- A detected cluster becomes the "Practice Bubble" when it meets the criteria.
- Verification across other clubs is separate and should feed "Clarity Coach Helper" style recommendations, not mark a bubble as failed.
- Projected bubbles are theoretical overlays: one club by default, optional all clubs / selected clubs, scaled from the same physics-style dispersion logic.
- Offset Hub is a subtler central underlay concept, separate from the more visible practice/course bubble overlays.

Current local sample/state:

- Club: `7i`
- Stored practice rows visible in UI: about `12`
- Practice Bubble value seen locally: about `R 6.8 deg`
- Offset Hub value seen locally: about `R 1.6 deg`

Treat those values as current local demo/sample state, not hardcoded product assumptions.

## Current UI State

Practice Data page:

- The Practice Bubble result card was removed from the main surface.
- The Practice Bubble value is stored/shown inside library/admin surfaces instead of sitting as its own large result block.
- "Practice Library" is now a single dropdown-style button.
- When Practice Library opens, stored rows and filtering controls appear below it.
- Import actions are tucked behind an "Import" control at the bottom.
- Practice Bubble Projector is a single dropdown control on the Practice Data page.
- Projector defaults to one-club projection, with all-clubs and bag widget/draft bag behaviour available.

Course Data page:

- Course Library was moved toward the same library/dropdown structure as Practice Library.
- Course graph formatting was tightened to match the dynamic chart style.
- Sibling charts were updated to use the same core chart language where practical.

Comparison page:

- Practice Library and Course Library appear as large source tabs/cards.
- Practice Library is green to match rendered practice bubbles.
- Course Library is blue to match rendered course points/bubbles.
- The visible Practice Bubble Projector control was removed from Comparison.
- The comparison chart auto-renders the available projected Practice Bubble when the practice projection context can project.
- The "Overlay Offset Hub" button remains available for the subtler offset hub overlay.

## Chart / Bubble Rules

The chart should have clear internal physics:

- Everything should be graph-relative, not page-relative.
- Rotating the chart should not change the meaning of bubble orientation, points, or offsets.
- Practice and course plotted shots are simple flat dots, not diamonds.
- Practice plotted shots are green.
- Course plotted shots are blue.
- The old dotted cluster outline was removed from the comparison chart.
- The visible practice bubble is a solid green oval from the simulated dispersion logic.
- The practice bubble has an indented/darker internal label that says `PRACTICE`.
- Bubble colors distinguish bubble type rather than changing by club.

Relevant functions:

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

Older OCR/debug context:

`PRACTICE_PHOTO_OCR_HANDOFF.md`

## Known Caveats / Open Edges

- `index.html` has very large local changes. A recent `git diff --stat -- index.html` showed over 12k changed lines.
- Many unrelated files are modified/untracked. Do not clean the tree without asking Sam.
- Comparison library dropdown bodies may still need a product decision. Sam wanted extra stats/tolerance content removed from the visible comparison library area; verify whether hidden dropdown contents should also be removed or only kept out of the closed tab.
- The chart should be visually checked after cache-busting because the browser can hold stale inline `index.html` state.
- OCR/intake controls and cluster/bubble controls should remain conceptually separated.
- OCR debugging should live under debug/admin; Practice Bubble controls should reflect the cluster-finding / dispersion engine.
- Left/right direction extraction from OCR scans improved but should still be checked whenever new launch monitor image formats are added.

## Suggested Local Checks

Open:

`http://localhost:5173/?codex_bust=shot-data-handoff`

Visually check:

1. Practice Data page.
2. Course Data page.
3. Comparison page.
4. Practice Bubble is present on Comparison when available, without showing a separate projector control.
5. Green practice dots and blue course dots are visually distinct and flat.
6. Green Practice Library tab and blue Course Library tab match rendered data colors.
7. Decide whether comparison library dropdowns should have any compact admin/tolerance body content.

Script parse check:

```bash
node -e 'const fs=require("fs"); const html=fs.readFileSync("index.html","utf8"); const scripts=[...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]); for (let i=0;i<scripts.length;i++){ new Function(scripts[i]); } console.log(`parsed ${scripts.length} inline scripts`);'
```

Whitespace check:

```bash
git diff --check -- index.html
```

## Deployment Summary

Production app:

`https://clarity-caddie.netlify.app/`

Netlify project:

- Project: `clarity-caddie`
- Admin: `https://app.netlify.com/projects/clarity-caddie`
- Project ID: `998dc390-a3da-4fe1-95c3-c441abcca54e`
- Account: `Samuel Hale <samhalegolf@gmail.com>`
- Team: `Sam Hale Golf`

Current production deploy:

- Deploy ID: `6a1d08ca742f62b1fffbe194`
- Deploy URL: `https://6a1d08ca742f62b1fffbe194--clarity-caddie.netlify.app`
- Deploy logs: `https://app.netlify.com/projects/clarity-caddie/deploys/6a1d08ca742f62b1fffbe194`
- Function logs: `https://app.netlify.com/projects/clarity-caddie/logs/functions`
- Edge function logs: `https://app.netlify.com/projects/clarity-caddie/logs/edge-functions`

This deploy is from the mapped GPS corridor-frame work and predates the current local Shot Data changes.

Production `index.html` should include:

```html
<script src="scripts/gd-course-library-pin-lock.js?v=hole-corridor-frame-20260601"></script>
```

Production script should include:

- `mappedHoleFrameProfile`
- `settledMaxZoom`
- `effectiveLength`
- `settleMappedHoleZoom`

Production verification:

```bash
curl -L -s https://clarity-caddie.netlify.app/ | rg "hole-corridor-frame-20260601|gd-course-library-pin-lock"
```

```bash
curl -L -s 'https://clarity-caddie.netlify.app/scripts/gd-course-library-pin-lock.js?v=hole-corridor-frame-20260601' | rg "mappedHoleFrameProfile|settledMaxZoom|effectiveLength"
```

## Deploy Command

Only run when Sam explicitly asks to deploy:

```bash
npx netlify deploy --prod
```

The project uses `.netlifyignore` to avoid publishing local-only files when deploying from the repo root.

Current `.netlifyignore` exclusions:

- `.git`
- `.netlify`
- `.vercel`
- `node_modules`
- `.DS_Store`
- `*.zip`
- `*HANDOFF*.md`
- `CLARITY_NEW_CHAT_HANDOFF.md`
- `eng.traineddata`

## Netlify Configuration

Config file:

`netlify.toml`

Current config:

- Publish directory: `.`
- Build command: empty
- Functions directory: `functions`
- HTML no-cache/no-store.
- Scripts/styles cache for one hour.
- Assets cache for one week.

API redirects:

- `/api/email-notification` -> `/.netlify/functions/email-notification`
- `/api/support-ticket` -> `/.netlify/functions/support-ticket`
- `/api/course-maps` -> `/.netlify/functions/course-maps`

Functions:

- `functions/course-maps.mjs`
- `functions/email-notification.js`
- `functions/support-ticket.js`

Course maps:

- API: `/api/course-maps`
- Store: Netlify Blobs
- Store name: `clarity-course-maps`
- Blob key: `published-course-maps-v1`

## Environment Variables

Email:

- `RESEND_API_KEY`
- `EMAIL_NOTIFICATIONS_ENABLED=1`
- `CLARITY_EMAIL_FROM`
- `CLARITY_SITE_URL=https://clarity-caddie.netlify.app`

Support/Supabase:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY` fallback only

Do not print or request secret values in chat unless Sam explicitly asks to configure them.

## Pre-Deploy Checks

Run these before any deploy:

```bash
node --check scripts/gd-course-library-pin-lock.js
```

```bash
node <<'NODE'
const fs=require('fs');
const html=fs.readFileSync('index.html','utf8');
const scripts=[...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]);
let failed=0;
scripts.forEach((code,i)=>{try{new Function(code);}catch(e){failed++;console.error(`Inline script ${i+1} failed: ${e.message}`);}});
console.log(`${scripts.length} inline scripts checked; ${failed} failed`);
process.exit(failed?1:0);
NODE
```

```bash
git diff --check -- index.html scripts/gd-course-library-pin-lock.js
```

If deploying Shot Data changes, also visually verify `Practice Data`, `Course Data`, and `Comparison` locally with a cache-bust URL before production.

## Production GPS Context Still Worth Knowing

The live production focus before the current Shot Data push was mapped GPS/course framing:

- Mapped GPS play mode.
- OSM auto mapping and published course map sync.
- Course selection opens straight to Hole 1.
- Mapped hole camera orientation and corridor framing.
- Mapped courses should not silently fall back into old green-centre/two-tap flows.

Primary file for GPS deploy work:

`scripts/gd-course-library-pin-lock.js`

Search terms:

- `mappedHoleFrameProfile`
- `frameMappedHoleForPlay`
- `mappedHoleViewPoints`
- `settledMaxZoom`
- `effectiveLength`
- `settleMappedHoleZoom`

If future visual checks say mapped holes are too wide, tune `mappedHoleFrameProfile()` first.

