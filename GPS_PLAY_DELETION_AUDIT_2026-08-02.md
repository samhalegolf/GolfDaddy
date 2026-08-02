# GPS Play deletion / `/app/` inversion — audit

Written 2026-08-02. Scope: audit only, no code changed. Companion to
`MOBILE_APP_ARCHITECTURE_HANDOVER_2026-07-31.md` (the spec for what `/app/` should
be) and `PRE_BUILD_AUDIT_2026-07-31.md` (what was already cut before the rebuild
started). This doc answers the next question: **what does it actually take to
delete the old GPS play system and make `/app/` the primary experience, without
quietly breaking something that flows through it?**

Verified by reading source directly (file:line citations throughout) — not by
re-reading the old planning docs, which have drifted (see §1, Wand).

---

## TL;DR

- The old system is genuinely deletable — most of what it touches degrades
  gracefully (`typeof`-guarded) rather than crashing. **But two things it owns
  have zero replacement in `/app/` today: the paid-tier entry gate, and the
  on-course shot feed into "My Bubble" stats.** Both are silent failures, not
  crashes — the kind of gap that only surfaces as a support ticket or a revenue
  leak weeks later.
- `/app/` is currently **completely unlinked** from production — no page,
  script, or redirect references it. That's good news: promoting it is a
  routing change with no blast radius on the old system, and the old system can
  be deleted on its own schedule independent of when `/app/` goes live.
- "Ruthless" and "safe" aren't actually in tension here if sequenced right: the
  safety work is closing two specific gaps and confirming two feature-loss
  decisions *before* deletion — not adding guards, flags, or a coexistence
  period *during* deletion. Once those four things are settled, the deletion
  itself can be exactly as ruthless as you want it to be.

---

## 1. Current state of the two systems

**Old GPS Play** — reached from the home screen's `Play` tile
(`index.html:44`) → `GDCoursePicker.open()` → `runCourseMappingAttempt` /
`gdRunCourseMappingAttempt` → `enterGpsPlayAfterMapping()`
(`scripts/gd-app-core.js:16524`). It is not one file — it's 13 files under
`scripts/` and `scripts/inline/`, 16,588 lines, wired into the shared shell,
permissions, and stats pipeline that also serve every other screen.

**`/app/`** — a from-scratch rebuild (`app/README.md` is its design contract:
pure consumer, no capture/write, live map is the default not an earned state,
no polling). It is real and good where it's finished: surface-first rendering
with a correct live-map fallback, hole framing/lock/zoom, the actual bubble/shot
engine ported byte-verbatim from core with a CI drift check, a working tool
rail (Bag/Wind/Pin/GPS-Pin/Scorecard), drag-to-place flag, wind live feed,
Shot End/Lock-Unlock. It has real test coverage
(`dev/fresh-app-boot.test.js`, registered in CI) that the old system's
equivalent paths don't have.

**But right now nothing links to it.** Grepped every `.html`/`.js`/`.json`/
`.toml` in the repo for a reference to `/app/` outside its own tree: the only
hit anywhere is the test file. No redirect, no nav link, no deep link. It's
reachable only by typing the URL. That's actually the cleanest possible
starting position for a cutover — flipping the home tile to point at `/app/`
touches nothing the old system depends on.

---

## 2. What deletes cleanly (confirmed low-risk)

Cross-checked the 15 files everyone agrees are "clean shared platform"
(`gd-namespace`, `clarity-store`, `clarity-session`, `clarity-cloud-sync`,
`clarity-supabase-auth`, `clarity-router`, `clarity-permissions`,
`clarity-email`, `clarity-backup`, `clarity-support`, `clarity-payments`,
`clarity-store-billing`, `gd-icon-assets`, `gd-brand-icon-render`,
`clarity-error-reporter`) against every GPS-play-specific identifier
(`gdCapturedHoleFrameCameraOn`, `GDGpsScorecard`, `gd-gps-`, `wandMode`,
`placingPin`, `runCourseMappingAttempt`, `GDCoursePicker`) — **zero structural
hits**. The one soft coupling: `gd-brand-icon-render.js:102,105,106` calls
`refreshGPS()` / `gdOpenGpsToolSettings()` / `openScorecard()` from the shared
icon rail, all `typeof`-guarded. Deleting old GPS play doesn't crash this file,
but it leaves those rail buttons doing nothing until `/app/` supplies (or the
rail is repointed to) equivalents.

