# Phase 1 Soft-Launch Handover

Updated: 2026-06-09 NZST

## Mission

Make Clarity Caddie feel truthful, stable, and app-like for soft launch.

Phase 1 is not a redesign. It is a tight stabilisation pass for the current play/GPS-centred app.

Main principle:

GPS / play flow should feel like the main app. Scorecard, course library, profile, bag, and settings should support it without forcing the player through extra screens.

## Strict Scope

Work only on Phase 1:

1. Browser back
2. Distance display truth
3. Bubble scaling
4. Profile photo wiring
5. Readiness labels
6. Aim-line flashing

Do not work on these yet:

- scorecard popup removal
- next-hole switch redesign
- GPS pin/toggle merge
- moving pin distance to the shot card as a UX redesign
- wind HUD
- course memory storage
- automapping storage strategy
- booking import
- companion bubble
- outer-frame blackout
- carry line styling beyond what is needed for aim-line stability

If a Phase 2/3/4 issue is discovered, document it and stop. Do not expand the pass.

## App Details

Repo:

`/Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current`

Production URLs from the last known deploy in this thread:

- Custom domain: `https://caddy.claritygolf.app`
- Netlify subdomain: `https://clarity-caddie.netlify.app`
- Last known deploy URL: `https://6a25dd2ea8c3e52b0138f573--clarity-caddie.netlify.app`
- Last known deploy logs: `https://app.netlify.com/projects/clarity-caddie/deploys/6a25dd2ea8c3e52b0138f573`
- Netlify project ID: `998dc390-a3da-4fe1-95c3-c441abcca54e`

Deploy setup:

- `netlify.toml`
  - `publish = "dist"`
  - `command = "npm run build:netlify"`
  - `functions = "functions"`
- `package.json`
  - `build:netlify`: `node scripts/clarity-deploy-build.js`
- `scripts/clarity-deploy-build.js`
  - copies `index.html`, `assets`, `scripts`, and `styles` into `dist`

Important: the deployed app comes from `dist`, not the repo root. Always run `npm run build:netlify` before serving or deploying.

Local smoke-test pattern:

```bash
cd /Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current
npm run build:netlify
cd dist
python3 -m http.server 5178
```

Then open:

`http://127.0.0.1:5178/?codex_bust=phase1-20260609`

## Current Repo Safety Notes

The working tree is dirty and includes intended app changes, generated handovers, assets, functions, styles, and deploy files.

Do not reset, clean, or discard unrelated files.

Treat the current local app as the working baseline unless a live production comparison clearly shows a regression. If production and local differ, compare carefully before changing GPS code.

Do not deploy unless Sam explicitly asks.

## Auth Must Stay First

Fresh browser state should land on the login/create-account screen, not admin.

Last verified fresh-browser behaviour after deploy:

- `bodyClass`: `gdAuthLocked gdProfileOpen`
- `permission`: `player`
- login visible
- create account visible
- no admin surface visible

Browser memory/localStorage can remember admin state. Before any Phase 1 browser testing, use an incognito/fresh context or clear localStorage.

## Primary Files

High-likelihood files:

- `index.html`
- `scripts/clarity-router.js`
- `scripts/clarity-player-settings.js`
- `scripts/gd-course-library-pin-lock.js`
- `scripts/gd-gps-badge.js`
- `styles/gd-course-library.css`

`index.html` is very large and contains many late patch scripts. Prefer targeted edits around existing anchors. Do not reorganise it during Phase 1.

## Phase 1 Work Items

### 1. Browser Back

Goal:

The browser back button and in-app Back should behave predictably across Home, GPS, Profile, Bag, Settings, Shot Data, Course Data, Practice Data, and Admin.

Expected behaviour:

- Fresh login still opens the auth gate.
- From Home -> Play/GPS, back should return to Home or previous app screen, not a blank panel.
- From GPS -> Profile/Bag/Settings, back should return to GPS when that is where the user came from.
- From data panels, back should return to the correct hub/home path.
- Browser back should not expose admin or skip auth.
- Browser back should not leave GPS map visible under module screens.

