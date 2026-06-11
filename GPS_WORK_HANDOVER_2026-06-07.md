# GPS Work Handover

Updated: 2026-06-07 NZST

## Purpose

This handover is for the next chat working specifically on GPS in Clarity Caddie.

The important framing from Sam: he did not work on GPS during the latest Practice Data pass, so the deployed GPS behaviour is likely the healthier baseline. Keep that deployed/mapped GPS flow intact and fit any GPS/course-data work around it instead of replacing it.

## Current Project

Project path:

`/Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current`

Production app:

`https://clarity-caddie.netlify.app`

Current production deploy:

- Deploy ID: `6a23c2ecd2ca1d172906e6ac`
- Deploy URL: `https://6a23c2ecd2ca1d172906e6ac--clarity-caddie.netlify.app`
- Logs: `https://app.netlify.com/projects/clarity-caddie/deploys/6a23c2ecd2ca1d172906e6ac`
- Netlify project ID: `998dc390-a3da-4fe1-95c3-c441abcca54e`

Deployment now builds to `dist/`:

- `netlify.toml` uses `publish = "dist"`
- `package.json` uses `npm run build:netlify`
- `scripts/clarity-deploy-build.js` copies only app assets into `dist/`

Do not assume older handovers are correct about deployment. Older notes that say Netlify publishes from repo root are stale.

## Current Safety Notes

The working tree is dirty and contains unrelated local work. Do not revert broad file changes.

Do not deploy unless Sam explicitly asks. The current production app already has the cleaned deploy structure and the Practice Data merge. For GPS work, use the live production behaviour and current local files as references, but make narrowly scoped changes.

Login must stay front and centre. Sam hit a case where a link opened straight into admin mode, probably browser memory/localStorage. A fresh browser context was verified after the last deploy and showed the login gate, not admin:

- `bodyClass`: `gdAuthLocked gdProfileOpen`
- `permission`: `player`
- Login/create-account surface visible
- Admin surface not visible

Before testing GPS, first verify auth in a fresh/incognito browser or with localStorage cleared. Browser memory can retain admin permission, mapped mode, tournament mode, or previous route state.

## GPS Product Baseline

Keep the mapped GPS play mode as the baseline:

- Course selection should open Play/GPS cleanly.
- Mapped courses should frame the current hole with the existing corridor/camera logic.
- Unmapped courses should still have the two-tap/manual flow.
- Mapping tools should be available only when appropriate.
- Pin-Lock should remain tied to mapping/editing, not ordinary play unless intentionally opened.
- Scorecard, next-hole movement, and tournament mode must continue to coexist with GPS.

If deployed GPS and local GPS differ, prefer the deployed behaviour unless the difference is clearly caused by the latest local changes.

Likely real-world courses to test against if available in the account/course data:

- Akarana
- Muriwai
- Windross

## Main Code Anchors

Most GPS work is spread across a large `index.html` plus GPS/course-map helper scripts. Search for these anchors rather than trusting line numbers, because the file moves often.

### Entry And GPS Mode

File: `index.html`

- `enterGpsModule`
- `gdGpsPlayMode`
- `openScorecard`
- `gdFinalToolScreenIsolationV1`
- `gdMappedPlayModeToggle`

`enterGpsModule(opts={})` is the main transition into GPS. It closes panels, hides home, sets the shell layer to GPS, activates the dock state, pushes the route, reveals the course screen, refreshes the assumed course from location, invalidates the map, and refreshes badge/tool UI.

### Live GPS Fix Handling

File: `index.html`

- `gdGpsState`
- `gdGpsLocateNow`
- `gdGpsRequestButtonFixV1`

The newer GPS robustness patch keeps:

- `permissionKnown`
- `permissionGranted`
- `lastFix`
- `lastFixAt`
- `lastError`
- `activeRequest`

It remembers successful geolocation fixes, can reuse a recent fix for about 90 seconds, and exposes `window.gdGpsLocateNow`.

Desktop testing can produce permission/fix failures. That is not necessarily a product bug. Confirm whether a failure is live GPS, browser permission, stale storage, or fallback/manual flow.

### Course Mapping And Mapped Hole Framing

File: `scripts/gd-course-library-pin-lock.js`

- `mappedHoleFrameProfile`
- `frameMappedHoleForPlay`
- `mappedHoleViewPoints`
- `syncPublishedCourseMaps`
- `window.gdCLSyncPublishedCourseMaps`
- `window.gdFullMappingMode`
- `gdMapperToolsBtn`

This is the heart of mapped course behaviour. The deployed GPS baseline included mapped GPS play mode, OSM auto mapping, published course map sync, Course selection opening Hole 1, and mapped hole camera/corridor framing.

Be very careful changing this file. If the issue is UI-only, prefer fixing UI state around it instead of touching the map geometry.

### Pin-Lock

File: `scripts/gd-course-library-pin-lock.js`

- `pinLockBusy`
- `pinLockSelectedHole`
- `openPinLockSheet`
- `window.gdOpenPinLockSheet`
- `gdPlacePinLock`

Pin-Lock belongs to course mapping/course data improvement. It should not leak into locked-down/tournament play in a way that lets users edit data by accident.

### Shot Flow And Course Data Collection

File: `index.html`

- `gdGpsNewShot`
- `gdRecordShotEventPoint`
- `gdRecordShotEvent`
- `gdCaptureCurrentPlannedShot`
- `gdLogBallPositionForTracking`
- `gdUseNextShotPosition`

