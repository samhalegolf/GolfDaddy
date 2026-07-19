# Shell Ownership Map

Date: 2026-07-19
Branch: `structural-rebuild`

## Target Ownership

The Shell should own the app-level route state, visible top-level surface, route label, Back/Home controls, top-bar presentation, module visibility, Course Picker presentation as a route, GPS Play presentation as a route, and the compatibility body classes that describe those routes.

The Shell must not own Course Picker search/selection/mapping, Course Location, GPS watches, GPS runtime state, map camera behavior, scorecard, AutoMapper, Course Geometry Resolver, Green Shape Engine, Course Data, Bag, Bubble, Practice, or shot-end feature logic.

## Required Invariants

- Exactly one top-level route is active: `home`, `course-picker`, `gps`, or `module:<name>`.
- Home, Course Picker, GPS Play, profile/auth overlay, and module panels cannot be visibly active together.
- Course Picker is a shell route, not a live GPS runtime state.
- GPS compatibility classes are derived from Shell state and are active only for GPS Play or the explicit Course Picker-on-GPS-shell compatibility route.
- Leaving GPS clears GPS-only transient shell classes and delegates GPS runtime cleanup to the GPS runtime owner.
- Returning Home closes picker/module/profile surfaces, clears stale route labels, and removes GPS/module compatibility classes.
- Back and Home resolve through one owner and do not infer app route from ad hoc visible DOM state.
- Module business logic may render content, but Shell alone opens/closes top-level module presentation.

## DOM Owned By Shell

- `#shellHome`: Home surface visibility.
- `#courseScreen`: Course Picker surface visibility.
- `.modulePanel`: top-level module visibility through the `open` class.
- `#gdProfileV67`: profile/auth route presentation, while profile content stays with the profile/account owner.
- `#shellTop`, `#shellDock`: top-level shell chrome visibility.
- `#shellBackBtn`, `#shellHomeBtn`, `#shellProfileReturnBtn`, `#shellSettingsBtn`: route command binding and visibility.
- `#shellRouteLabel`: route label text.
- Body compatibility classes: `shell-home`, `shell-gps`, `shell-module`, `gdGpsActive`, `gps-active`, `gdCoursePickerOpen`.

## Current Owners And Writers

### `index.html`

- Home tile handlers directly call route globals: `showShellHome`, `GDCoursePicker.open`, `gdOpenDataHub`, `openBag`, `openProfilePanel`, `gdOpenPlayerSettingsPanel`, `gdOpenAdminSettings`, `openDeveloperPanel`.
- `#shellBackBtn` uses inline `gdShellBackClick(event)` and `gdShellBackPointer(event)`.
- `#shellHomeBtn` directly calls `showShellHome()`.
- `#shellSettingsBtn` directly calls `openSettings({fromGps:true})`.
- Course Picker has its own inner Back/Home buttons calling `gdCoursePickerBack(event)` and `gdCoursePickerHome(event)`.
- Script order currently loads `gd-app-core.js` first, route/auth/profile hardening scripts before `clarity-router.js`, `gd-route-audit.js` after router, `gd-course-picker-search-v2.js` after route audit, and `gd-gps-play-runtime-owner-v1.js` after Course Picker.
- The inline handlers are compatibility callers only; the Shell owner should replace them with narrow `GDShell` delegates.

### `scripts/gd-app-core.js`

- Declares legacy shell state: `shellMode`, `lastShellModule`, `shellRouteStack`.
- Declares route helpers: `shellRouteName`, `updateShellRouteLabel`, `pushShellRoute`, `replaceShellRoute`, `setDockActive`, `closeModulePanels`, `setShellLayer`, `showShellChrome`, `showModePicker`, `showShellHome`, `showModeDashboard`, `enterGpsModule`, `openShellModule`, `openRoute`, `shellBack`.
- Writes route label and Back visibility through `#shellRouteLabel` and `#shellBackBtn`.
- Writes top-level route classes through `setShellLayer`: `shell-home`, `shell-gps`, `shell-module`, and removes `gdGpsActive`, `gps-active`, `gps-open`, `manual-gps-active` outside GPS.
- `hideGpsSurface` hides `#courseScreen` and `#gdCoursePinScreen`, removes `gdCoursePickerOpen`, pin/opening classes, and clears Course Picker datasets.
- `showModePicker` and `showShellHome` show Home, close panels, hide GPS, set Home route, and hide shell chrome.
- `enterGpsModule` hides Home, shows chrome, sets GPS classes, shows `#courseScreen`, refreshes course/GPS badge, and invalidates map.
- `openShellModule` hides Home/GPS, opens `.modulePanel`, sets module route, and sets dock.
- Wrapper replacements for `openBag`, `openDeveloperPanel`, `openSettings`, `closePanel`, and `openProfilePanel` also write shell classes and module visibility directly before running feature behavior.
- `shellBack` has a special mapped-start prelock Course Picker branch that directly writes `shell-gps`, `gdGpsActive`, `gps-active`, `gdCoursePickerOpen`, hides Home, and shows `#courseScreen`.
- This file is the original shell implementation, but it is no longer the only loaded owner.

