# App / studio split

Two surfaces, one source tree. Started 2026-07-26.

- **app** — what ships to phones (Capacitor) and serves at `/`. Play, scores,
  shot tracking, course mapping, on-course capture, practice import.
- **studio** — the browser admin/tuning surface at `/studio/`. Course database,
  visual-engine tuning, developer settings, mapping debug.

Scope decision (Sam, 2026-07-26): on-course hole-frame capture, AutoMapper /
pin-drop course mapping, and launch-monitor screenshot OCR all **stay on the
phone**. Only admin and tuning surfaces move. The phone must still be able to map
and scan a course that has never been published.

## Bundle size, running total

The built app bundle (`npm run build:app`, which is what `cap sync` copies into
the native projects):

| after | MB |
|---|---|
| start | 13.70 |
| Phase 1 — studio split mechanism, mapping debug + admin panel out | 13.70 |
| Phase 5 — icon blob to files | 9.46 |
| Phase 6 — home/brand PNGs downscaled | 7.23 |
| Phase 7 — dead assets deleted | 6.29 |
| Phase 2 — admin block out of core | 6.19 |
| Phase 3 — visual engine split into a play client | 5.99 |
| Phase 4 — remaining debug surfaces | **5.97** |

## How the split works

`index.html` is the **studio superset** — it contains every panel and every
script tag. Anything studio-only is marked in the source:

```html
<script data-gd-surface="studio" src="scripts/gd-course-mapping-debug.js?v=..."></script>
<div data-gd-surface="studio" id="developerPanel">…</div>
```

`scripts/clarity-deploy-build.js` then emits:

| Output | Contents |
|---|---|
| `dist/index.html` | app surface — every `data-gd-surface="studio"` element removed, whole subtree |
| `dist/studio/index.html` | studio surface — everything, plus `<base href="/">` |

The studio has no copy of `scripts/` or `styles/`. `<base href="/">` points its
relative paths at the same files the app loads, so there is one copy on the CDN
and one cache entry per asset. Verified: loading `/studio/index.html` fetches
exactly one file from under `/studio/`.

Each output stamps `<html data-gd-target="app|studio">`, so runtime code can
branch on `document.documentElement.dataset.gdTarget` without sniffing the URL.

### Build commands

```
npm run build:netlify    # both surfaces — this is what Netlify runs
npm run build:app        # app only, and PRUNES studio-only files from dist
```

`native:sync`, `native:release:aab` and `native:release:apk` all use
`build:app`. The pruning matters there and only there: `npx cap sync` copies all
of `dist` into the native project, so a merely-unreferenced module still ships
inside the APK/IPA. On Netlify the files stay, because the studio needs them.

Local development serves the source tree (`npm start`), which is the studio
superset — matching how tuning is actually done. To exercise the built app
surface, serve `dist` (`.claude/launch.json` has a `clarity-dist` config on
5174).

### What is tested

- `npm run test:boot` boots **three** surfaces in headless Chromium — source,
  `dist/index.html`, `dist/studio/index.html` — and fails on any uncaught
  exception. A stripped element that some kept code dereferences without a guard
  would only ever crash the app build, which is the one that ships.
- `node dev/surface-split.test.js` locks the build contract: the app carries no
  studio markers, the studio keeps every asset the source loads, stripping
  preserves div balance (whole elements, not orphaned opening tags), and
  `--app-only` prunes only files the app does not load.

Both run in `structural-smoke` CI.

### Adding something to the studio

1. Mark the element(s) with `data-gd-surface="studio"`.
2. Check every reference from code that stays. All call sites into a
   studio-only module must already be `?.`-guarded or `try`-wrapped — this is
   how `gd-course-mapping-debug.js` was safe to move without edits.
3. `npm run test:boot`. The app-surface boot is the assertion that matters.

## Where the weight actually is

Measured 2026-07-26. `scripts/` 8.3MB, `assets/` 4.7MB, `styles/` 680KB.