Current behaviour to preserve:

- `gdGpsNewShot` needs a shot start or target before proceeding.
- In manual mode, or when geolocation is unavailable, it starts manual shot verification.
- With geolocation, it requests a fix and passes the result to next-shot positioning.
- `gdRecordShotEvent` is admin-only and disabled in tournament mode.
- Shot-event recording captures the planned shot if present, logs ball position, and surfaces paired/unpaired state.

This is also the bridge into course data collection. Any future work should decide what data from GPS play becomes course data, what data stays personal/player data, and what gets promoted to the course-data landing point.

### Scorecard And Next-Hole Flow

File: `index.html`

- `gdPlayFlowNextHoleV1`
- `gdPlayHoleFromScorecard`
- `gdQueueScoreThenNext`
- `gdSyncPlayFlowRail`
- `openScorecard`

The next-hole flow manages scorecard rail interaction, quick tap/long press/swipe, prompts near the green, and moving to the next mapped hole. This is a high-risk area because it touches GPS state, scoring, and UI navigation together.

### Tournament Mode

File: `index.html`

- `gdTournamentModeV1`
- `gdTournamentModeEnabled`
- `gdSetTournamentMode`
- `gdTournamentModeRow`

Tournament mode disables or blocks mapping tools, wind, green tool, and data access. It toggles `body.gdTournamentMode`, forces mapping off while enabled, and restores previous mode when disabled.

Any GPS work must check tournament mode before exposing edit/data controls.

### GPS Badge

File: `scripts/gd-gps-badge.js`

- `gdHydrateGpsBadge`
- `window.gdFullMappingMode`

This script keeps GPS/mapping badge state in sync with the app shell. It is small, but visible state bugs often show up here.

### GPS And Mapping UI Styles

File: `styles/gd-course-library.css`

- `.gdMapperToolsBtn`
- `body.gdFullMappingMode`
- `.gdMapperToolFlyout`
- `.gdMapperHoleStrip`
- `.gdMapperHoleGuide`

File: `index.html`

- `body[data-gd-tool-screen]`
- right-rail mapped/unmapped tool visibility
- mapped/unmapped tool screen CSS near `gdFinalToolScreenIsolationV1`

There is UI work that extends across course data and comparison. When touching GPS UI, check that the same surfaces do not break Practice Data, Course Data, or comparison flows.

## Course Data Landing Connection

There is a separate handover for course data landing work:

`COURSE_DATA_LANDING_HANDOVER_2026-06-06.md`

For GPS, the key open question is the connection between collecting course data during play/mapping and where that data lands.

Suggested model for the next pass:

1. Capture raw player/GPS observations during play.
2. Keep personal shot/performance data separate from shared course facts.
3. Promote candidate course facts through an explicit review/admin step.
4. Show course-level data in a course landing point.
5. Reuse that landed course data in comparison views.

Do not silently turn every GPS event into published course data. That would mix personal play, noisy GPS fixes, and course truth.

## Recommended Next Workflow

1. Start with a fresh browser auth check.
2. Reproduce the GPS issue with a clear matrix:
   - course
   - hole
   - mapped or unmapped
   - live GPS or manual
   - tournament mode on/off
   - admin or player
   - fresh storage or remembered browser
3. Compare production and local behaviour before editing.
4. Make one focused GPS change at a time.
5. Avoid broad rewrites in `index.html`.
6. If a static file is added for GPS/course data, confirm `scripts/clarity-deploy-build.js` copies it into `dist/`.
7. Deploy only when Sam asks.

## Suggested Verification

Static checks:

```bash
node --check scripts/gd-course-library-pin-lock.js
git diff --check
npm run build:netlify
npm exec -- netlify build
```

Browser checks:

- Open `https://clarity-caddie.netlify.app/?codex_bust=gps-20260607` in a fresh/incognito browser.
- Confirm login gate appears first.
- Sign in with the intended test account.
- Open Play/GPS.
- Select a mapped course and confirm Hole 1 frames correctly.
- Toggle mapped/unmapped tooling if available.
- Open and close Map Tools.
- Try Pin-Lock only in an allowed mapping/admin context.
- Trigger manual/two-tap GPS fallback.
- Open Scorecard and move to the next hole.
- Enable Tournament Mode and confirm mapping/data edit controls are blocked.
- Check Course Data and comparison UI surfaces still look coherent after GPS changes.

## Known Gotchas

- Browser localStorage can make the app look like it skipped login.
- Admin state, tournament mode, mapped mode, and previous route state can survive between tests.
- Live GPS can fail on desktop for permission, browser, or simulated-location reasons.
- Mapped geometry lives mostly in `scripts/gd-course-library-pin-lock.js`; UI state lives in both `index.html` and CSS.
- The deploy now publishes `dist/`, so a file existing in repo root does not mean it ships.
- Practice Data and Course Data changes are now part of the production app. Do not regress those while working on GPS.

## Quick Mental Model

GPS has four overlapping layers:

1. Auth/session gate: user must land in login/profile correctly.
2. Play GPS shell: entering GPS, route/shell state, course screen visibility.
3. Course map intelligence: mapped holes, corridor framing, OSM/course-map sync, Pin-Lock.
4. Data layer: shot events, course observations, admin review, course landing/comparison.

Most bugs come from crossing layers without checking mode state first.