### `scripts/gd-route-audit.js`

- File header calls it the canonical route audit / shell navigation owner.
- Captures previous shell functions: `oldEnterGps`, `oldOpenShellModule`, `oldOpenProfilePanel`.
- Implements independent shell helpers: `clearBody`, `restoreHomeSurface`, `showShellChrome`, `setRouteLabel`, `setDock`, `remember`, `cleanForModule`, `cleanForHome`, `openModulePanel`, `openLegacyPanel`, `openGpsStable`, `openProfileStable`, `showCoursePickerStableBack`, `backStable`, `shellBackClick`, `shellBackPointer`, `forceHomeFallback`, and `wireClicks`.
- Writes the same top-level classes independently: `shell-home`, `shell-gps`, `shell-module`, `gdGpsActive`, `gps-active`, `gps-open`, `manual-gps-active`, `gdCoursePickerOpen`.
- Writes `#shellRouteLabel`, Back visibility, shell chrome visibility, Home/Course Picker visibility, module `open` classes, and profile overlay visibility.
- Wraps/replaces global route functions in `expose`: `gdCanonicalShellBack`, `gdCanonicalShellHome`, `gdShellBackClick`, `gdShellBackPointer`, `gdOpenAdminSettings`, `openStats`, `openDeveloperPanel`, `openProfilePanel`, `openBag`, `openSettings`, `showShellHome`, `showModeDashboard`, `shellBack`, `enterGpsModule`.
- Binds direct click listeners for home tiles, dock routes, shell Home, shell Back, profile-return, and settings.
- Stores browser route state with `history.pushState` / `replaceState` and listens for `popstate`.
- Depends heavily on script order because it wraps globals declared earlier by `gd-app-core.js` and is then wrapped again by later Course Picker/GPS runtime scripts.
- This is the main competing Shell owner that must become a read-only diagnostic/delegator or be retired.

### `scripts/clarity-router.js`

- Owns lightweight route memory under `window.ClarityRouter`.
- Writes `document.body.dataset.clarityRoute`, `document.body.dataset.clarityRouteLabel`, `#shellRouteLabel`, and Back visibility.
- Does not own visible surfaces or body route classes.
- Should become an optional route-memory helper used by Shell, or Shell should be the only writer of route labels while this file remains data-only.

### `scripts/inline/gd-course-picker-search-v2.js`

- Correctly owns `window.GDCoursePicker` state, GPS request scoped to picker, nearby/search/resume rendering, selection, local/cloud playable lookup, mapping-controller invocation, mapping result handling, saved playable entry, manual fallback decision, and close/open API.
- Also directly writes shell presentation:
  - `closePickerSurface` hides `#courseScreen` and removes `gdCoursePickerOpen` / `gdCoursePinPromptActive`.
  - `openOwner` removes `shell-home` and `shell-module`, adds `shell-gps`, `gdGpsActive`, `gps-active`, `gdCoursePickerOpen`, writes `data-clarity-route="gps"` and `data-gd-tool-screen="picker"`, hides `#shellHome`, shows `#courseScreen`, and requests picker GPS.
  - A wrapper around `enterGpsModule` hides `#courseScreen` after a selected course.
- Course Picker should delegate route presentation to `GDShell.openCoursePicker`, `GDShell.closeCoursePicker`, and `GDShell.enterGps`, while retaining all picker business logic.

### `scripts/inline/gd-gps-play-runtime-owner-v1.js`