Code anchors:

- `scripts/clarity-router.js`
  - `state.history`
  - `navigate`
  - `back`
  - `legacyRemember`
  - `applyToDom`
- `index.html`
  - `shellRouteStack`
  - `lastShellModule`
  - `pushShellRoute`
  - `replaceShellRoute`
  - `openRoute`
  - `shellBack`
  - `enterGpsModule`
  - `openShellModule`
  - `data-gd-canonical-route-audit-v1`
  - back-target logic around `window.__gdBackTarget`

Implementation guidance:

- First decide which route system is the single source for browser back in Phase 1: `ClarityRouter`, `shellRouteStack`, or a bridge between them.
- Keep the patch small. A bridge from shell route changes into `history.pushState`/`replaceState` plus a `popstate` handler may be enough.
- Avoid broad route rewrites.
- Confirm old in-app back buttons still work.

### 2. Distance Display Truth

Goal:

Every distance shown during play should be traceable to real state. No stale course, stale target, hidden fallback, or fake "ready" distance should appear.

Expected behaviour:

- If there is no start/ball and no target/green, distance should show empty/placeholder state, not a made-up number.
- If there is a start and target, target distance should use current `map.distance` or the same stable distance helper.
- Pin distance and pin difference should not conflict with centre/target distance.
- Tournament mode should remain distance-only and should not show advice, wind, slope, club pick, or bubble.
- Mapped pre-lock state should not show a locked-shot distance until the player has actually set/confirmed a position.

Code anchors:

- `index.html`
  - `tileDist`
  - `tileSub`
  - `tileMeta`
  - `pinDiff`
  - `fmt`
  - `renderShot`
  - `clearShot`
  - `updatePinLine`
  - `gdShotPinDiffData`
  - `gdShotDisplayTarget`
  - `gdV62Distance`
  - `ensureDistance`
  - `renderTournamentShot`
  - `gdGreenEdgeDistanceMetrics`
- `scripts/gd-course-library-pin-lock.js`
  - `distance`
  - `routeLengthM`
  - `routeDistanceToPointM`
  - `gdPinLockDistance`

Implementation guidance:

- Audit the displayed labels and values before editing.
- Prefer centralising display decisions near `renderShot` and tournament render, not scattered DOM patches.
- Do not perform the Phase 2 UX move of pin distance unless it is the smallest way to fix a false display.
- Add a tiny helper only if it reduces duplication and keeps labels truthful.

### 3. Bubble Scaling

Goal:

Shot bubbles should scale sensibly from real shot/profile data and remain readable on mobile without dominating the map.

Expected behaviour:

- Bubble size should come from saved player/practice/course bubble data when available.
- Fallback bubble should be conservative and clearly derived from distance/club defaults.
- Mobile and desktop should show a similar perceived size.
- Profile preview bubbles and GPS play bubbles should not contradict each other wildly.
- Practice Data and comparison overlays should not regress.

Code anchors:

- `index.html`
  - `calculateCleanBubbleProfile`
  - `calculateCleanVisualBubbleRender`
  - `bubbleVars`
  - `playerBubbleReady`
  - `profileVisual`
  - `gdNormalizeGpsBubblePayload`
  - `gdFallbackGpsBubblePayload`
  - `gdShotBubbleSize`
  - `gdShotBubbleSimulatedModelPath`
  - `bubbleOuter`
  - `bubbleMain`
  - `bubbleCore`
  - `renderShot`
  - CSS vars near `--gd-shot-bubble-x`, `--gd-shot-bubble-y`, `--gd-shot-bubble-tilt`
- `scripts/gd-shot-cluster-analysis.js`
  - bubble analysis inputs if needed, but avoid changing analysis rules in Phase 1.

Implementation guidance:

- First inspect how current GPS bubble radius is calculated inside `renderShot`.
- Fix only display scaling, not the underlying statistical model.
- Avoid changing Practice Data analysis thresholds.
- If scaling differs by viewport, use stable CSS/layout constraints or a small render clamp rather than viewport-width font tricks.