| File | Size | Split |
|---|---|---|
| `gd-icon-assets.js` | 4.46MB → **1.7KB** | **not admin** — 14 base64 PNGs, see Phase 5 |
| `gd-app-core.js` | 1.29MB → **1.15MB** | admin block **carved out** (Phase 2) |
| `gd-route-audit.js` | 460KB | shell navigation owner despite the name — stays |
| `gd-course-library-pin-lock.js` | 348KB | mapper is ~42KB+ but **stays** (phone maps courses) |
| `gd-course-visual-engine.js` | 240KB → **38KB** on the phone | **split** (Phase 3) |
| `gd-course-mapping-debug.js` | 48KB | **moved to studio** ✅ |

## Phases

**Phase 1 — mechanism + first move. Done.** Build targets, `<base>`-resolved
studio, three-surface boot test, `surface-split.test.js`, CI. Moved:
`gd-course-mapping-debug.js`, `#developerPanel` (the whole Admin Settings sheet,
including the Database panel), and both of its entry buttons (home "Admin" and
Settings → "Admin Settings").

**Phase 2 — carve the admin block out of core. Done.** `gd-app-core.js` lines
347–2473 (2127 lines) plus its eight `window.*` exports moved verbatim to
`scripts/studio/gd-admin-course-db.js`, loaded immediately after core and marked
studio. **Core 1289KB → 1153KB**; the app build no longer parses 141KB of
course-database read/edit/delete/publish, cloud frame cache, visual-engine
preview and tuning dock.

It is deliberately **not** wrapped in an IIFE: the Database panel calls these
from inline `onclick`/`oninput` handlers, so they have to stay in the shared
global scope every classic script on the page uses.

The hazard I expected did not materialise. Of 163 top-level declarations in the
range, only nine are referenced from outside it, and **none** of them are the ~22
top-level `let`/`const` state variables — those turned out to be entirely
internal, so there was no global-lexical-TDZ problem to solve. What the audit did
turn up was two real leaks, both fixed here:

- `gdAdminCourseVisualToast` was being borrowed by `savePlayerProfiles` for its
  "device storage is full" warning — a player-facing path depending on an admin
  helper. It now calls `toast()` directly. Left alone it would have been silent:
  the call site is inside `try{}catch(e){}`, so the app build would have
  swallowed the ReferenceError and simply never warned the user.
- `openDeveloperPanel()` now returns early when `#developerPanel` is absent, so a
  stray `route="admin"` (deep link, old bookmark) is a no-op on a phone instead
  of an uncaught error mid-round.

Everything else that still names a moved function — `renderDevPanel`, the
`gd-course-play-debug-event` listener, the 2200ms refresh interval, the route-audit
hooks — is already behind a `document.getElementById("developerPanel")?…` guard
that is false in the app build, so those identifiers are never evaluated.

One incidental win: the block's only load-time statement registers three
document-level **capture** listeners (click/input/change) for the tuning dock.
The app build no longer installs them.

`dev/course-location-behavior.test.js` asserted against the text of
`gd-app-core.js`; those three assertions now follow the code to the studio file
rather than being deleted.

**Phase 3 — split the visual engine. Done.** The phone now loads
`scripts/gd-course-visual-client.js` (**38KB**, 48 functions) instead of the
240KB `gd-course-visual-engine.js`. **202KB off the app.**

The app surface calls six engine methods; the other 144 functions are authoring —
masters, previews, presets, stitching, terrain/floodlight/birds-eye rendering,
publishing, cloud sync. GPS play only reads records and caches capture pixels,
and published frames are rendered server-side by the worker.

**Why a generated subset rather than splitting the closure.** The dependency runs
strictly one way — the play closure never calls an authoring function (measured
seam: 0) — so a true split was possible. But the halves share mutable module state
(`transientAssetDataByPath` and the caches around it), and splitting the closure
that renders course visuals is exactly where a subtle, only-visible-on-a-course
bug comes from. Instead `dev/generate-visual-engine-client.js` copies the needed
functions **verbatim** into their own closure, and
`dev/visual-engine-client.test.js` asserts every copy is byte-identical to the
engine's. The engine stays the single authoritative source and divergence is a CI
failure, not a maintenance hazard. Confirmed the guard fires by editing the engine
without regenerating.

That test also checks the client is **closed** — it calls nothing it does not
define — and that no app-surface script calls an authoring method. Both would be
a ReferenceError on a phone that nothing in the studio would ever surface.