- Correctly owns GPS runtime concerns: GPS location lifecycle, resume round runtime, tool rail runtime, manual-start runtime, captured-shot overlay runtime, and GPS permission gate.
- Also writes shell state:
  - `cleanRouteClasses` removes and adds `shell-home`, `shell-gps`, `shell-module`, `gdGpsActive`, `gps-active`, `gps-open`, `manual-gps-active`, `gdCoursePickerOpen`, and pin/tool classes.
  - `showPicker` writes GPS/Course Picker presentation, route label, Home visibility, `#courseScreen` visibility, and Course Picker GPS request.
  - `home`, `back`, `pickerHome`, `pickerBack`, and `enter` wrap or replace shell route transitions.
  - `expose` installs fallback global Shell functions if canonical shell nav is not active, and always replaces `window.enterGpsModule`.
  - `wire` and document listeners bind Back/Home/Play handlers when canonical nav is missing.
  - `homeGuardTick` runs on `setInterval` and repairs Home/GPS shell state.
- GPS runtime should delegate route entry/exit and picker/home transitions to Shell, and keep only GPS transient cleanup hooks.

### `scripts/inline/gd-gps-beta-mode-shell.js`

- Reads shell/home/module state to decide whether GPS UI chrome is active.
- Writes `gdGpsActive` in `setGpsActive`; wraps `enterGpsModule`, `openShellModule`, `showShellHome`, and `openProfilePanel`; installs DOMContentLoaded/click/session/resize refresh listeners.
- The GPS badge/mode UI can remain a reader, but `gdGpsActive` writes and shell wrapper behavior should move to Shell.

### `scripts/inline/gd-auth-gate-v1.js`

- Owns auth gating decisions, but directly closes non-auth surfaces, hides Home/Course Picker, hides shell chrome, and removes `shell-home`, `shell-gps`, `shell-module`, `gdGpsActive`, `gps-active`, `gps-open`, `manual-gps-active`, `gdStatsOpen`, `gdBubbleStudioOpen`, `gdShotDataOpen`.
- Wraps route globals with an auth guard: `showShellHome`, `showModePicker`, `enterGpsModule`, `openShellModule`, `openBag`, `openStats`, `openCourseData`, `openPracticeData`, `openDeveloperPanel`, `gdOpenPlayerSettingsPanel`.
- Uses DOMContentLoaded, click, and delayed install loops.
- Should delegate locked-route presentation to Shell while retaining account/auth decisions.

### `scripts/inline/gd-inline-profile-route-hardening-v1.js`

- Owns profile route hardening but directly hides Home/Course Picker/chrome, mutates `shell-home`, `shell-gps`, `shell-module`, `gdGpsActive`, `gps-active`, `gps-open`, `manual-gps-active`, `gdProfileOpen`, and `gdAuthLocked`.
- Wraps `openProfilePanel`, `gdOpenProfileV67`, and `gdCloseProfileV67`, and installs click/delayed wrappers.
- Should become profile-content/auth helper code that asks Shell to present `module:profile` or `auth`.

### `scripts/inline/gd-auth-account-shell.js`

- Owns account/profile UI content and profile overlay rendering.
- Also directly hides non-auth surfaces during reset/auth flows, hides Home/Course Picker/chrome, removes shell route classes, adds/removes `gdProfileOpen`, and calls `showShellHome` in login/logout flows.
- Profile Home button calls `gdCanonicalShellHome` or `showShellHome`.
- Should keep account/profile content ownership and delegate shell presentation to `GDShell.openModule("profile")`, `GDShell.showAuth`, or `GDShell.showHome`.

### `scripts/inline/gd-caddie-gps-patches-v1.js`

- Contains older rescue/manual GPS patches that still write route classes and surface visibility.
- `showGpsSurface`, play-button rescue, manual GPS overlay helpers, and bag return helpers add/remove `shell-gps`, `shell-home`, `shell-module`, `gdGpsActive`, `gps-active`, `gps-open`, `manual-gps-active`, hide Home, show/hide `#courseScreen`, and show shell chrome.
- These should be replaced with Shell delegation or retired if now obsolete.

### `scripts/inline/gd-gps-play-flow-layers-v1.js`

- Mostly owns GPS play flow and score/hole UI.
- `returnGpsMap` directly removes module panels, hides `#courseScreen`, adds GPS classes, removes Home/module classes, shows chrome, sets dock, and invalidates map.
- Should delegate return-to-GPS presentation to Shell while retaining hole/score flow logic.

### `scripts/inline/gd-captured-hole-frame-camera-v19.js`

- Camera owner reads Shell/GPS classes to decide active surfaces.
- Wraps `showShellHome` and `gdOpenChangeCourse` to hide captured-camera waiting UI.
- Should expose narrow cleanup hooks and avoid wrapping Shell functions after `GDShell` owns route changes.

