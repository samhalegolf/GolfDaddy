# Clarity Caddy Native App Planning Handover

Date: 2026-06-18
Branch: `native-app-planning`
Preserved branch: `deployed-golf-daddy-baseline`
Production commit: `1d996b2f1be31077c4154c2dd7085ea622318de2`
Native app name: `Clarity Caddy`
iOS bundle ID: `com.claritygolf.caddy`
Android package: `com.claritygolf.caddy`

## Completed in this branch

- Created branch `deployed-golf-daddy-baseline` from the production commit.
- Created branch `native-app-planning` from `main`.
- Renamed obvious public copy in `README.md`, `package.json`, and `src/content/landingContent.ts` from Clarity Caddie to Clarity Caddy.
- Added `capacitor.config.ts` for `Clarity Caddy` / `com.claritygolf.caddy`.
- Added Capacitor scripts and package entries in `package.json`.
- Added reusable shared modules under `src/shared/` for bubble maths, bag/club data, player profile, GPS state helpers, units/distance helpers, and shot/session models.

## Still required in local Codex shell

This GitHub connector can edit files and create branches, but it cannot run npm, generate native iOS/Android projects, open Xcode/Android Studio, or create a Git tag through a tag-specific API.

Run:

```bash
git fetch origin
git checkout 1d996b2f1be31077c4154c2dd7085ea622318de2
git tag deployed-golf-daddy-baseline-2026-06-18
git push origin deployed-golf-daddy-baseline-2026-06-18

git checkout native-app-planning
npm install
npm run build:netlify
npx cap sync
npx cap add ios
npx cap add android
npx cap sync
```

## Structure audit

### GPS play logic and map state

Current GPS/map state is still mostly in browser globals. Known hooks include `start`, `target`, `greenCentre`, `lockedFrame`, `currentPlayingHole`, `selectedHole`, `enterGpsModule()`, `resetPlay()`, `setStart()`, `setGreenTarget()`, `placePin()`, `renderShot()`, `lockFrame()`, `gdUseNextShotPosition()`, and `gdLockMappedGreenFromStart()`.

The main play bridge appears in `scripts/gd-arcade-mode.js`, especially `GameRouteAdapter`, `activeAppShot`, and `currentShotPlan`.

### Bubble rendering

Current bubble behaviour is partly driven by `getGpsBubblePayload(distance)`, `gdBubbleRenderCenter(core)`, `calculateShot(distance)`, and the local `normalizeBubble(raw, distance)` in `scripts/gd-arcade-mode.js`.

First extraction: `src/shared/bubbleMath.js`.

### Bag / club data

Club choice is currently inferred via `calculateShot(distance)` and payload fields such as `club`, `baseCarry`, `carryM`, and `totalM`.

First extraction: `src/shared/bagClubData.js`.

### Player profile

Profile access currently uses browser-global/local helpers such as `activePlayerProfile()`, `gd_active_course_v1`, and user-scoped course library keys.

First extraction: `src/shared/playerProfile.js`.

### Course library / green centre / target placement

The course library and green/pin-lock logic lives in `scripts/gd-course-library-pin-lock.js`. Keep locked Green Wand-adjacent behaviour stable during native setup.

Relevant state includes `gd_user_course_library_v1`, `gd_published_course_library_v1`, `mappedPlayAssist`, `rememberPlayingHole()`, `activePlayingHole()`, and `mapSessionCenter()`.

## GPS Play first checklist

- Home, Profile, Bag, and Play routes open in the native shell.
- 2-tap mode works.
- Live GPS mode asks for location cleanly.
- Club selector stays reachable.
- Shot bubble renders without clipping.
- Undo returns to the previous shot state only.
- Refresh/re-centre does not clear the session.
- Green centre and target placement are touch-safe.

## Mobile/native checklist

- Add clear iOS and Android location permission states.
- Handle app resume and network changes.
- Fix Android back so it closes modals first, then unlocks a locked shot, then navigates within the app rather than unexpectedly exiting.
- Add safe-area handling for iPhone notch/dynamic island and Android nav/status bars.
- Audit for clipped controls, overlapping shot values, large touch targets, stable bottom dock, readable player badge, and reachable undo/refresh controls.

## Release rule

Internal testing builds only. Do not submit publicly until real-course GPS testing has been completed.
