# GPS STABILISATION PLAN

According to the GPS audit, the current build has a credible captured-surface camera but no deterministic GPS owner. Camera, zoom, placement, focus, round-flow, and Course Data responsibilities remain shared across several active and partially active systems.

Mixed modules are classified by responsibility: a valid capability may be retained while the same module’s fallback or ownership role is removed.

## Systems To Keep

| System | Reason | Dependencies |
|---|---|---|
| **GPS Play round-flow ownership** | GPS Play is the correct owner of active round state, hole progression, GPS-position use, and target presentation. | Course Map truth, GPS Position, target-placement policy, framed-box camera, and isolated Course Data events. |
| **Captured Surface Model V1 registry and manifest validation** | Establishes the captured hole frame as the working surface and prevents course/hole identity drift. | Trusted frame provenance, trusted green geotags, explicit invalid-frame failure, and no silent live reconstruction. |
| **V20 fixed guide-box contract** | Correctly expresses the intended Box 1, Box 2, and Box 3 framing model. | Complete Box 1 tee guide, one geometry authority, and no repeated ownership reassertion. |
| **V19 captured translate/rotate/scale camera core** | Best existing match for a camera operating on the captured surface rather than treating the live map as primary. | Captured Surface manifest, V20 box geometry, green-truth-first inputs, and exclusive camera ownership. |
| **V19 frozen lock-frame behaviour** | Preserves the target decision area and prevents camera chase after shot lock. | A valid Box 2 subject decision and exclusive lock ownership. |
| **Mapped route-sampling lay-up algorithm** | Correctly finds a reachable point along the mapped fairway when the green is beyond Bag range. | Valid fairway geometry, current player position, max Bag range, and local fairway direction. |
| **Planned-shot invalidation when the Bubble moves** | Prevents a stale held Bubble state from remaining eligible for later Course Data pairing. | Course Data Collection owning shot identity and save/no-save decisions. |
| **GPS position acquisition** | Required to update the player’s real position during GPS Play. | A strict boundary preventing position acquisition from moving or replacing the captured-frame camera. |

These retained systems must serve green truth, fairway anchoring, the captured working surface, and the three fixed camera boxes. The Truth File requires one stable framing system rather than generic auto-fit or continuous live-map reinterpretation.

## Systems To Isolate

| System | Reason | How To Isolate | Risk |
|---|---|---|---|
| **Legacy Two-Tap Shot Builder** | Permitted only as a standalone manual shot-construction tool. | Give it its own entry, session, inputs, state, result, and exit. It must have no automatic path into GPS Play. | **Critical** while it shares standing-position and green-placement state. |
| **Pretend GPS Position / GPS Override Tap** | Must be preserved, but its sole meaning is “use this point as the active player position.” | A dedicated one-tap position boundary. It must never request a green tap or enter Two-Tap state. | **Critical** until the legacy bridge is absent. |
| **Head-to-Tee** | Potentially useful explicit workflow, but currently shares legacy placement ownership and can bypass fairway anchoring. | Treat as its own named start workflow. It may request target placement but cannot own a second target algorithm or reuse Two-Tap state. | **High**. |
| **Green Zoom** | Box 3 is a temporary visual aid, not a playing-state or outcome workflow. | Give it a distinct visual-only lifecycle and return destination. It cannot alter GPS position, Green Focus, Shot End, Course Data, or persistent lock state. | **High** until separated from Green Focus and live-map zoom. |
| **Green Focus** | It is an arrival/outcome workflow, not another name for Green Zoom. | Green Focus owns its workflow state only. Camera movement remains with the framed-box camera; save/no-save remains with Course Data Collection. | **Critical** because it currently crosses camera, GPS, Course Data, and hole-flow boundaries. |
| **Course Data Collection gate and pairing** | Course Data Collection must independently decide whether a result is valid enough to save. | GPS Play supplies events but cannot create retrospective plans, select a pairing, or decide eligibility. No valid previous held-Bubble pairing means no save. | **Critical**; missing data is preferable to corrupt data. |
| **Live map** | Still useful for course capture, mapping, diagnostics, and a deliberately approved extension workflow. | Keep it outside normal captured-surface GPS Play. It cannot silently become the camera, zoom surface, or recovery surface. | **High** while live-map paths remain reachable from normal GPS controls. |

GPS Play owns round flow; Course Data Collection owns what is saved and must reject results that cannot be paired with the previous held Bubble state.

## Systems To Remove

