# Future Work — Lock Screen Round Controls

## Status

**Future work only. Do not implement while the current Clarity Caddy iOS build is under App Store review.**

This feature changes background-location behaviour and introduces a Live Activity / Lock Screen interaction, so it should be developed as a later release after the currently reviewed build is approved.

## Goal

Provide a deliberately minimal Lock Screen surface during an active Clarity Caddy round.

Initial UI:

```text
CLARITY CADDY        HOLE 7

[ LOCK IN ]        [ LOG SHOT ]
```

Do not reproduce GPS Play on the Lock Screen. No map, Bubble, wind, club selection, score, or continuously displayed distance is required for the first version.

## Required behaviour

### Hole number

Show the current hole from the active round and update it when the golfer advances holes.

### Lock In

`LOCK IN` is a navigation action.

When tapped:

1. Open Clarity Caddy.
2. Resume the current round without reloading the webview unnecessarily.
3. Go directly to the existing Lock In state for the current hole.
4. Request/validate a fresh accurate GPS location as the app opens.

This should reuse the existing Lock In behaviour rather than creating a second native implementation of shot lock-in.

### Log Shot

`LOG SHOT` is a background action and should not visibly open the app.

When tapped:

1. Native iOS code obtains or validates a fresh golf-quality GPS location.
2. Record the shot-end coordinate against the current round/current shot.
3. Persist enough state for the existing Caddy round to reconcile the logged outcome when the web app is next active.
4. Update the Live Activity to acknowledge that the shot was logged.
5. Remain on the Lock Screen.

Do not depend on the JavaScript/webview being awake to obtain the coordinate or persist the immediate shot-end action.

## Location / battery strategy

Avoid continuous high-accuracy GPS.

The intended behaviour is event-driven:

```text
Golfer moving
    ↓
Low-cost location awareness
    ↓
Golfer becomes stationary
    ↓
Request one fresher/more accurate location
    ↓
Keep that useful fix cached
    ↓
No repeated high-accuracy calls while stationary
```

A golfer stopping is particularly meaningful in golf because they are likely to have reached their ball and may soon check Caddy.

When `LOCK IN` or `LOG SHOT` is used, validate whether the cached fix is sufficiently recent and accurate. If it is not, temporarily request a better fix before performing the action.

Suggested starting acceptance logic for testing, not a final product constant:

- recent fix: approximately 5–10 seconds old
- useful horizontal accuracy: approximately 15 m or better
- stationary refresh anti-repeat window: approximately 30 seconds

These values must be tuned from real on-course battery and GPS testing.

Investigate Apple's modern Core Location live-update APIs first. If Core Location's stationary state is sufficient, avoid adding a separate Core Motion activity classifier solely for stationary detection. Add Core Motion only if real golf testing shows it is necessary.

## Native architecture

Keep the native layer narrow.

```text
Existing Caddy round / GPS Play
        ↕
Native round bridge
        ↓
RoundLocationService
        ↓
Core Location
        ↓
Shared active-round snapshot
        ↓
Live Activity / App Intent
```

### Likely native files

- `RoundLocationService.swift`
- `SharedRoundState.swift`
- `CaddyRoundPlugin.swift` or equivalent Capacitor bridge
- `CaddyRoundAttributes.swift`
- `CaddyLiveActivity.swift`
- `LogShotIntent.swift`
- `CaddyLiveActivityWidget.swift`

### Likely web changes

Add a navigation-intent router separate from the existing authentication/deep-link reload path, for example:

- `gd-native-intents.js`

Then add small hooks to the existing round state for:

- round start
- round resume
- hole change
- active shot change
- round end

Native code only needs the minimum active-round snapshot, such as:

- round ID
- hole number
- active shot ID
- latest useful coordinate
- coordinate accuracy/timestamp

Do **not** duplicate the full round model in Swift.

## Deep linking / intent routing

Add an internal URL scheme such as:

`claritycaddy://`

Use it for navigation actions such as:

`claritycaddy://round/lock-in`

Navigation intents must be handled separately from boot-critical authentication URLs. Do not send round navigation through an auth path that calls `location.reload()`.

The desired path is:

```text
Lock Screen
→ native shell
→ existing running Caddy state
→ current round / Lock In
```

not:

```text
Lock Screen
→ reload entire web app
→ reconstruct round
```

Universal Links can be added separately/later; they are not required to prove the Lock Screen feature.

## Xcode work

Expected work includes:

- Widget Extension target
- Live Activity support
- shared App Group on the main app and extension
- background location capability for active rounds
- appropriate location usage descriptions
- internal `claritycaddy://` URL scheme
- shared `ActivityAttributes` type available to the required targets
- native Capacitor bridge for active-round state
- App Intent for background `LOG SHOT`

Background location must only be active when justified by an active golf round and should be stopped when the round ends.

## Possible later enhancement — Place Shot Outcome

After `LOG SHOT`, Caddy may expose a deliberate route into the existing Green Focus / Place Shot Outcome interface for golfers who want to correct/refine the automatically captured GPS outcome.

Do not make this mandatory for every shot. The normal flow should remain:

```text
LOG SHOT
→ GPS outcome captured
→ done
```

A precision flow can later be:

```text
LOG SHOT
→ shot logged acknowledgement
→ user chooses to refine outcome
→ open Caddy directly in Green Focus / Place Shot Outcome
```

Do not rely on a custom long-press interaction on the Live Activity unless supported behaviour has been verified for the deployment target.

## Architectural rule

**Do not recreate GPS Play in Swift.**

Native iOS owns only:

- efficient background location support during an active round
- the small shared active-round snapshot
- Live Activity presentation
- Lock Screen action plumbing
- the immediate native GPS capture required for `LOG SHOT`

The existing Caddy JavaScript remains authoritative for the round, GPS Play UI, Lock In behaviour, Green Focus, Bubble behaviour, and normal shot/course-data workflows.

## Release note

Do not merge this implementation into the App Store submission currently under review. Build and test it as a subsequent release because it materially changes the app's use of background location and Lock Screen capabilities.