**This made the surface marking two-way.** Until now everything was
`data-gd-surface="studio"`, stripped from the app. The engine and the client both
define `GDCourseVisualEngine`, so exactly one must load per surface: the client is
marked `data-gd-surface="app"` and is stripped from the *studio* build.
`clarity-deploy-build.js` now strips in both directions, and `surface-split.test.js`
asserts each build loads exactly one engine.

Verified in the browser on both surfaces: the app client round-trips the store to
localStorage, resolves records, produces correct capture image paths
(`captures/pupuke/h7/5003c84d.jpg`) and returns the beta-3D tilt policy; the studio
keeps all 44 API entries, builds its preset list, and never loads the client.

The engine file itself is untouched, so the integer-`captureZoom` invariant and
everything else about frame output is unchanged.

**Phase 4 — the remaining debug and admin surfaces. Done, and deliberately
smaller than planned.** ~19KB and, more usefully, a 2200ms interval and two
window listeners the app no longer installs. Core 1153KB → 1142KB.

Moved:

- **Course-play pipeline debug + Course Play Monitor** —
  `scripts/studio/gd-course-play-debug.js`, 15 renderers from core lines 312–493
  plus their exports, first render, two `window` listeners and the 2200ms refresh
  interval from 639–648. Every external reference was already either inside the
  developer-panel plumbing (`renderDevPanel` bails on a missing
  `#devTuningControls`, `openDeveloperPanel` on a missing `#developerPanel`) or in
  a file that is already studio-only. **No app-surface file referenced any of the
  15.** These are renderers only — the debug events are still emitted from the
  play pipeline behind `typeof gdCoursePlayDebugEvent==="function"` guards, so
  nothing stops being recorded, it just stops being drawn where only an admin
  could see it.
- **`gd-conditions-debug.js`** (8KB) — a console-only debug API. It defines
  `ClarityCaddieConditionsDebug`/`GolfDaddyConditionsDebug` and **nothing in the
  codebase calls either**.
- **`#gdPracticeLiveDebugPanel`** — the DOM node only. Its renderer already bails
  on a missing root, so the app build cannot draw the scan debug feed.

### What is staying on the phone, and why

The plan listed several more "admin" surfaces. Checking the gates rather than the
names, most of them are not admin-only at all and moving them would delete real
functionality:

| Surface | Gate | Verdict |
|---|---|---|
| Course Data admin tab | `gdCourseDataCanManage()` → admin **or coach** | coaches use it on a phone — stays |
| Account management (`gdAdminAllAccounts`, `gdAdminRemoveAccount`, `gdAdminViewProfile`) | wired into `window.GolfDaddyAccounts` | drives the coach roster UI in the app — stays |
| `gd-course-data-comparison.js` | none | feeds `gdCompareMyBubbleRows` — a player-facing My Bubble feature — stays |
| Payments admin (`renderAdminSettings`) | `role === "admin"` | genuinely admin-only, but ~4KB inside a 64KB shared closure. Not worth a closure split — stays |
| Practice live-debug renderers (6KB) | admin-only panel, but `gdPracticeLiveDebugPush` sits on the practice-scan path | renderers left in core; only the DOM node moved |

The lesson for later phases: `gdAdmin*` in a name does not mean studio-only. The
gate is the source of truth, and `coach` counts as a phone user.