Native/platform hooks are clean: `gd-native-back-button.js` never references
GPS play directly — it calls `GDShell.back()`, which itself optional-chains
into `window.GDGpsPlayRuntime?.back?.(...)` (`gd-shell.js:293`) and falls back
to opening the course picker if that global is gone. Hardware back mid-round
degrades from "undo last shot" to "return to picker," not a crash. Deep links
have no course/hole params at all (`gd-native-deep-links.js:29-38` is
password-reset/referral only) — nothing to lose there.

`gd-route-audit.js` (the real shell/navigation owner despite its name, 8,221
lines, shared by every screen) has **zero references** to any GPS-play-owned
global (`GDGpsPlayRuntime`, `renderScorecard`, `gdScorecardShell`,
`runCourseMappingAttempt`, `cloudCourseMapSyncApi`). Its only GPS touchpoint,
`showCoursePicker()`, is a 3-tier optional fallback. It survives the deletion
untouched.

Scorecard *par/tee data* (as opposed to player scores — see §3) is shared
cleanly: both old (`gd-gps-scorecard-owner-v1.js:75`) and new
(`app/js/scorecard.js:11`) read the same `GET /api/scorecard-store` endpoint
independently, non-destructively. Nothing to migrate.

**The Wand/AutoMapper planning docs are stale.** `REBUILD-PLAN.md` and
`docs/reports/GREEN_WAND_ENGINE_EXTRACTION_MAP.md` (both 2026-07-19) describe a
standalone Wand UI as a "deletion candidate." It's already gone — no
`gd-wand-*.js` file, no Wand CSS, no `toggleGreenWand`/`openGpsWand` function
exists anywhere in the tree today. **The one thing that must survive
regardless of anything else in this doc** is `scripts/gd-green-shape-engine.js`
— the locked baseline in `package.json`'s `codex.doNotModify`
(`"lockedBaseline": "clarity-caddie-core"`, listing the Green Wand sandbox
engine, tile-crop sampling, and probe/ridge/magnetic shell logic by name). It's
self-contained (only touches `document.createElement("canvas")`, no DOM/body-
class coupling) and currently has **no live production caller** — the AutoMapper
handoff the extraction doc describes doesn't actually invoke it in the current
`gd-course-library-pin-lock.js`. It's dormant, test-covered, and off-limits —
don't touch it, don't need to route anything to it.

---

## 3. What doesn't delete cleanly — the real wiring risks

Two things the old system owns have **no equivalent anywhere in `/app/`**, and
both fail silently rather than loudly:

### 3a. The paid-tier entry gate disappears entirely

`gd-gps-play-runtime-owner-v1.js:3306-3332` is the *only* place in the whole
codebase that enforces `gps_round_start` — a real, server-resolved paid-access
check (`window.ClarityPermissions.canUse(...)`, backed by
`functions/permission-resolver.js` against Supabase payment state). Block a
free-tier user today and they get "Start gate: active paid access is required
for GPS rounds."

`/app/` loads `clarity-supabase-auth.js` for identity but **not**
`clarity-permissions.js`, `clarity-payments.js`, or `clarity-store-billing.js`
— confirmed by reading every script tag in `app/index.html` and grepping
`app/js/*.js` for `ClarityPermissions`/`entitlement`/`gps_round_start` (zero
hits). Right now, anyone — signed in or not — can open `/app/`, pick any
course, and play indefinitely for free. That's not a bug in `/app/`; billing
was never in scope for the rebuild yet. But it means **deleting old GPS play
without adding a gate to `/app/` first is a direct revenue leak**, not a
theoretical risk.

The fix is small relative to the rest of this audit: `clarity-payments.js` and
`clarity-permissions.js` are both on the "clean, no GPS-play entanglement"
list in §2 — they're already safe to load from `/app/`. This is a wiring task
(call `ClarityPermissions.canUse("gps_round_start", ...)` at the point `/app/`
starts a round), not a rebuild.

### 3b. On-course play stops feeding "My Bubble" stats, with no error