| System | Reason | Removal Risk |
|---|---|---|
| **Original live-map frame system** | Generic whole-shot and point fitting conflicts with fixed Box 1 and Box 2 ownership. | Some current paths may expose visible framing failure until the captured camera is exclusive. |
| **Original live-map lock-frame behaviour** | Allows the lock frame to return to a different camera model. | Existing dependencies on old lock restoration may become visible. |
| **External mapped whole-hole camera as a GPS camera** | Whole-hole live auto-fit competes with the intended Box 1 composition. | Pre-frame may remain unavailable on invalid captures rather than silently showing a generic fit. |
| **Mapped Camera / Green Focus V1 as a combined camera owner** | One system currently combines presets, lock, zoom-button control, and Green Focus. | Green Focus must have an explicit camera request before this combined ownership disappears. |
| **GPS State Stabilizer as a cross-system authority** | It owns or reasserts camera state, Green Focus, Shot End, pairing, and flow that belong to separate systems. | Removing its authority may expose assumptions previously hidden by recurring state reassertion. |
| **GPS Spring Clean Final as a GPS ownership wrapper** | It retains old references, controls Pretend GPS placement, wraps zoom and lock, and repeatedly reasserts ownership. | Input and shell behaviours currently dependent on the wrapper must already have named owners. |
| **GPS Locate/Refresh camera ownership** | Acquiring a position must not also move or replace the captured-frame camera. | Users may no longer see an automatic visual jump after requesting GPS. |
| **External snap-zoom fallback listener** | Places multiple camera systems behind one control. | The control will visibly fail unless Green Zoom or Green Focus has a valid current state. |
| **Old simple live-map Green Zoom** | Box 3 must operate on the captured working surface. | Invalid captured zoom states will become visible rather than masked. |
| **Spring Clean old zoom and old lock fallbacks** | They silently resurrect legacy camera ownership. | Latent failures in the retained V19 path will no longer be hidden. |
| **Captured-camera-to-legacy-camera fallbacks** | A captured-camera failure must not switch camera models invisibly. | More visible failures until manifest and framing problems are corrected. |
| **Duplicate delayed installers, wrappers, guards, and camera intervals** | They make final ownership depend on timing rather than architecture. | Removal before owner selection could leave behaviour temporarily unowned. |
| **Duplicate live-map Green Focus cameras** | Green Focus may request one declared view; it cannot choose among competing camera implementations. | Invalid Green Focus framing will be exposed. |
| **Case-by-case Hole/Ready/Tight frame presets and frame-tightness ownership** | They compete with the three fixed box contracts. | Any useful edge case represented only by those presets must be handled by the fixed-box contract or visibly rejected. |
| **Shared modern-position-to-legacy-green placement bridge** | This is the direct collision that allows Pretend GPS Position to become Two-Tap Shot Builder. | Existing ambiguous “manual” flows may stop rather than continuing into the wrong tool. |
| **Straight-to-green projection when fairway anchoring is required** | It can place an unreachable target away from the mapped fairway and silently change target policy. | A target may be unavailable when fairway truth is missing. That visible failure is intentional. |
| **Generic weak pairing fallback as an automatic Course Data save authority** | It permits stale, cross-hole, reused, implausible, or low-confidence results to be stored. | More shots will be discarded until strict pairing ownership exists. |

## Systems Requiring Investigation

| System | Question To Resolve |
|---|---|
| **Box 1 dual-anchor transform** | What single deterministic composition places the green in the inner green box while placing the tee near the lower tee box? |
| **V20 tee-guide omission** | What is the authoritative Box 1 tee geometry, and who owns its contract for all viewport sizes? |
| **Captured scan trust semantics** | What exactly does an untrusted captured manifest mean, and may it be used in GPS Play at all? |
| **Green-truth selection** | Can a mutable shot target ever outrank the confirmed mapped green centre, shape, boundary, or scaling? The architectural answer should normally be no. |
| **Box 2 subject selection** | Which GPS Play state explicitly chooses whether Box 2 frames the green or the Bubble? |
| **Local fairway orientation** | What local route segment should determine camera orientation at the player’s current position, especially on doglegs? |
| **On-demand live capture rebuild** | Is this an explicit mapping/recovery workflow, or should a missing manifest produce visible failure during GPS Play? |
| **Capture size and tile policy** | What capture policy gives sufficient detail without relying on an oversized, low-confidence full-hole image? |
| **Outside-captured-frame extension** | What deliberate extension state handles a player outside the frame without silently switching to the live map? |
| **Standard target-placement owner** | Which existing normal GPS placement path is closest to the green-truth-first and fairway-anchored contract? No current path should be presumed correct. |
| **Head-to-Tee status** | Does it remain a deliberately invoked separate workflow, or does it duplicate normal GPS starting behaviour without sufficient value? |
| **Strict shot/Bubble identity** | What proves that a Shot End result belongs to the exact previously held Bubble state? |
| **Course Data acceptance gates** | What same-hole, unique-result, expiry, confidence, GPS-accuracy, and plausibility conditions are mandatory before saving? |
| **Runtime ownership ordering** | Does device/browser event ordering reveal additional active owners beyond those established by the static audit? |

