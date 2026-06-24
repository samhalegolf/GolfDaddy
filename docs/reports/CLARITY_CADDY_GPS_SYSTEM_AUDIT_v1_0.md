# GPS SYSTEM AUDIT

**Audit type:** Static source audit only. No files were patched, no code was generated for the application, and no deployment or runtime mutation was performed.

**Authority used:** `docs/architecture/CLARITY_CADDY_TRUTH_FILE.md`.

**Build audited:** The top-level custody build, principally `index.html` and the GPS-related files under `scripts/`. The top-level `index.html` and `dist/index.html` are byte-identical. The older nested `Archive.zip` was treated as a historical artifact rather than the current build.

**Runtime limitation:** This report determines static reachability, ownership collisions, fallbacks, and state flow from source. It does not claim device-level confirmation of exact browser event ordering, GPS accuracy, map tile availability, or live-course behaviour.

## Executive Summary

The build contains a credible modern captured-surface camera, but GPS Play does not yet have one deterministic camera owner. V19, V20, the original live-map camera, the mapped-hole camera, State Stabilizer, Spring Clean, GPS locate handlers, and external zoom fallbacks all retain some ability to frame, recenter, zoom, or restore GPS state. V19 likely reclaims several exported globals after its final delayed installation, but direct event listeners, intervals, and closure-held references to older functions remain active. The result is a timing-dependent multi-owner system rather than the single stable framed-box camera required by the Truth File.

The highest risks are:

1. **Box 1 is not fully implemented.** V20 exposes only `hole`, `lock`, and `zoom` guide boxes. It omits the tee box. V19’s default-hole transform fits and centres only the green bounds, and the captured tee is never used to solve the camera transform. The required “green in the inner box + tee near the lower tee box” composition therefore does not exist as one active transform.
2. **Modern Pretend GPS can enter legacy Two-Tap logic.** The modern standing-position flow falls back to `gdCompleteTwoTapPlacement`, and the shared two-state placement machine can switch from “where I am” to “tap the green.” This is a confirmed system collision.
3. **Legacy camera behaviour remains silently reachable.** Live `fitBounds`, `setView`, old simple zoom, whole-hole mapped fitting, and generic map zoom are retained behind fallbacks and direct handlers. Several fail silently rather than presenting a visible failure.
4. **Fairway-line anchoring exists but is bypassable.** The mapped route-sampling algorithm correctly finds a reachable lay-up point. The normal target path uses it only when a tee-proximity gate passes; otherwise it silently projects directly toward the green at max carry. Whole-route camera orientation can also ignore the local fairway segment on doglegs.
5. **Green Zoom and Green Focus are not cleanly separated.** They share classes, controls, camera fallbacks, and state transitions. Green Focus can auto-enter from GPS and is coupled to Shot End and Course Data eligibility.
6. **Course Data pairing is unsafe against the Truth File.** Shot End can create a planned shot at the time of the result instead of requiring a previously held bubble state. The generic pairing engine ignores hole identity, permits very old events, does not consume a result event uniquely, floors confidence at 0.1 rather than rejecting, and stores outcomes before downstream filtering. Low-confidence, implausible, or unpaired outcomes are not safely excluded at collection time.

Overall risk: **Critical for ownership and data integrity; High for framed-box compliance and legacy reactivation.**

## GPS System Table

| System | Purpose | Active? | Truth File Compliant? | Risk |
|---|---|---:|---:|---|
| V20 Hole Frame Guide Contract | Defines fixed screen boxes and debug overlay | Yes; delayed installs and resize reinstall | Partial | **High** — no tee box; repeated refits |
| V19 Captured Hole Frame Camera | Captured raster working surface, object fit, lock freeze, zoom | Yes; likely final exported camera owner after delayed installs | Partial | **High** — Box 1 incomplete; fallback hooks; route-first orientation |
| Captured Surface Model V1 | Per-course/per-hole manifest registry and captured-surface policy | Yes | Mostly | **Medium** — trust flag semantics and live recapture need review |
| Original live-map frame system | `fitBounds`, `setView`, map rotation, lock/zoom framing | Partially; older globals may be overwritten but references survive | No | **High** — generic auto-fit and silent camera fallback |
| External mapped whole-hole camera | Frames mapped tee-route-green and orientates live map | Partially active/reachable | No for normal GPS framing | **High** — whole-hole live auto-fit competes with Box 1 |
| Mapped Camera / Green Focus V1 | Pre-lock presets, lock/green-focus handling, zoom-button ownership | Active listeners and interval; live branch often guarded by captured policy | Partial/No | **High** — duplicate camera owner and focus/zoom collision |
| GPS State Stabilizer | Reasserts GPS states, pre-lock framing, Green Focus, Shot End | Yes; recurring interval and direct handlers | No | **Critical** — duplicate camera and unsafe Course Data coupling |
| GPS Spring Clean Final | Surface guards, Pretend GPS placement, green zoom, shell wiring | Yes; direct listeners, delayed rewires, recurring guard | Partial/No | **Critical** — legacy Two-Tap and old-camera fallbacks |
| GPS Locate / Refresh camera jump | Applies GPS fix and recentres live map | Yes when locate/refresh is used while unlocked | No | **High** — position update owns camera movement |
| Head-to-Tee flow | Starts from mapped tee and projects Bag target | Partially active | Partial | **High** — routes through legacy placement state and direct fallback |
| Pretend GPS Position | Treats map tap as active player position | Yes | No, due collision | **Critical** — can become the legacy shot builder |
| Legacy Two-Tap Shot Builder | Tap start, then tap green to build a shot | Yes and directly reachable | Permitted only if isolated; it is not isolated | **Critical** |
| Fairway lay-up target | Finds a reachable target along mapped route | Yes in mapped paths | Partial | **High** — correct algorithm is gated and bypassed |
| Bubble placement entry paths | Standard, Head-to-Tee, legacy manual, reset, drag | Yes | Partial | **High** — duplicate pathways and inconsistent anchoring |
| Green Zoom systems | Temporary close view for bubble movement | Multiple active/partial implementations | No as a combined system | **High** — conflated with Green Focus and live map |
| Course Data shot-event pairing | Pairs held/planned bubble with later ball position | Yes | No | **Critical** — invalid, reused, cross-hole, stale pairings can save |

