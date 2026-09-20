# Clarity Caddy — Garmin build & store upload runbook

Everything Garmin's portal accepts is a **signed `.iq` file**, produced locally
by the Connect IQ compiler. There is no cloud build. This is the whole path
from a clean Mac to an upload.

---

## 0. Reality check

**It compiles.** As of 2026-09-19 all five products in `manifest.xml` build
clean and `./build.sh package` produces a signed `.iq`. The nine errors the
first compile found are fixed (see the git history for what they were; one,
`Math.log` missing its base, was a real Web Mercator bug rather than a
compiler complaint).

**It runs in the simulator, and the phone can drive it.** As of 2026-09-20 the
Approach S62 build launches clean, shows the "Waiting for round" face, and a
Scene published from the Android debug build over the adb tether (section 4)
lands on it and moves it to "Ready - press SELECT". Nothing has been on a
wrist yet, and the items still listed as unverified in `README.md` — the
touch-drag event shape, `WatchUi.KEY_LAP`, `Position.Info.accuracy` — are
precisely the kind that compile clean and misbehave on a device.

**The watch → phone direction cannot be tested in the simulator on this Mac.**
See the warning in section 4. Every command the watch sends (TAKE_OVER, LOCK,
the inventory reports) is unverified until a real watch is in hand.

There is no system Java on this Mac; `monkeyc` is a Java launcher, so every
build needs a JDK on PATH first. Android Studio's bundled one works:

```bash
export PATH="/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin:$PATH"
```

---

## 1. Install the SDK

1. Sign in at <https://developer.garmin.com/connect-iq/sdk/> and download the
   **Connect IQ SDK Manager** for macOS.
2. Open it, sign in with the same Garmin account, install the **latest stable
   SDK** (not a beta).
3. In the SDK Manager's **Devices** tab, download every device this app
   targets:

   - Approach S62
   - Approach S70 (42mm)
   - Approach S70 (47mm)
   - fenix 6
   - Forerunner 55

   The compiler hard-fails on a product id it has no downloaded device
   definition for — this is the single most common first-build failure.

Optional but much easier: install the **Monkey C** extension for VS Code. It
wraps the same compiler with a build/run/debug UI and a device picker.

---

## 2. Verify the setup

```bash
cd garmin
./build.sh check
```

Prints the SDK path, whether your developer key exists, and an `ok` /
`MISSING` line per device in `manifest.xml`. Fix any `MISSING` in the SDK
Manager before going further.

---

## 3. Developer key

`./build.sh` generates one automatically on first `build` or `package`, at
`~/.garmin/clarity_caddy_developer_key` (4096-bit RSA, PKCS#8 DER — the format
Connect IQ requires).

**Back this file up somewhere you will still have it in three years.** Garmin
binds the published listing to the key that signed it. Lose it and you cannot
ship an update to the same store entry — you would have to publish a new app
and lose your installs and reviews. Treat it like a signing certificate,
because that is what it is. It is git-ignored by living outside the repo.

If you already have a key you use for other Garmin apps, point at it instead:

```bash
CIQ_KEY=/path/to/existing_key ./build.sh package
```

---

## 4. Compile and fix

```bash
./build.sh build                      # defaults to approachs62
CIQ_DEVICE=fr55 ./build.sh build      # smallest screen — good stress test
```

This should be clean. If it is not, the README's "Known unverified items"
list is where new errors are most likely to cluster: the touch-event API
shape in `CaddyInputDelegate.onTouch`, `Position.Info.accuracy`, and
`WatchUi.KEY_LAP`.

Then run it in the simulator:

```bash
"$(dirname "$(command -v monkeyc)")/connectiq" &          # launch simulator
"$(dirname "$(command -v monkeyc)")/monkeydo" build/ClarityCaddy-approachs62.prg approachs62
```

Do not skip the simulator. The store review will reject an app that crashes on
launch, and a device you have not visually checked will have layout problems on
its own screen shape.

### Phone and watch together, no hardware (Android only)

The Connect IQ Mobile SDK on Android has a tethered mode that talks to the
desktop simulator over adb. iOS has no equivalent: the iOS SDK only reaches a
real watch through the real Garmin Connect app, so an end-to-end iOS check
needs an iPhone and a watch in hand.

1. Build and launch the watch app in the simulator as above.
2. Forward the simulator's port to the phone or emulator running the Android
   build:

   ```bash
   adb forward tcp:7381 tcp:7381
   ```

3. Build the Android app with the tethered flag (debug only; release ignores
   it):

   ```bash
   cd android && ./gradlew installDebug -PgarminTethered=true
   ```

   Or set `garminTethered=true` in `~/.gradle/gradle.properties` while you are
   working this way, so Android Studio's normal Run picks it up.

Then, in the simulator, **adb Connection > Start**. Settings > Garmin Watch
on the phone lists a single device called "Simulator". Select it and the
phone app's messages land in the simulator's running watch app. Garmin
Connect Mobile is not involved at all in this mode.