Playing a round today writes real shot data into the same pipeline the
practice/launch-monitor stats feature reads. Concretely:
`gd-gps-play-runtime-owner-v1.js:1450-1456` calls
`gdCaptureCurrentPlannedShot()` / `gdLogBallPositionForTracking()`
(`gd-app-core.js:18940`, `:19151`) → `GolfDaddyShotEvents.captureBubbleRendered`
→ `gd_shot_events_v1`, tagged `courseContext:"gps_course"`. That store is what
`gd-shot-cluster-analysis.js:333` (`analyzeCurrent`, the actual "My Bubble" fit
engine) reads, and it's consumed from the stats/data-hub panel
(`gd-route-audit.js:5438`) — **outside** the GPS play screen itself, so its
absence won't be visible from the play flow at all.

`/app/js/shot.js` holds shots in memory only — no localStorage, no fetch call,
doesn't even survive a page reload today, let alone reach the shared stats
store. Grepped for any `shot-library`/`practice-stat` reference in `app/` —
none.

This is a genuine product call, not an engineering oversight: does on-course
play still need to feed My Bubble, or was that always meant to be
practice-import-only under the "app authors nothing, pure consumer" philosophy
the rebuild is built on? Practice-mode imports keep working either way (they're
a separate pipeline, `gd-shot-library-sync.js`, that never depended on GPS
play). The risk isn't that this breaks something — it's that it goes quiet with
no error, no toast, nothing — the exact "confidently wrong" failure mode the
rebuild exists to eliminate elsewhere.

### 3c. Multi-nine courses lose their handling entirely

`gd-multi-nine-courses.js` isn't a generic shared concern — it's hard-wired
into the old scorecard owner (`window.gdScorecardShell`, defined only in
`gd-gps-scorecard-owner-v1.js:169`), guarded with `typeof` so it won't crash
when deleted, but the feature (3-nine course selection, e.g. Howeston-style
layouts) just disappears. `/app/js/scorecard.js:14` (`HOLE_COUNT = 18`) and
`app/js/boot.js:100`/`play.js:627` (`Math.min(18, ...)`) are hardcoded to a
flat 18 — there's no multi-nine model in `/app/` to receive this at all today.

### 3d. Course picker's on-device mapping fallback goes silently stuck

Not a data-loss risk, but worth flagging precisely: the picker's fast path
(`gd-course-picker-search-v2.js:583-587`, courses with a server-published map —
all 8 current courses) bypasses `gd-course-library-pin-lock.js` entirely and
keeps working fine without it. The slow path
(`invokeMappingOnce`, unpublished courses) calls
`runCourseMappingAttempt`/`gdRunCourseMappingAttempt`, defined only in
pin-lock.js. Delete pin-lock and that path sets a status flag and returns
`false` with **no toast, no navigation** — tapping "Play" on an unpublished
course just does nothing. Low real-world exposure today (published courses are
the common case and go through the fast path) but worth a one-line guard
(toast + return-to-picker) if pin-lock is deleted before every course a player
might pick is published.

---

## 4. What `/app/` is missing to be a full replacement (beyond 3a-3c)

From a direct read of `app/index.html` and every `app/js/*.js` file against
what the old system provides:

- **No settings/account/billing UI at all.** `/app/` loads
  `clarity-supabase-auth.js` and has a sign-in form, but there's no link
  anywhere to account/settings/profile — it's a play-only silo. Old GPS play
  shares `index.html` with the entire rest of the app (home, settings, billing,
  admin), so "delete old GPS play" and "delete the old app shell" are not the
  same operation — see the scope question in §5.
- **No login gate on play itself.** `openPicker()`→`openPlay()` in
  `app/js/boot.js:63-84` has no auth check — you can play signed out. Tied to
  3a; fixing the entitlement gate likely fixes this too, since entitlement
  checks require an identity.
- **Course picker is a flat unsearched list**, not a search/nearest/recents
  picker (`app/js/course-library.js` + `boot.js:46-70`). A real gap for
  day-to-day usability, independent of the billing/stats questions — flagging
  it here so it doesn't get missed in a "just wire billing and ship" plan.
- **No native-shell integration** — no back-button/deep-link wiring, no error
  reporter. `/app/` currently runs as a bare web page even inside the Capacitor
  shell. Low risk (worst case is default browser-back behavior instead of an
  in-app back handler) but should be a checklist item before native release,
  not assumed to "just work" because the old system had it.