## Active Systems

### 1. V20 fixed guide geometry

V20 installs the current `hole`, `lock`, and `zoom` frame rectangles and publishes the corresponding screen-frame functions. It installs on DOM readiness, at 800 ms, 1.8 s, 3.4 s, 5.6 s, and after resize. Each installation may call V19 again using the last captured fit (`index.html:122-169`).

It is active and central to current geometry, but it is not a complete implementation of the Truth File because its frame specification has no tee box (`index.html:129-137`). The earlier base configuration does include a `tee` frame (`index.html:14119-14143`), but V20 replaces the public configuration functions with its own three-box contract. The active guide therefore cannot express the required Box 1 tee placement.

### 2. V19 captured-hole-frame camera

V19 is the strongest candidate for the intended camera core. It:

- validates capture manifests against the active course and hole (`index.html:371-379`);
- captures mapped route, green shape, tee, and green anchors (`index.html:388-470`);
- renders a stable captured tile surface instead of using the live map as the visible camera (`index.html:497-535`);
- applies a deterministic translate/rotate/scale transform into a fixed box (`index.html:561-600`);
- freezes the camera after lock so the bubble can move without camera chase (`index.html:847-900`);
- supports a temporary captured-surface zoom and returns to the lock frame (`index.html:675-707`, `907-914`);
- replaces many exported setup, pre-lock, lock, frame, and zoom functions (`index.html:991-1029`);
- reinstalls repeatedly through 6.2 seconds and on resize (`index.html:1040-1042`).

This should remain the base of the future stable camera, but it is only partially compliant. Its Box 1 path calls `greenBounds("hole")`; its transform centres that object in the `hole` box; and the tee coordinate is not part of the transform calculation (`index.html:299-318`, `561-600`, `860-884`). The capture knows the tee, but the camera does not solve green and tee jointly.

### 3. Captured Surface Model

The captured-surface registry is active and broadly matches the Truth File. It owns course/hole manifests, exposes captured-surface policy, marks the captured layer as interaction owner, and describes live map as a diagnostic/reference layer (`index.html:1045-1244`). Active-course and active-hole validation is a strong keep item.

The scan metadata currently includes `trusted:false` (`index.html:1111-1145`). Static review cannot establish whether that is only descriptive metadata or whether trusted green geotags are never formally asserted. This requires investigation because the Truth File makes trusted green truth foundational.

### 4. GPS locate and refresh

The build contains two live-map jump implementations in the same broad GPS fix area. The later implementation exports both `gdGpsLocateNow` and `refreshGPS` with `{jump:true}` and binds the GPS rail button directly to that function (`index.html:26264-26532`). A later button-fix module repeatedly rewires the same button family to these calls (`index.html:33046-33108`).

This is active behaviour, not dead code. It means obtaining or refreshing a GPS fix can also claim camera ownership and call live `map.setView`, even though the captured surface is supposed to remain the stable working surface.

### 5. State Stabilizer and Spring Clean

Both late modules install direct event handlers and recurring timers. State Stabilizer runs recurring GPS-state enforcement, pre-lock framing, Green Focus, and Shot End logic. Spring Clean captures older function references in closure, exposes new global wrappers, adds pointer/click handlers, rewires at 120/500/1500/3000 ms, and runs a 260 ms guard (`index.html:39543-41155`, `41342-42230`).

Even when V19 later overwrites an exported global, these modules retain their own listeners and closure references. They are active owners, not merely old source text.

### 6. Pretend GPS and shot-event collection

The modern manual standing-position interaction is active through Spring Clean’s pointer handling and the shared placement functions. Shot plan capture, ball-position logging, and generic pairing are also active through `gdCaptureCurrentPlannedShot`, `gdLogBallPositionForTracking`, and the shot-events module (`index.html:17260-17510`; `scripts/gd-shot-events.js:257-397`).

Their current coupling is unsafe and is detailed below.

## Partially Active Systems