**Phase 5 — the 4.5MB that had nothing to do with admin. Done (out of order, on
Sam's call — it was the larger win).** `gd-icon-assets.js` was 14 base64 PNGs and
2 SVGs inlined into JavaScript: **4.46MB → 1.7KB**, with the images now in
`assets/icons/` at **0.58MB** total. Built app bundle 13.7MB → **9.46MB**.

Three things made that possible, and all three are load-bearing:

- Every consumer (`gd-brand-icon-render`, `gd-auth-account-shell`,
  `gd-gps-beta-mode-shell`) only ever does `<img src="' + ICONS[key] + '">`, so a
  URL is a drop-in for a data URI. `window.GDIconAssets` kept its exact shape;
  no call site changed.
- The PNGs were 512×512 stored near-uncompressed. Nothing renders them above
  **76px** (`#gdV62Home .tile img`; the rest are 70, 54, 48, 44, 42, 40, 38 and
  down), so they are downscaled to 256px — 3.3× device pixel ratio of headroom.
  Verified: composited over the app background at 76px, the worst icon differs
  from the original by a mean of 0.93/255.
- They are still **lossless full-colour**, not palette-quantised. Quantising to
  256 colours would get the set to ~215KB, but these sit on dark gradients and it
  bands the soft shadows.

`dev/extract-icon-assets.js` regenerates the manifest and the files; the 512px
sources are kept in `dev/icon-originals/` (not deployed) so the set can be
re-rendered at another size later. `dev/icon-assets.test.js` fails if a data URI
comes back, if a file goes missing, if an icon exceeds 256px, if the payload
grows past 900KB, or if a `?v=` content hash goes stale — `/assets/*` is cached
for a week, so a replaced icon under an unchanged URL would stay stale in every
browser that already had it.

**Phase 6 — the home and brand PNGs. Done.** Same problem one level up: authored
and shipped at 1024px while nothing renders them above 235px. **3624KB →
1338KB**; built app bundle 9.46MB → **7.23MB**.

| file | was | now | renders at |
|---|---|---|---|
| `home/play.png` | 1024², 905KB | 768², 536KB | 235px |
| `home/bag.png` | 777×1004, 340KB | 594×768, 219KB | 235px |
| `home/profile.png` | 822×1009, 507KB | 626×768, 304KB | 235px |
| `brand/cg-logo-white-g.png` | 1024², 806KB | 256², 53KB | 62px app / 44px email |
| `brand/cg-gps-pin.png` | 1024², 412KB | 256², 37KB | 46px |
| `brand/clarity-app-icon.png` | 1024², 654KB | 512², 190KB | 180px touch icon |

Render sizes were **measured in the running app**, not read off a stylesheet —
the home tile art is percentage-sized, so its ceiling comes from the 680px cap on
the tile grid. It tops out at 235px at any viewport width; on a phone the tile is
smaller (~215px), so 3× DPR there is ~645 device pixels. 768 covers both.

Two cases do not take the 3× rule:

- `clarity-app-icon.png` is favicon and apple-touch-icon only — those sizes are
  already device pixels, the OS does not multiply them by DPR. The native
  launcher icons are separate files under `android/app/src/main/res` and
  `ios/App/App/Assets.xcassets`, so this one is web-only.
- `cg-logo-white-g.png` is also the logo in transactional email
  (`clarity-email.js` and both Netlify mail functions hardcode `width="44"`).
  It stays PNG for that reason — WebP is not safe in email clients.

Unlike the icons these are referenced by literal path from ten files, so
`dev/optimise-image-assets.js` re-stamps every reference with the new content
hash as part of the same run. That is not cosmetic: `/assets/*` is served with
`max-age=604800`, and before this some references carried a hand-written
`?v=clarity-20260531` and some carried nothing at all — replacing an image would
have left returning users on the old one for a week while a fresh browser looked
fine. `dev/image-assets.test.js` fails on any stale or missing hash, on an image
larger than the size it is drawn at, and if the two directories grow past 2.6MB.

**Phase 7 — delete the dead assets. Done, 931KB.** All four were provably
unreferenced, checked against literal and dynamically-built paths (every
reference in this codebase turned out to be literal):

- `brand/cg-logo-black-g.png` (806KB) — reachable only from
  `brand/cg-logo-black-g.svg`, which nothing referenced. A closed dead loop.
- `brand/cg-logo-black-g.svg` and `brand/cg-logo-white-g.svg` — thin SVG wrappers
  around the PNGs, referenced by nothing. The white one had also gone stale: it
  declared `width="2048" height="2048"` for a file that is now 256px.
- `home/bubble-data.png` (124KB) — no references at all.

## Relationship to the structural rebuild

This is a target dimension on the carves already planned in `REBUILD-PLAN.md`,
not a competing plan. Phase B there ("carve core by feature") and Phase 2 here are
the same operation — the only addition is that a carved-out owner file now also
declares which surface it belongs to.