- **What's already solid** (so this doesn't read as all gaps): surface
  rendering, hole framing, the shot/bubble engine, the tool rail, and the
  aerial basemap registry are genuinely done, tested, and — per the design
  docs — *better* than the old system, not just a port.

---

## 5. Decisions needed before deletion (not engineering questions — product ones)

I'd normally stop and ask these rather than assume, so flagging them explicitly
rather than picking for you:

1. **Scope of "invert the new one."** `/app/` today is a Home+Play shell only —
   no settings/account/billing/admin. Two readings: (a) repoint just the home
   screen's `Play` tile at `/app/`, leaving the old `index.html` in place to
   keep serving settings/account/billing/admin — smallest, matches what's
   actually been built; or (b) make `/app/` the whole site root at `/`, which
   means building settings/account/billing/admin into `/app/` first — a much
   bigger scope than the rebuild has covered so far. Everything below assumes
   (a), since that's what the current `/app/` tree can actually support; if you
   mean (b), the deletion plan is the same but gated behind building those
   screens first.
2. **Billing gate (§3a)** — block on porting it, or ship open and gate in a
   fast-follow? This one I'd lean hard toward blocking on — it's a small wiring
   job against already-clean modules, not a rebuild, and the alternative is a
   free-for-everyone window of unknown length.
3. **On-course → My Bubble stat feed (§3b)** — intentional scope cut under the
   "pure consumer" philosophy, or must be ported? Either is defensible; it just
   needs to be a decision, not a silent drop.
4. **Multi-nine support (§3c)** — accept the gap for the courses that need it,
   or port before cutover?

---

## 6. Deletion checklist

### 6a. JavaScript — old GPS Play runtime (13 files, 16,588 lines)

Delete outright once §5's decisions land (order doesn't matter much; these
are already merged owner files, not a chain to unwind):

| file | lines | `index.html` tag |
|---|---:|---|
| `scripts/inline/gd-gps-play-runtime-owner-v1.js` | 4,086 | line 394 |
| `scripts/inline/gd-gps-play-flow-layers-v1.js` | 1,113 | line 373 |
| `scripts/inline/gd-caddie-gps-patches-v1.js` | 746 | line 292 |
| `scripts/inline/gd-gps-scorecard-owner-v1.js` | 612 | line 395 |
| `scripts/inline/gd-gps-beta-mode-shell.js` | 414 | line 282 |
| `scripts/inline/gd-captured-hole-frame-camera-v19.js` | 2,268 | line 20 |
| `scripts/gd-course-library-pin-lock.js` | 5,682 | line 312 |
| `scripts/gd-course-play-pipeline.js` | 1,141 | line 313 |
| `scripts/inline/gd-auto-map-handoff-quarantine-v1.js` | 154 | line 314 |
| `scripts/inline/gd-gps-location-set-lock-v1.js` | 190 | line 315 |
| `scripts/inline/gd-inline-gps-viewport-lock-v1.js` | 65 | line 317 |
| `scripts/inline/gd-inline-gps-tool-toggle-polish-v1-samebutton.js` | 67 | line 309 |
| `scripts/inline/gd-hole-frame-guide-contract-v20.js` | 50 | line 17 |