### Original live-map camera and frame functions

The original camera still defines:

- live map rotation and fairway orientation;
- screen-frame configuration, including a tee frame;
- point framing with `map.setView`;
- simple green zoom using stored live-map centre/zoom;
- whole-shot `frameShotView` using `map.fitBounds`;
- `lockFrame` with a `map.setView` recovery path;
- frame-tightness cycling and other case-by-case camera strategies.

Evidence: `index.html:13736-14231`.

V19 likely overwrites several public functions in steady state, but older functions remain reachable through saved references, fallbacks, direct listeners, and initialization windows. This is partially active legacy code.

### External mapped whole-hole/pre-lock camera

The course-library module constructs a mapped route from tee, fairway points, and green, adds artificial lateral/back/beyond points, and fits the live map to all of them (`scripts/gd-course-library-pin-lock.js:1651-1728`, `1837-1882`). This is a generic whole-hole auto-fit system rather than the fixed Box 1 composition.

The captured-surface policy guards some later mapped-camera branches, so this is not guaranteed to own every current pre-lock frame. It is nevertheless statically reachable and invoked by pre-lock functions and fallback controls.

### Mapped Camera / Green Focus V1

This module defines three pre-lock presets, live whole-route framing, captured-first Green Focus with live-map fallback, and a single snap-zoom button that can drive pre-lock, lock, or Green Focus. It also wraps pre-lock queues and runs every 650 ms (`index.html:38442-38902`).

When captured-surface policy is active, its live pre-lock branch often returns early. Its handlers, wrapper, state machine, and Green Focus logic remain active. It is therefore partially active and still a duplicate owner.

### State Stabilizer camera wrapper

State Stabilizer overrides `frameShotView` with a whole-shot live `fitBounds` implementation and catches back to the previous function (`index.html:41095-41125`). V19’s later delayed reinstall probably overwrites the exported function, but the wrapper remains part of startup ordering and its saved prior function remains a fallback. This is timing-dependent partial reachability.

### Head-to-Tee

Head-to-Tee has intended value as a mapped start flow and uses the Bag to select a target. It is only partially compliant because it enters through the same two-tap placement machine and uses direct-to-green projection when the mapped fairway target is unavailable (`index.html:15558-15658`).

### Old simple green zoom

The base simple zoom may be overwritten globally, but Spring Clean stores a direct reference to the old implementation during module initialization and uses it when V19 zoom fails (`index.html:41355-41363`, `42003-42027`). It is partially active through closure even if its old global name no longer points to it.

## Legacy Systems Still Reachable

The following legacy systems are not merely present; a current path can still call them:

1. **Legacy Two-Tap Shot Builder**
   - `setGpsPlayMode("twoTap")`;
   - `gdModeTwoTap`;
   - state `mode="start"` then `mode="green"`;
   - prompts “Tap twice: ball then green”;
   - direct `gpsTwoTapBtn` rewiring.
   - Evidence: `index.html:26620-26749`.

2. **Shared legacy placement state machine**
   - `gdCompleteStandingStartPlacement` can transition to `mode="green"`;
   - `gdCompleteTwoTapPlacement` handles both start and green taps;
   - global map click/pointer handlers call it.
   - Evidence: `index.html:15761-15896`.

3. **Original whole-shot live camera**
   - `frameShotView` fits start, target, green, and pin into the live map;
   - `lockFrame` has live-map fallback.
   - Evidence: `index.html:14190-14231`.

4. **Original simple live-map green zoom**
   - stores live map centre/zoom, moves the live map, and restores it.
   - Evidence: `index.html:14165-14188`.
   - Retained by Spring Clean closure fallback.

5. **Mapped whole-hole live auto-fit**
   - fits the tee-route-green corridor with extra synthetic points.
   - Evidence: `scripts/gd-course-library-pin-lock.js:1651-1728`, `1837-1882`.

6. **Generic snap-zoom fallback**
   - attempts mapped pre-lock preset;
   - then mapped pre-lock focus;
   - then `map.zoomIn`.
   - Evidence: `scripts/gd-course-library-pin-lock.js:4539-4570`.

7. **Direct live-map GPS jumps**
   - GPS locate/refresh invokes live `map.setView`.
   - Evidence: `index.html:26264-26532`.

8. **Case-by-case camera presets**
   - frame-tightness cycling and separate Hole/Ready/Tight preset concepts remain.
   - Evidence: `index.html:13966-13980`, `38447-38450`.

These systems should not be assumed safe merely because they are older. Their continued reachability directly conflicts with the Anti-Zombie rule.

## Hidden Fallbacks