### 4. Profile Photo Wiring

Goal:

Profile photo upload should save once and show consistently in the auth/profile/settings/home surfaces for the active account/profile.

Expected behaviour:

- Uploading from profile overlay updates the active profile image.
- Uploading from player settings updates the same active profile/account view.
- The photo remains after closing/reopening profile/settings.
- The photo survives reload in the same browser account data.
- Missing photo falls back to `assets/home/profile.png`.

Code anchors:

- `scripts/clarity-player-settings.js`
  - `refreshSection`
  - `gdPlayerSettingsPhotoPreviewImg`
  - `activeProfile.profilePhotoDataUrl`
  - `activeProfile.photoDataUrl`
  - `gdPlayerSettingsUploadPhoto`
- `index.html`
  - `profilePhotoDataUrl`
  - `photoDataUrl`
  - `profileVisual`
  - `gd67ProfilePhoto`
  - `gd67UploadProfilePhoto`
  - `gd67OpenProfilePhotoPicker`
  - `saveSafe`
  - account/profile update helpers around auth/profile scripts

Implementation guidance:

- Identify the real active account/profile source first.
- Do not create a second photo store.
- If settings and profile overlay use different save functions, make them converge on the same profile object and refresh path.
- Keep image resizing/compression; do not store full-size originals.

### 5. Readiness Labels

Goal:

Labels should describe real readiness. "Ready" should not mean "button exists" or "fallback placeholder exists".

Expected behaviour:

- `GPS ready` should only appear when GPS/play state is actually ready for the next user action.
- `Bag ready` should require at least one usable club/carry row.
- `Shot data ready` should require a real player bubble/shot data source.
- Course loaded/hole ready labels should not mask a stale course.
- Practice labels should not claim data is ready if only fallback/default data exists.

Code anchors:

- `index.html`
  - `stateLine`
  - `setState`
  - `GPS ready`
  - `setupStatusStrip`
  - `bagReady`
  - `playerBubbleReady`
  - `+ Add Bag`
  - `+ Enter Shot Data`
  - `Hole 1 ready`
  - `gdPracticeProjectionReadyAnalysis`
  - `gdPracticeProjectionContext`
- CSS near early profile/ready rules:
  - `.profile-ready`
  - `.profiles-ready`
  - `.ready-pill`
  - `[class*="ready"]`

Implementation guidance:

- Be cautious with the global `[class*="ready"]` CSS rule. It can make unrelated labels look like positive readiness.
- Prefer changing labels and state calculation before changing visuals.
- Use honest wording such as "Set bag", "Shot data needed", "GPS searching", or "Course loaded" when full readiness is not true.

### 6. Aim-Line Flashing

Goal:

The aim line should stay visually stable. It should not flash, flicker, or repeatedly disappear/reappear during normal GPS play.

Expected behaviour:

- Turning "Show aim line" on/off works.
- During a stable shot state, the aim line does not flash.
- Updating distance, pin, wind, or shot card does not recreate the aim line unnecessarily.
- Tournament mode still removes/block advice visuals.
- Undo/new shot still clears the right layers.

Code anchors:

- `index.html`
  - `aimToggle`
  - `toggleAimLine`
  - `showAim`
  - `aimLine`
  - `aimPixelGlows`
  - `gdClearAimPixelGlows`
  - `gdBuildAimLinePixelCanvas`
  - `gdAimLineFallbackEnd`
  - `gdAimLineEndPoint`
  - `gdRenderAimLine`
  - `renderShot`
  - `clearShot`
  - `removeLayerByName`
  - `pinDirectionLine`
  - `gdWindEffectLine`

Implementation guidance:

- First determine whether flashing comes from `renderShot` clearing/recreating map layers, CSS animation, repeated route refresh, or duplicate calls.
- Prefer making `gdRenderAimLine` update an existing polyline when start/end are unchanged instead of always recreating it.
- Keep `clearShot` authoritative for true shot reset.
- Do not change wind HUD or carry-line styling in this phase.