Verified 2026-09-20: `publishScene` from the phone reaches the watch and
changes its face. The phone side can be driven without tapping through the
UI — the debug WebView is inspectable over
`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`, and a
DevTools `Runtime.evaluate` of `Capacitor.Plugins.NativeRoundBridge.garminDevices()`
/ `selectGarminDevice(...)` / `publishScene({scene})` does the whole flow.

> **Known simulator bug — watch → phone crashes the simulator.** On macOS
> 26.6 (Apple Silicon) with Connect IQ SDK 9.2.0 *and* 9.1.0, any
> `Communications.transmit` from the watch app while the adb tether is live
> segfaults the simulator process (SIGSEGV on its "TVM main" thread, same
> fault address every time; reports land in
> `~/Library/Logs/DiagnosticReports/simulator-*.ips`). This is not our
> payload: it reproduces with a one-key `{"ping"=>1}` dictionary and with
> Garmin's own `samples/Comm` sending a plain string, and it reproduces with
> no device registered on the phone. launchd relaunches the simulator empty
> afterwards, which is where the "There is no data connection" dialog comes
> from. Untethered, the same transmits are silent no-ops, so the watch app
> itself is fine.
>
> Also tried and also crashing, identically: simulator 8.4.1, and the phone
> built against companion SDK 2.2.0 instead of 2.4.0. So it is not a recent
> simulator regression and not the phone SDK's wire format. The common
> factor left is this machine (macOS 26.6.2, M4).
>
> Consequence: commands from the watch (TAKE_OVER, LOCK, AIM_AT, the
> inventory reports) and the phone's `onMessageReceived` path in
> `GarminTransport.java` can only be verified on a real watch, or on a
> different Mac / an older macOS. Note the phone-side knock-on: the watch's
> reply kills the simulator, the phone sees the watch drop, and the
> "Play on Watch" card hides — so the card never shows in this setup even
> though it renders fine (proved by forcing
> `ClarityApp.caddyWatch.setWatchState({paired:true, appInstalled:true, reachable:true})`
> in the WebView). Also, once the watch is gone mid-round the phone retries
> the Scene once a second and logs `Garmin send failed: FAILURE_UNKNOWN`
> each time; harmless, but worth rate-limiting.

### Seeing the round on the simulated watch anyway: the muted build

The phone → watch direction is fine, so a watch build that never replies
lets the whole phone-side flow be watched landing on the simulator: the face
changes, the hole numbers, the map, the Bubble. Only the watch's own
commands are missing, and the phone can stand in for them.

```bash
cd garmin && CIQ_MUTE_TX=1 ./build.sh build     # writes build/ClarityCaddy-<device>-muted.prg
```

`monkeydo` that file instead of the plain one, then **adb Connection >
Start** as above. The muted build logs every dropped reply to the
simulator console (`transmit muted: [...]`), starts with an empty command
queue so a SELECT from a previous run cannot wedge it on "Taking over...",
and traces each Scene it receives (`rx: [scene] rev N ...`). It is compiled
from the same sources via an annotation swap (`GarminTransmitPolicy.mc`,
`monkey-sim-mute.jungle`); `./build.sh package` never reads the flag.

To reach the playing faces, hand the round over from the phone side, since
the watch's TAKE_OVER never leaves. Over the debug WebView (port 9222):

```js
var w = ClarityApp.caddyWatch, s = w.scene();
w.receiveCommand({ commandId: "sim-" + Date.now(), roundId: s.roundId, baseRevision: s.revision, type: "TAKE_OVER", payload: {} });
```

Two more things learned this way (2026-09-20), both fixed in
`GarminTransport.java`:

- The Connect IQ link is a queue, not latest-wins, and it reports SUCCESS
  on enqueue. The phone republishes the Scene on every GPS fix, the tether
  drains one message per ~3 s, and the wrist fell minutes behind. Scenes
  are now coalesced on the phone: newest waiting, at most one every 3 s,
  sent from a background thread (the tethered SDK writes to its socket on
  the calling thread, and the main thread is not allowed to).
- The simulator keeps its own inbox across phone restarts. If the wrist is
  showing stale revisions after a phone rebuild, quit and relaunch the
  simulator (`connectiq`), then `monkeydo` again.

And three more about hole maps on the simulated watch (2026-09-21):

- **The manifest must be small.** Millbrook's 18-hole manifest was 27 KB
  with each hole's full `reference` block and the link refused it outright
  (`FAILURE_MESSAGE_TOO_LARGE`), so the wrist never saw a hole. The Android
  transport now sends only the green coordinate out of `reference`, which
  is all `GarminMapManifest.mc` reads; the result is under 10 KB.