| Current path | What can fail | Hidden fallback | Safe/explicit? | Finding |
|---|---|---|---|---|
| V19 setup, lock, and zoom | Captured fit returns false | `fallbackNative(...)` calls old `gdFitObjectToFrame` | No | Armed fallback; no definition was found in the current root build, but it would silently revive if reintroduced |
| V19 manifest loading | No valid cached captured manifest | Builds a new manifest from current active/live bounds | Narrowly understandable, but silent | Reinterprets the working surface during play instead of visibly failing |
| Spring Clean manual-start lock | V19 lock unavailable/fails | Closure-held old `lockFrame` | No | Direct legacy camera resurrection |
| Spring Clean green zoom | V19 captured zoom unavailable/fails | Closure-held old simple live-map zoom | No | Box 3 can silently become old live-map zoom |
| Spring Clean zoom return | V19 lock return unavailable/fails | Closure-held old lock function | No | Can restore a different camera owner |
| State Stabilizer Green Focus | V19 captured fit fails | Live `map.fitBounds` | No | Green Focus silently changes camera model |
| State Stabilizer shot frame | Whole-shot wrapper errors | Previous `frameShotView` | No | Fallback chain between legacy camera implementations |
| External snap-zoom listener | Preferred mapped preset unavailable | mapped focus, then `map.zoomIn` | No | Three different systems behind one control |
| Base point/lock framing | frame calculation or fit fails | `map.setView` | No | Generic live camera replaces fixed-box behaviour |
| Fairway target selection | mapped lay-up unavailable or gate fails | straight projection toward green | No | Changes target logic without visible disclosure |
| Course Data pending-shot API | `getPendingShot`/`logOutcomeForPending` unavailable | generic `logBallPosition` + `pairPendingShots` | No | Silently uses a weaker pairing model |

None of these fallbacks answers all four Truth File questions: what failed, why the fallback is safe, what it falls back to, and why fallback is better than visible failure. Most are therefore non-compliant.

## Legacy Reactivation Risks

### Repeated global replacement

V19 assigns many global camera functions and reinstalls after DOM load and at multiple delayed times through 6.2 seconds (`index.html:991-1042`). V20 installs and may trigger a V19 refit through 5.6 seconds (`index.html:155-169`). Spring Clean rewires through 3 seconds and retains old functions in closure (`index.html:41342-42230`). Mapped Camera and State Stabilizer also wrap or replace camera globals and run recurring intervals.

Static load order suggests V19 probably becomes the final value of several globals. That does not remove:

- direct listeners already attached to buttons and map surfaces;
- interval callbacks that call their own local functions;
- old functions captured in closure;
- startup windows before the final V19 reinstall;
- same-target listeners that can both run.

Camera ownership is therefore not deterministic.

### Same control, multiple listeners

The external course-library module binds a non-capture click listener to `gdGpsSnapZoomBtn` every 650 ms until installed (`scripts/gd-course-library-pin-lock.js:4539-4570`). Mapped Camera also binds the same button. Stopping propagation does not necessarily prevent another listener on the same target unless immediate propagation is stopped. One click can therefore enter more than one camera path.

### Saved old functions

Spring Clean records the old `gdToggleSimpleGreenZoom` and old lock functions before later globals settle. Those saved references are unaffected when V19 overwrites the global name, so the legacy implementation remains callable.

### Startup timing

State Stabilizer’s whole-shot live wrapper can be active before V19’s delayed overwrite. Device speed, script execution timing, DOM readiness, resize, and user interaction timing can alter which owner handles an early action.

## Frame-Box Violations

### Box 1: default hole view

**Violation confirmed.**

The Truth File requires two simultaneous anchors: green mostly filling the inner green box and tee near the lower tee box.

Current behaviour:

- V20 defines no tee rectangle (`index.html:129-137`).
- V19’s `hole` path uses only `greenBounds("hole")` (`index.html:299-318`, `860-884`).
- The transform centres the fitted object in the selected frame (`index.html:561-600`).
- Although the capture manifest stores the tee, `teeLatLng` is not used to calculate the camera transform.
- The default `hole` fit ratio is 0.56, deliberately reducing the object relative to the available box (`index.html:577-580`).

The result is a green-only Box 1 fit, not a green-plus-tee framed composition.

### Box 2: shot lock-in

**Partially compliant in V19, violated by competing paths.**

V19’s lock frame generally fits the active shot object and does not require the origin/GPS dot. It also freezes the camera, which is consistent with the target-decision-area principle.

However:

- the original `frameShotView` fits start, target, green, and pin into the live map (`index.html:14190-14217`);
- State Stabilizer installs a similar whole-shot live fit (`index.html:41095-41125`);
- mapped whole-hole framing can re-enter;
- `gdActiveShotObjectBounds` can add the green to the bubble bounds when they are within 95 m (`index.html:15930-15958`), so the active object is not always strictly “either green or bubble.”

The V19 path should remain; the competing whole-shot and mixed-object fits should not retain hidden ownership.

### Box 3: Green Zoom

**Violation confirmed.**

V19’s captured temporary zoom is directionally correct in isolation. Across the build, however:

- `gd-green-zoom-active` is used by both bubble zoom and Green Focus (`index.html:675-682`, `39762-39787`);
- Green Focus can auto-enter based on GPS proximity (`index.html:39819-39825`);
- the same control can trigger pre-lock, lock, Green Focus, or fallback map zoom;
- Spring Clean can fall back to old live-map zoom (`index.html:42003-42027`);
- Green Focus is coupled to Shot End and Course Data eligibility.

Box 3 is therefore not a visual-only state that is cleanly separate from Green Focus and normal GPS behaviour.