The audit is static; runtime ordering, device behaviour, and live GPS accuracy remain unconfirmed and therefore cannot be used to declare any competing system safe.

## Ownership Conflicts

| Behaviour | Current Competing Owners | Required Owner |
|---|---|---|
| **Pre-frame** | V20, V19, original live-map framing, mapped whole-hole framing, Mapped Camera presets, State Stabilizer | V19 captured camera core, governed by the V20 Box 1 contract |
| **Lock frame** | V19, original lock system, Mapped Camera, State Stabilizer, Spring Clean fallback | V19 captured camera core with frozen Box 2 ownership |
| **Green Zoom** | V19 target zoom, V19 long-press zoom, original simple zoom, Mapped Camera snap zoom, Spring Clean wrapper, external zoom listener | Isolated Green Zoom intent; V19 camera performs the Box 3 view |
| **Green Focus view** | Mapped Camera / Green Focus V1, State Stabilizer, live-map focus fallback, shared zoom controls | Green Focus workflow requests a view; V19 remains the camera owner |
| **GPS recenter** | GPS Locate/Refresh, original live-map camera, State Stabilizer, captured-camera restore paths | GPS Position owns coordinates; V19 alone owns any camera response |
| **Hole working surface** | Auto Course Mapper capture, Captured Surface Model, on-demand live rebuild, live map | Captured Surface registry owns the accepted frame identity |
| **Pretend standing position** | Pretend GPS Position, Legacy Two-Tap first tap, shared placement state, Spring Clean, Head-to-Tee | Pretend GPS Position only |
| **Legacy manual shot construction** | Legacy Two-Tap, shared standing-position state, normal GPS map handlers | Isolated Two-Tap Shot Builder only |
| **Initial Bubble/target placement** | Standard GPS target, Head-to-Tee, mapped assist, Two-Tap, reset/new-hole, drag/long-press, Green Focus endpoint placement | One normal GPS Target Placement Policy; isolated tools remain outside it |
| **Unreachable-green anchoring** | Mapped route sampler, tee-proximity gate, direct-to-green projection, Head-to-Tee projection | GPS Target Placement Policy using fairway route and Bag range |
| **Camera orientation** | V19 whole-route axis, original fairway orientation, external mapped camera, local fairway logic | Fairway geometry supplies the local axis; V19 consumes it |
| **Green truth** | Confirmed mapped green, mutable current target, capture completeness rules, tee/fairway-derived choices | Course Map green truth, in the Truth File priority order |
| **Shot-plan identity** | Held Bubble state, Shot End-created plan, generic pending-shot pairer | Course Data Collection’s immutable prior-held-shot identity |
| **Save/no-save decision** | Course Data Collection, State Stabilizer, Green Focus, generic shot-event engine | Course Data Collection only |
| **Next-hole progression** | GPS Play, State Stabilizer, Green Focus | GPS Play only |
| **Zoom control intent** | V19, Mapped Camera, Spring Clean, external listener | The currently explicit workflow: Green Zoom or Green Focus, never both |
| **Runtime restoration/reinstallation** | V19 delayed installation, V20 repeated installation, Mapped Camera interval, State Stabilizer interval, Spring Clean guard | No recurring ownership contest; each owner remains stable until an explicit state transition |

## Camera Ownership Model

The framed-box model is protected: Box 1 is the predictable pre-frame, Box 2 is the target-decision frame, and Box 3 is visual-only Green Zoom.

| Behaviour | Owner |
|---|---|
| **Pre-frame** | **V19 captured camera core**, governed by the **V20 Box 1 contract**. Captured green truth is primary; tee is a secondary composition anchor. |
| **Lock frame** | **V19 captured camera core**, using its frozen lock behaviour and the **V20 Box 2 contract**. GPS origin visibility is not a requirement. |
| **Green Zoom** | **Isolated Green Zoom mode** owns the visual intent. **V19 captured camera core** owns the actual Box 3 camera transform and return. |
| **GPS Recenter** | **GPS Position Acquisition** owns coordinate refresh. **V19 captured camera core** is the only system allowed to alter the camera. Normal position refresh causes no automatic reframing; an explicit recenter may only reapply the current captured-frame state. |
| **Green Focus** | **Green Focus workflow** owns arrival/outcome state. **V19** owns its camera presentation, **Course Data Collection** owns saving, and **GPS Play** owns next-hole progression. |