## Suggested Codex Prompt For The Next Pass

Use this prompt to keep credit usage low:

```text
Work only on Phase 1 in PHASE_1_SOFT_LAUNCH_HANDOVER_2026-06-09.md.

Do not start Phase 2, Phase 3, or Phase 4. Do not redesign GPS navigation, scorecard, course memory, wind HUD, booking import, or companion bubble.

First inspect only the files and anchors listed in the handover. Before editing, reply with the exact files/anchors you will touch and the minimal order of work. Then implement narrowly.

Keep login/auth front and centre. Use a fresh browser context for testing so browser memory does not hide auth bugs.

After editing, run targeted checks only:
- inline script parse for index.html
- node --check for any edited external JS
- git diff --check for edited files
- npm run build:netlify
- one browser smoke test of fresh login plus the touched Phase 1 flow

Stop after Phase 1 and write a short handover of what changed, what was verified, and what remains.
```

## Recommended Work Order

1. Browser back
2. Distance display truth
3. Aim-line flashing
4. Bubble scaling
5. Profile photo wiring
6. Readiness labels

Reasoning:

- Browser back and distance truth affect the core play flow most.
- Aim-line flashing is likely in the same `renderShot` area as distance and bubble display.
- Bubble scaling should be done after distance/aim-line truth is understood.
- Profile photo and readiness labels are lower-risk UI truth work once the GPS path is stable.

## Verification Commands

Run from the repo root:

```bash
node - <<'NODE'
const fs=require('fs');
const html=fs.readFileSync('index.html','utf8');
const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m=>m[1]);
let ok=0;
for(let i=0;i<scripts.length;i++){
  const src=scripts[i].trim();
  if(!src)continue;
  try{new Function(src);ok++;}
  catch(e){console.error('script',i+1,e.message);process.exit(1);}
}
console.log('parsed scripts',ok);
NODE
```

If edited:

```bash
node --check scripts/clarity-router.js
node --check scripts/clarity-player-settings.js
node --check scripts/gd-course-library-pin-lock.js
node --check scripts/gd-gps-badge.js
```

Always:

```bash
git diff --check
npm run build:netlify
npm exec -- netlify build
```

## Browser Smoke Tests

Use a fresh/incognito browser or clear localStorage.

Minimum checks:

- Fresh load shows login/create-account, not admin.
- Sign in.
- Home -> Play/GPS.
- Browser back from GPS returns safely.
- GPS -> Profile/Bag/Settings -> Back returns sensibly.
- Pick/select a mapped course if test data allows.
- Confirm distance label is absent or placeholder before real start/target.
- Confirm distance changes only from real start/target/pin state.
- Toggle aim line on/off and watch for flashing.
- Confirm shot bubble does not dominate the map on mobile width.
- Upload profile photo from one profile surface and confirm it appears in the other.
- Confirm readiness labels match actual bag/shot/GPS state.

Useful URLs:

- Local: `http://127.0.0.1:5178/?codex_bust=phase1-20260609`
- Production custom domain: `https://caddy.claritygolf.app/?codex_bust=phase1-20260609`
- Netlify subdomain: `https://clarity-caddie.netlify.app/?codex_bust=phase1-20260609`

## Stop Conditions

Stop and report instead of expanding scope if:

- fixing browser back requires a full router rewrite
- distance truth depends on a bigger course data model decision
- profile photo requires account migration/storage redesign
- bubble scaling exposes deeper Practice Data analysis issues
- aim-line flashing is caused by repeated GPS sensor/render loops outside `renderShot`
- any fix starts touching Course Library ownership or automapping storage

## Expected Credit Budget

If this handover is followed tightly:

- inspect and plan: 20-60 credits
- Phase 1 implementation: 100-220 credits
- build and smoke test: 30-80 credits

Expected controlled total: 150-360 credits.

The expensive version is letting the pass drift into Course Library, scorecard redesign, wind HUD, automapping storage, or booking import. Avoid that during Phase 1.