### Generic auto-fit remains

The original camera, mapped whole-hole camera, Mapped Camera, Green Focus live fallback, State Stabilizer wrapper, and GPS recenter all retain live `fitBounds`, `setView`, or generic zoom behaviour. These violate the instruction not to replace framed boxes with generic map auto-fit.

### Capture size preference

V19 can produce broad captures at zoom 18–20 with large bleed and up to hundreds of tiles (`index.html:416-464`). This may work technically, but it conflicts with the stated preference for smaller high-definition captures over one huge low-confidence full-hole capture. This is an investigation item rather than proof of functional failure.

## Two-Tap Collisions

**A direct collision is confirmed.**

### Shared state machine

`gdCompleteStandingStartPlacement` sets the player start. In mapped assist it may auto-lock the mapped green. In unmapped flow it changes the shared mode to `green` and instructs the user to tap the green. `gdCompleteTwoTapPlacement` dispatches either the start action or green-setting action according to this shared mode (`index.html:15761-15817`). Global map click/pointer handlers use that same function (`index.html:15818-15896`).

That behaviour is the Legacy Two-Tap Shot Builder, not merely Pretend GPS Position.

### Modern Pretend GPS fallback to legacy function

Spring Clean’s modern standing-point handler first tries the standing-position function and, if unavailable, calls `gdCompleteTwoTapPlacement` directly (`index.html:41935-41969`). This is an explicit bridge from modern Pretend GPS into legacy two-tap state.

### Head-to-Tee collision

`gdUseMappedTeeAsStart` also routes through `gdCompleteTwoTapPlacement` (`index.html:15558-15579`). A mapped tee-start helper should not rely on a state machine that can interpret the next tap as a manual green.

### Ambiguous naming

Collision-prone names and states include:

- `manual mode`;
- `Manual GPS`;
- `twoTap`;
- `gdModeTwoTap`;
- `manual-start`;
- `tap-where-standing`;
- `gdManualStartPlacementActive`;
- generic `mode="start"` and `mode="green"`;
- `gdCompleteTwoTapPlacement`.

The Truth File specifically warns against this naming. The two systems need distinct state, handlers, and names before any further GPS changes.

## Live-Map Realignment Risks

### Finding

**Yes, the build can return to live-map interpretation or camera alignment after a captured hole exists.** No evidence was found of a continuous geospatial recalibration of an already valid V19 manifest on every refresh, so the risk should be stated precisely: the captured projection is reasonably stable when a valid manifest exists, but multiple active paths still recapture from, frame from, or recentre the live map during play.

### Specific paths

1. **On-demand captured manifest rebuild**
   - If no matching manifest is found, V19 derives active hole bounds and builds a capture (`index.html:473-495`).
   - This is a silent live reference reinterpretation during play.

2. **GPS locate/refresh**
   - The active GPS fix path recentres the live map (`index.html:26264-26532`).

3. **Original and State Stabilizer camera functions**
   - `map.fitBounds` and `map.setView` remain in setup, lock, Green Focus, and fallback paths (`index.html:14154-14231`, `39712-39742`, `41095-41125`).

4. **External mapped whole-hole fit**
   - Re-derives the view from tee, route, green shape, and synthetic corridor points (`scripts/gd-course-library-pin-lock.js:1651-1728`, `1837-1882`).

5. **External zoom fallback**
   - Can invoke mapped pre-lock focus or generic `map.zoomIn` (`scripts/gd-course-library-pin-lock.js:4539-4570`).

6. **Green Focus fallback**
   - Uses the captured camera first and then live `fitBounds`.

The captured frame is therefore not the sole working surface.

## Fairway-Line Anchoring Findings

### Correct logic exists

The course-library module contains a strong route-sampling implementation:

- samples progress along the mapped route;
- starts from the route point nearest the player;
- selects a point reachable by max carry;
- rejects points that are too short;
- returns the green only when already reachable.

Evidence: `scripts/gd-course-library-pin-lock.js:1768-1825`.

This logic should remain.

### It is bypassed in normal target selection

`gdTargetForGreenCentre` uses the mapped fairway lay-up only when `gdFairwayLineGrabAllowed()` is true. That gate is tied largely to proximity to the mapped tee—approximately 78 m normally or 110 m for Head-to-Tee. If the gate is false or the mapped call fails, the code directly projects max carry from the player toward the green (`index.html:13787-13827`, `14262-14273`).

Consequences:

- a player farther down a par 4 or par 5 can lose fairway anchoring;
- a dogleg can receive a straight-line target through rough, trees, or out of bounds;
- the system silently changes target policy instead of visibly reporting missing route truth.

### Head-to-Tee is better but still falls back

Head-to-Tee explicitly attempts the mapped fairway lay-up. If that returns no point, it also directly projects toward the green (`index.html:15588-15658`).

### Camera orientation can ignore the local fairway segment

V19’s orientation priority takes the bearing from the first to the last point of the whole mapped route before tee-to-green, shot axis, or direct shot (`index.html:269-287`). The external mapper contains a local fairway-axis function, but V19 does not prefer it. On a dogleg, whole-route start-to-end bearing is not necessarily the correct local camera orientation.