V20 defines boxes; it does not move the camera. V19 moves the captured surface; it does not create course truth, decide Course Data eligibility, or own GPS round flow.

## Legacy Two-Tap Separation Plan

Legacy Two-Tap becomes a separate manual tool with a completely independent lifecycle:

**Entry:** It is deliberately opened as **Two-Tap Shot Builder**, never entered through Pretend GPS Position, GPS Locate, Head-to-Tee, Green Focus, or a normal GPS map tap.

**State:** Its first tap is a private manual start point and its second tap is a private manual green point. Neither tap changes the active GPS player position, mapped green truth, normal shot lock, or current GPS hole state.

**Output:** It produces a self-contained manually built shot. It does not silently publish that result into normal GPS Play or Course Data Collection.

**Exit:** Closing or completing Two-Tap ends its session. No “start,” “green,” “manual,” or pending placement state survives into GPS Play.

**Failure:** If its required state is unavailable, the tool visibly fails. It never falls into Pretend GPS, normal GPS placement, or an older camera path.

**Naming:** Only the explicit names **Two-Tap Shot Builder**, **Pretend GPS Position**, and **GPS Override Tap** should describe these behaviours. Ambiguous shared “manual” or “tap” ownership is not acceptable.

The Truth File explicitly defines Two-Tap and Pretend GPS as different systems and prohibits hidden fallback between old and replacement systems.

## Fairway-Line Ownership

**Course Map / Auto Course Mapper owns the fairway geometry.**

**GPS Target Placement Policy owns the decision derived from that geometry.** It determines whether the green is reachable using current position and max Bag range. When unreachable, it selects the reachable fairway anchor. It is the only owner of normal GPS target anchoring.

**The V19 camera owns presentation, not route interpretation.** It receives the local fairway direction from the target policy and uses that direction for orientation.

**GPS Play owns when a target is requested.** Head-to-Tee may provide an explicit starting context, but it cannot own a second lay-up algorithm.

Green truth remains ahead of fairway and tee truth. Fairway direction becomes authoritative only for its two assigned jobs: local camera orientation and unreachable-green Bubble anchoring. Tee proximity must not decide whether fairway anchoring applies.

When the green is unreachable and valid fairway truth is unavailable, normal GPS target placement must visibly report that it cannot establish a safe anchor. It must not project directly toward the green.

## Hole Frame Ownership

The ownership chain after capture should be:

1. **Auto Course Mapper** owns creation of the initial hole frame and its geomarked objects.
2. **Captured Surface Model / Course Map registry** owns the saved frame identity, course/hole association, provenance, and validation.
3. **GPS Play** selects and consumes the accepted frame for the active hole.
4. **V19 captured camera core** owns how that existing frame is translated, rotated, and scaled into Boxes 1–3.
5. **V20** owns only the screen-box geometry contract.

After a hole frame is accepted, it remains the working surface for that active GPS session. GPS Play cannot silently recreate it, reinterpret it from current live bounds, or allow a GPS refresh to replace it.

A missing, invalid, or untrusted frame produces a visible unavailable state. A replacement capture must occur through an explicit mapping/capture workflow owned by Auto Course Mapper—not as an invisible GPS camera recovery.

Auto Course Mapper owns the initial snapshot and geomarked objects but must not continuously remap or own GPS Play behaviour.

## Recommended Patch Order

The sequence below orders ownership transitions, not implementation mechanics.

### Patch 1 — Ownership Quarantine

Establish hard boundaries around Legacy Two-Tap, Pretend GPS Position, Head-to-Tee, Green Zoom, Green Focus, Course Data Collection, and live map.

End all shared state transitions between these systems. Assign GPS Play ownership of round flow and Course Data Collection ownership of save/no-save. Any unowned or invalid transition becomes visibly unavailable.

### Patch 2 — Exclusive Framed-Box Camera

Make the V19 captured camera core the sole GPS camera mover, with V20 as the sole box contract and Captured Surface Model as the sole frame source.

Resolve Box 1, green-truth priority, Box 2 subject selection, and local fairway orientation before removing the competing camera owners. Then remove live-map framing, camera fallbacks, GPS-triggered recentering, duplicate zoom cameras, wrappers, intervals, and ownership reinstallation.

### Patch 3 — Target and Course Data Integrity

Give normal GPS target placement exclusive ownership of fairway-line anchoring. Remove direct-to-green fallback when the green is unreachable.

Complete the Course Data boundary so only a valid, prior held-Bubble identity can pair with Shot End. Enforce same-hole, unique-result, expiry, confidence, GPS-quality, and plausibility requirements before any save. Finish with runtime/device ownership verification.