Plus, in `gd-app-core.js` (kept, not deletable wholesale): the GPS-play-only
functions this list calls into (`enterGpsPlayAfterMapping`,
`gdCaptureCurrentPlannedShot`, `gdLogBallPositionForTracking`,
`gdCoursePickerDatabaseMapAvailable`'s GPS-specific branches,
`GDCoursePickerCoreBridge`'s GPS methods) need a deliberate carve, not a file
delete — that's the multi-day core-surgery REBUILD-PLAN.md already flagged.
Recommend leaving dead code in core for a follow-up pass rather than blocking
the file-level deletion on it — an unreferenced function that's merely dead
weight is a different risk tier than a loaded, wired subsystem.

**Do not delete**: `scripts/gd-green-shape-engine.js` (locked baseline, §2),
`scripts/gd-multi-nine-courses.js` and `scripts/gd-route-audit.js` (shared,
survive independently per §2/§3c — decide multi-nine's *fate*, not its file).

### 6b. CSS — mostly clean, three files need line-level triage, not deletion

Files safe to delete wholesale (GPS-specific, body-class-gated, zero shared-
chrome selectors found): `styles/gd-gps-badge.css`,
`styles/inline/gd-gps-auto-session-v1.css`,
`styles/inline/gd-gps-layout-*.css`,
`styles/inline/gd-gps-mapped-camera-and-green-focus-v1.css`,
`styles/inline/gd-gps-play-camera-tilt-v1.css`,
`styles/inline/gd-gps-request-button-fix-v1.css`,
`styles/inline/gd-gps-stable-controls-v1.css`,
`styles/inline/gd-gps-state-stabilizer-v1.css`,
`styles/inline/gd-gps-play-runtime-owner-v1-css.css`,
`styles/inline/gd-gps-viewport-lock-css-v1.css`,
`styles/inline/gd-captured-hole-frame-camera-v19-css.css`,
`styles/inline/gd-hole-frame-guide-contract-v20-css.css`,
`styles/inline/gd-stable-gps-mode-switch-v1.css`,
`styles/inline/gd-play-flow-next-hole-style-v1.css`,
`styles/inline/gd-mapping-mode-final-rail-css-v1.css`,
`styles/inline/gd-canonical-module-screen-fix-v1.css`,
`styles/inline/gd-course-picker-hidden-hard-fix-v1.css`,
`styles/inline/gd-course-picker-resume-round-v1-styles.css`.
That's ~404 of the ~688 GPS-scoped `!important` rules gone in one pass — seven
of these files are already orphaned today (their JS owner was merged away
during REBUILD-PLAN's Phase A/B and nobody deleted the leftover CSS).

**Needs manual line-level edits, not a file delete:**
- `styles/gd-shell.css` — real shared shell rules (`#shellTop`,
  `#shellBackBtn`) mixed with `body.shell-gps`-gated override blocks in the
  same 162-line file (e.g. lines 141-154). Delete the gated blocks, keep the
  base rules.
- `styles/inline/gd-app-base.css` — ~78 lines of `#map`/GPS selectors
  scattered non-contiguously through 3,940 shared lines (e.g. lines 9-14,
  129-132, 1015-1035, 3908). Grep-and-delete those specific rules; don't touch
  the file wholesale.
- **`styles/inline/gd-home-buttons-handoff-css-v1.css` — do NOT delete despite
  the name and directory.** It's unconditional home-screen chrome
  (`#gdV62Home`, `.gdHomeHeader`, `.gdHomeBrand*`), none of it GPS-gated. A
  naive "delete everything in `styles/inline/` that looks like a patch layer"
  pass would take the home screen down with it.

Also delete while in here (unrelated to GPS play, found during the sweep, both
provably dead): `styles/clarity-support 2.css` (byte-identical orphaned
duplicate of `clarity-support.css`) and `patches/shot-data-photo-box-fit.patch`
(inert unapplied diff, zero references anywhere, targets a practice-photo-
scanner path unrelated to GPS play).

### 6c. Verification, per REBUILD-PLAN.md's own rule

> Deleting something means deleting it completely: the file, its
> `<script>`/`<link>` tag, its CSS, and every reference — then boot test +
> grep to prove it. No hiding, no suppressing.

After each file/tag/CSS removal: `npm run test:boot` (all three surfaces),
then grep the full tree for the deleted file's basename and its exported
globals (`GDGpsPlayRuntime`, `GDGpsScorecard`, `gdScorecardShell`,
`runCourseMappingAttempt`, `gdCapturedHoleFrameCameraOn`) to confirm zero
remaining references before moving to the next file. That's what makes this
"ruthless but not reckless" — the check is mechanical and fast, not a hedge
that leaves old code half-alive behind a flag.

### 6d. Rollout sequencing

1. Close §3a (billing gate) and land §5's decisions on §3b/§3c.
2. Repoint the home `Play` tile at `/app/` (or promote it to site root, per
   §5's scope decision) — this is the "invert" step, and per §1 it has zero
   dependents to coordinate since nothing links to `/app/` today.
3. Run both surfaces side by side for one release behind normal build/test
   gates (not a runtime feature flag or CSS toggle — an actual old-index.html-
   vs-new-app-tree period, same pattern the `app`/`studio` split already uses)
   only if you want a rollback path; skip straight to step 4 if you don't.
4. Delete per §6a-6c, verify per §6c, ship.

This keeps the "safety" entirely in steps 1 and the verification loop in step
4 — not in runtime guards layered into the deletion itself, which is the exact
pattern this whole migration exists to get rid of.