### Shell CSS

- `styles/gd-shell.css`, `styles/gd-course-library.css`, `styles/gd-gps-badge.css`, and GPS runtime CSS depend on `shell-gps`, `gdGpsActive`, `gps-active`, `shell-home`, `shell-module`, and `gdCoursePickerOpen`.
- These are live compatibility readers. The Shell carve should keep writing them from one owner until CSS/readers are migrated separately.

## Back/Home Current Behavior

- `gd-app-core.js` has legacy `shellBack` with a stack-based route model plus a special mapped-start prelock picker branch.
- `gd-route-audit.js` overwrites Back/Home globals and button handlers with `backStable`, `shellBackClick`, `shellBackPointer`, `cleanForHome`, and direct event listeners.
- `gd-gps-play-runtime-owner-v1.js` keeps fallback Back/Home ownership when canonical nav is absent and still owns GPS-specific Back branches through runtime wrappers.
- Course Picker inner Back/Home are owned by GPS runtime globals `gdCoursePickerBack` / `gdCoursePickerHome`.
- Current Back/Home ownership is split across at least three loaded scripts and inline markup.

## Route Labels Current Writers

- `gd-app-core.js`: `updateShellRouteLabel`.
- `scripts/clarity-router.js`: `applyToDom`.
- `gd-route-audit.js`: `setRouteLabel`.
- `gd-gps-play-runtime-owner-v1.js`: local `setRouteLabel`.
- Module openers and profile hardening indirectly mutate `lastShellModule` and then label.
- Shell should become the only direct route-label writer.

## Script Order Risks

- `gd-route-audit.js` captures globals from `gd-app-core.js`, then exposes replacement globals.
- `gd-course-picker-search-v2.js` captures and wraps `window.enterGpsModule` after route audit.
- `gd-gps-play-runtime-owner-v1.js` captures `window.enterGpsModule`, `gdCanonicalShellHome`, `showShellHome`, `gdCanonicalShellBack`, and `shellBack`, then exposes its own wrappers/fallbacks.
- Auth/profile hardening scripts wrap earlier globals and use delayed re-wrap loops.
- Current behavior depends on loaded order and delayed install loops; the Shell owner should install once and expose compatibility aliases that always delegate to `window.GDShell`.

## Proposed Owner Boundary

Create `scripts/gd-shell.js` and expose `window.GDShell` with:

- `init`
- `showHome`
- `openCoursePicker`
- `closeCoursePicker`
- `enterGps`
- `leaveGps`
- `openModule`
- `closeModule`
- `showAuth`
- `back`
- `home`
- `getState`
- `destroy`

Compatibility aliases should be retained only as direct delegates:

- `showShellHome` -> `GDShell.showHome`
- `gdCanonicalShellHome` -> `GDShell.home`
- `gdCanonicalShellBack` -> `GDShell.back`
- `gdShellBackClick` -> `GDShell.back`
- `gdShellBackPointer` -> `GDShell.backPointer`
- `shellBack` -> `GDShell.back`
- `enterGpsModule` -> `GDShell.enterGps`
- `openShellModule` -> `GDShell.openModule`

Feature globals such as `openBag`, `openSettings`, `gdOpenDataHub`, `openDeveloperPanel`, `openProfilePanel`, and Course Data / Practice Data openers may remain public compatibility entry points, but they should call Shell for top-level presentation and then run feature-specific render hooks.

## Carve Plan

1. Add `scripts/gd-shell.js` before Shell consumers in `index.html`.
2. Move route state, body-class writes, surface visibility, route label, shell chrome, Back/Home, and module presentation into `GDShell`.
3. Change `gd-route-audit.js` from competing owner into feature/delegation code, or delete its shell audit behavior if all feature exports are moved.
4. Replace Course Picker direct shell mutations with `GDShell.openCoursePicker`, `GDShell.closeCoursePicker`, and `GDShell.enterGps`.
5. Replace GPS runtime shell mutations with `GDShell` calls, retaining runtime-only GPS cleanup hooks.
6. Replace auth/profile hardening direct shell mutations with Shell auth/profile presentation calls.
7. Retain compatibility body classes as Shell-derived classes until CSS/readers can be migrated.
8. Add `dev/shell-owner.test.js` and `dev/shell-behavior.test.js`, then wire them into `.github/workflows/structural-smoke.yml`.