### Conclusion

Fairway-line anchoring is **present, valuable, and partially active**, but the build violates the Truth File because it can be bypassed by tee-proximity gating, missing route responses, direct projection fallback, and whole-route orientation.

## Bubble Placement Findings

This audit did not inspect or alter Bubble Engine maths. It reviewed only GPS placement ownership.

### Placement paths found

1. Standard target creation through `gdTargetForGreenCentre`.
2. Head-to-Tee Bag target through `gdApplyHeadToTeeBagTarget`.
3. Legacy Two-Tap green placement.
4. Reset/home/new-hole reconstruction.
5. Mapped assist auto-lock.
6. Captured-surface drag and long-press movement.
7. Green Focus ball/end placement.

These are duplicate entry pathways into the GPS bubble/target state. They do not prove duplicate Bubble Engine mathematics, but they create inconsistent policy.

### Main risks

- Standard placement can bypass the fairway route and stretch directionally toward the green at max carry.
- Head-to-Tee uses better mapped logic but silently falls back to direct projection.
- Legacy Two-Tap can define the green and shot in the same state machine as Pretend GPS.
- Active shot bounds may combine bubble and green when close, changing what Box 2 fits (`index.html:15930-15958`).
- Old live-map camera systems and V19 captured drag systems both retain input/camera responsibilities.
- Moving a bubble does correctly invalidate an unpaired current plan (`index.html:17317-17349`), which is a keep item.

### Conclusion

There are duplicate **placement/state-entry systems**, not enough evidence of duplicate core bubble maths. Placement ownership should be consolidated around one GPS policy after the systems are isolated.

## Green Zoom Findings

**Green Zoom is not cleanly separated from Green Focus.**

### Green Zoom implementations found

1. Original simple live-map green zoom (`index.html:14165-14188`).
2. V19 captured target zoom (`index.html:907-914`).
3. V19 long-press captured bubble zoom (`index.html:675-707`).
4. Bubble zoom path with target/simple/point fallback (`index.html:15967-16012`).
5. Mapped Camera snap-zoom/pre-lock/lock/focus controller (`index.html:38442-38902`).
6. State Stabilizer Green Focus camera with captured-first/live fallback (`index.html:39712-39787`).
7. Spring Clean captured zoom wrapper with old simple-zoom fallback (`index.html:42003-42027`).
8. External zoom fallback listener (`scripts/gd-course-library-pin-lock.js:4539-4570`).

### Focus collision

State Stabilizer enters Green Focus with both `gdGreenArrivalMode` and `gd-green-zoom-active` (`index.html:39762-39787`). It can auto-enter from GPS proximity (`index.html:39819-39825`). Green Focus also determines whether a shot is available to log and owns Shot End outcome placement.

Mapped Camera’s Green Focus can set or substitute player-position state based on green proximity, and its camera can fall back to live `fitBounds` (`index.html:38655-38724`). A visual zoom mode should not mutate GPS/player state.

### Conclusion

V19’s captured temporary zoom is the closest match to Box 3. The surrounding Green Focus, live zoom, auto-entry, button multiplexing, and Course Data coupling prevent Box 3 from being an isolated visual-assistance mode.

## Course Data Pairing Findings

### What is correct

- A planned shot records origin, hole, club, expected distance, and the rendered bubble (`scripts/gd-shot-events.js:257-287`).
- Bubble movement can delete/invalidate the current unpaired plan (`index.html:17317-17349`).
- The intended capture path can create a plan at lock time when start and target exist (`index.html:17269-17370`).

These are useful foundations.

### Shot End does not require a valid previous held bubble

State Stabilizer’s eligibility test returns true if any of the following exists:

- a pending course shot;
- any `target`;
- any `gdCurrentPlannedShotId`.

Evidence: `index.html:40107-40110`.

At Shot End, `logPointOnly` can call `gdCaptureCurrentPlannedShot` immediately if a target exists and no current logged plan is present (`index.html:40135-40149`). That creates the planned shot at result time. It does not prove that the same bubble had been held before the shot.

This directly violates the Truth File requirement that no save occurs without a valid pairing between Shot End and the previously held bubble state.

### Intended pending-shot API is absent

`gdPendingCourseShot()` looks for `getPendingShot` (`index.html:17494-17500`). `gdLogBallPositionForTracking()` prefers `logOutcomeForPending`; otherwise it calls generic `logBallPosition` and `pairPendingShots` (`index.html:17425-17459`).

The exported shot-events API contains no `getPendingShot`, `logOutcomeForPending`, or `clearPendingShot` (`scripts/gd-shot-events.js:518-540`). The supposedly stronger path is therefore unavailable in the audited root build, and normal behaviour falls into the generic pairer.

### Generic pairer is not safe

For every unpaired planned shot, `pairPendingShots` selects the earliest later event with:

- the same round;
- the same player scope;
- a different event ID;
- a timestamp at or after shot creation.

Evidence: `scripts/gd-shot-events.js:339-378`.

It does **not** require:

- the same hole;
- a unique, unconsumed result event;
- a maximum elapsed time;
- plausible travelled distance;
- acceptable GPS accuracy;
- a minimum confidence threshold;
- an explicit shot/bubble token.

The same later result event can therefore pair to multiple outstanding shots. A result on the next hole can pair to an old unpaired shot from the previous hole. A very stale event remains eligible.

### Confidence does not reject a pair

`scorePair` floors confidence at 0.1 (`scripts/gd-shot-events.js:322-330`). It never rejects a pairing for low confidence.

### Outcomes are stored before safe filtering

`computeShotOutcome` returns and records an outcome for coordinate-valid data and carries confidence as metadata; it does not reject crazy distance or low confidence (`scripts/gd-shot-outcomes.js:85-127`). Cluster analysis later marks `counted` from `distanceViable` only; it does not require degree viability or a confidence threshold (`scripts/gd-shot-cluster-analysis.js:129-185`).

This is downstream analytical filtering, not safe collection gating. The questionable record already exists.

### Course Data and GPS ownership are mixed

GPS State Stabilizer and Green Focus decide:

- whether a shot exists to log;
- whether to create a plan at Shot End;
- which end point to use;
- when to call the pairer;
- when to move to the next hole.

The Truth File assigns “deciding what to send and what not to send” to Course Data Collection, not GPS Play. These systems are not cleanly separated.

### Answers to data questions

- **Is Shot End paired with the previous held bubble state before save?** No.
- **Are low-confidence, crazy, or unpaired results safely ignored?** No. There is partial downstream distance filtering, but no strict pre-save rejection.

## Required Question Answers

1. **What GPS camera/framing systems currently exist?**  
   V20 guide geometry; V19 captured-hole-frame camera; Captured Surface Model; original live-map frame/rotation/zoom system; mapped whole-hole/pre-lock camera; Mapped Camera presets and Green Focus; State Stabilizer frame and focus logic; GPS locate/refresh recenter; Head-to-Tee framing; and multiple simple/captured/long-press zoom paths.

2. **Which systems are active?**  
   V20, V19, Captured Surface Model, GPS locate/refresh, State Stabilizer, Spring Clean, modern standing-position handling, the legacy Two-Tap button/state, and the shot-event engine. Mapped Camera and external zoom listeners are also actively installed, even where captured-policy guards suppress some live branches.

3. **Which systems are partially active?**  
   The original live-map camera, mapped whole-hole auto-fit, Mapped Camera live framing, State Stabilizer’s `frameShotView` override, Head-to-Tee, original simple green zoom, and older lock functions.

4. **Which systems appear legacy but still reachable?**  
   Legacy Two-Tap Shot Builder, original whole-shot `frameShotView`, original `lockFrame`, original simple live-map green zoom, mapped whole-hole live fit, generic map zoom, direct GPS camera jumps, and case-by-case frame presets.

5. **Are there hidden fallback paths?**  
   Yes. Captured fit to old/native fit, captured-manifest absence to live recapture, V19 zoom/lock to old live zoom/lock, Green Focus to live fit, snap zoom to mapped focus or generic zoom, fairway anchor to direct projection, and intended pending-shot APIs to generic pairing.

6. **Are old systems silently reactivated anywhere?**  
   Yes. Spring Clean closure fallbacks, State Stabilizer camera fallbacks, external zoom fallback, base live-map recovery calls, and repeated global/listener ownership all allow reactivation.

7. **Does any code attempt to realign against live map after hole capture?**  
   Yes in camera/framing terms: GPS recenter, live `fitBounds`/`setView` fallbacks, mapped whole-hole framing, and on-demand capture reconstruction. No continuous re-projection of an already valid V19 manifest was identified.

8. **Does any code violate the framed-box model?**  
   Yes. Box 1 lacks a tee-box transform; old systems use generic whole-shot or whole-hole auto-fit; Box 2 can be replaced by origin-inclusive fits; Box 3 is conflated with Green Focus.

9. **Does any code violate the green-truth-first principle?**  
   Yes, partially. V19’s current green cascade checks mutable `target` before mapped green truth; some camera data requires tee/fairway completeness; route-first orientation can outrank local green/shot context; and the captured scan’s `trusted:false` semantics are unresolved.

10. **Does any code violate fairway-line anchoring?**  
    Yes. Correct mapped anchoring exists but is gated by tee proximity and silently replaced by straight projection. Whole-route orientation can also bypass the local fairway segment.

11. **Does any code mix Legacy Two-Tap Shot Builder with Pretend GPS Position?**  
    Yes. The modern standing-position flow can call `gdCompleteTwoTapPlacement`, and the shared mode machine transitions from standing position to green placement.

12. **Does any code use ambiguous naming that could cause system collisions?**  
    Yes: manual mode, Manual GPS, twoTap, tap-where-standing, manual-start, shared start/green modes, and `gdCompleteTwoTapPlacement`.

13. **Are there duplicate camera systems?**  
    Yes. There are multiple captured, live-map, mapped-hole, focus, recenter, and wrapper owners.