- **Image fetches need a Garmin login in the simulator.** `makeImageRequest`
  goes through Garmin's image service even in the simulator, and the first
  request raises a Garmin Connect sign-in prompt (plus a "Reading password
  ... failed" error if the keychain entry is missing). Until you sign in,
  the map face sits on "Loading map..." and the simulator's menus are
  disabled behind the dialog.
- **WebP is refused, JPEG works.** The same URL came back 400 as the stored
  WebP and 200 as PNG. The Garmin URL therefore asks the asset endpoint for
  `format=jpeg` (`functions/course-watch-map-assets.mjs` re-encodes with
  sharp; ~29 KB per hole against 15 KB of WebP), and the phone builds the
  URL with literal slashes because Connect IQ re-encodes it. The muted
  build prints `image request` / `image response: code N` lines for each
  fetch, and `manifest in: ...` for each manifest it adopts.

Every simulator relaunch needs **adb Connection > Start** again, and so
does every phone-app restart (the simulator's link dies with the phone's
socket even though `lsof` may still show it).

---

## 5. Before you package — the things that are still placeholders

- [x] ~~**Launcher icon.**~~ Done 2026-09-19. The 105-byte solid-colour
      placeholder is gone; the real Clarity Caddy pin now ships at each
      device's own size out of `resources-icons/<size>/`, selected per product
      in `monkey.jungle`. Guarded by `npm run test:garmin`.

      Worth knowing if you ever redraw it: at 35×35 (Approach S62, Forerunner
      55) the G's counter closes up and the golf ball reads as a plain dot.
      The pin silhouette still carries it, but a hand-simplified mark for the
      two small sizes would read better than the downscale does.
- [ ] **Bubble Engine parity fixtures.** `dev/fixtures/bubble-engine-parity.json`
      is the project's own stated completion bar for the engine and has never
      been run against the Monkey C port. Tolerances: 0.1 m, 0.01°, 1e-7 coord.
- [x] ~~**Per-hole map URLs.**~~ Done 2026-09-19 —
      `app/js/watch-map-delivery.js` attaches an absolute `url` per hole and
      the asset endpoint is public, unsigned and immutable. See README.
- [x] ~~**The Connect IQ Mobile SDK is not bundled in either phone build.**~~
      Done 2026-09-20. Neither is a portal download:

        iOS      Swift package `garmin/connectiq-companion-app-sdk-ios`,
                 pinned at 1.8.0 in App.xcodeproj (Garmin's own licence, not
                 Apache — worth reading before shipping).
        Android  Maven Central `com.garmin.connectiq:ciq-companion-app-sdk:2.4.0`.
                 NOT the 2.2.0 that SDK's README prints; that README is stale.

      Both `GarminTransport`s are now written against the real APIs, read
      from the xcframework headers and the AAR respectively rather than from
      documentation. **Neither has yet run against a watch.**

- [ ] **Nothing has been tested against real hardware.** The Android side
      can be exercised against the simulator (tethered mode, section 4)
      before a watch arrives; iOS cannot. The two device flows also differ:
      Android lists paired watches in-process (`getKnownDevices`), iOS hands
      off to the Garmin Connect app and is called back on the
      `claritycaddy-ciq` URL scheme. The hand-off in particular has several
      silent failure modes — a missing `LSApplicationQueriesSchemes` entry,
      a scheme that does not match Info.plist, Garmin Connect not signed in.

---

## 6. Package

```bash
./build.sh package
```

Builds `--release --package-app` across every product in `manifest.xml` and
writes **`garmin/build/ClarityCaddy.iq`**. That single file is what you upload.

---

## 7. Upload

Go to <https://apps.garmin.com/developer/dashboard>, create the app, and upload
`ClarityCaddy.iq`.

The portal asks for store assets alongside the binary — have these ready:

| Asset | Notes |
| --- | --- |
| App name | "Clarity Caddy" |
| Short + long description | Long description is the main store copy |
| App icon | Separate from the launcher icon; store-sized artwork |
| Screenshots | Simulator captures are accepted; one per screen shape you support |
| Category | Golf |
| Privacy policy URL | You already host one — `privacy.html` |
| Support / contact | Required |

Two things that commonly stall a first Garmin review:

- **Permission justification.** You request `Positioning` and `Communications`.
  The description should make it obvious why a golf app needs GPS and a phone
  link, or a reviewer will ask.
- **Companion app dependency.** This app is useless without the Clarity Caddy
  phone app driving it. Say so plainly in the store description — a reviewer
  who opens it with no phone paired sees the "no round" screen and may read it
  as broken.

Review typically takes a few days. Rejections come back by email with a reason.

---

## Command reference

| Command | Does |
| --- | --- |
| `./build.sh check` | SDK, key and device readiness — builds nothing |
| `./build.sh build` | Debug `.prg` for one device (`CIQ_DEVICE=` to pick) |
| `./build.sh package` | Signed release `.iq` for store upload |

| Env var | Default |
| --- | --- |
| `CIQ_SDK` | auto-detected from PATH or the SDK Manager's `current-sdk.cfg` |
| `CIQ_KEY` | `~/.garmin/clarity_caddy_developer_key` |
| `CIQ_DEVICE` | `approachs62` |