14. **Are there duplicate zoom systems?**  
    Yes. Base simple zoom, V19 target zoom, V19 long-press zoom, Mapped Camera snap zoom, Green Focus zoom, Spring Clean wrapper, and external generic fallback.

15. **Are there duplicate bubble placement systems?**  
    Yes at the GPS placement/state-entry level: standard, Head-to-Tee, mapped assist, legacy Two-Tap, reset, drag, and focus paths. This audit does not find or claim duplicate Bubble Engine maths.

16. **Is green zoom separate from green focus?**  
    No.

17. **Are Course Data Collection and GPS Play cleanly separated?**  
    No. GPS State Stabilizer and Green Focus decide eligibility, create plans, log endpoints, invoke pairing, and advance flow.

18. **Is Shot End paired with the previous held bubble state before saving Course Data?**  
    No.

19. **Are low-confidence/crazy/unpaired shot results safely ignored?**  
    No. Confidence is descriptive, stale/cross-hole/reused-event pairing is possible, and outcomes are stored before limited downstream filtering.

20. **What should be kept, isolated, removed, or investigated further?**  
    See the table below.

## Recommended Keep / Isolate / Remove

| Item | Keep / Isolate / Remove / Investigate | Reason | Risk |
|---|---|---|---|
| V19 captured translate/rotate/scale camera core | **Keep** | Best match to captured working surface and fixed target-area framing | Medium until ownership is exclusive |
| V19 frozen lock-frame behaviour | **Keep** | Prevents camera chase after lock and prioritises decision area | Low |
| Captured Surface Model course/hole registry and manifest validation | **Keep** | Preserves captured frame ownership and rejects wrong course/hole manifests | Low/Medium |
| V20 fixed guide-box concept | **Keep** | Correct architectural direction | High until tee box and single install ownership are resolved |
| Mapped route-sampling lay-up algorithm | **Keep** | Correctly anchors unreachable shots along fairway route | Low |
| Planned-shot invalidation when bubble moves | **Keep** | Prevents stale held-bubble state from remaining current | Low |
| Legacy Two-Tap Shot Builder | **Isolate** | Truth File permits it only as an explicit standalone manual tool | Critical while sharing state/handlers |
| Pretend GPS Position / GPS Override Tap | **Isolate** | Must update player position only and must never request a green tap | Critical |
| Head-to-Tee | **Isolate** | Useful explicit mapped workflow, but must not use legacy two-tap state | High |
| Green Zoom | **Isolate** | Should be visual-only captured Box 3 mode | High |
| Green Focus | **Isolate** | Separate arrival/outcome workflow; must not reuse zoom state or mutate GPS invisibly | Critical |
| Course Data Collection gate/pairing | **Isolate** | Must own save/no-save decision independently of GPS camera/state | Critical |
| Live map | **Isolate** | Retain for capture, mapping, diagnostics, or deliberately approved extension only | High |
| Original live `frameShotView` and `lockFrame` as GPS fallbacks | **Remove** | Generic whole-shot map fitting violates fixed Box 2 and Anti-Zombie rule | High |
| GPS locate/refresh camera recenter | **Remove camera ownership** | Position acquisition should not replace captured-frame camera state | High |
| External snap-zoom fallback listener | **Remove** | Multiplexes old mapped and generic zoom behind one control | High |
| Spring Clean old simple-zoom and old-lock fallbacks | **Remove** | Closure-held legacy camera can silently revive | High |
| Duplicate delayed installers, wrappers, and camera intervals | **Remove after owner selection** | Cause timing-dependent state and duplicate actions | Critical |
| Duplicate live-map Green Focus cameras | **Remove** | Green Focus should have one explicit camera policy | High |
| Straight-to-green fallback when mapped fairway anchoring is required | **Remove or visibly fail after investigation** | Can place target off the intended fairway route | High |
| Box 1 dual-anchor transform | **Investigate** | Needs one deterministic transform that places green and tee in their respective boxes | Critical |
| V20 omission of tee guide | **Investigate** | Current active frame contract cannot express complete Box 1 | High |
| Captured scan `trusted:false` semantics | **Investigate** | Must establish whether green geotags are genuinely trusted | High |
| V19 target-first green-point cascade | **Investigate** | Mutable target may outrank confirmed mapped green truth | High |
| V19 route-start-to-route-end orientation | **Investigate** | Can misorient local shot context on doglegs | High |
| On-demand live capture rebuild | **Investigate** | Must be an explicit narrow recovery, not a silent reinterpretation | High |
| Capture size/tile policy | **Investigate** | Truth File prefers smaller high-definition captures | Medium |
| Deliberate outside-captured-frame extension | **Investigate** | Required edge-case design should not unpredictably switch to live map | Medium |
| Strict shot/bubble pairing token | **Investigate** | Must prove result belongs to the previously held bubble | Critical |
| Same-hole, unique-event, expiry, confidence, GPS, and plausibility gates | **Investigate** | Required to prevent corrupt Course Data | Critical |
| Runtime event-order/device test | **Investigate** | Static source proves reachability but not exact browser ordering | High |

## Do Not Patch Yet

Do not patch yet. Create a GPS Stabilisation Plan next.
