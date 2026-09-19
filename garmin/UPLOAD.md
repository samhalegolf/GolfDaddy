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

**It has never run.** Nothing has been in the simulator or on a wrist.
Compiling is not running, and the items still listed as unverified in
`README.md` — the touch-drag event shape, `WatchUi.KEY_LAP`,
`Position.Info.accuracy` — are precisely the kind that compile clean and
misbehave on a device.

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

---

## 5. Before you package — the things that are still placeholders

- [ ] **Launcher icon.** `resources/drawables/launcher_icon.png` is a 40×40
      solid-colour placeholder. Replace it with the real Clarity Caddy mark —
      and note the sizes differ per device, so one bitmap is not enough:
      Approach S62 35×35, S70 42mm 60×60, S70 47mm 70×70, fenix 6 40×40,
      Forerunner 55 35×35.
- [ ] **Bubble Engine parity fixtures.** `dev/fixtures/bubble-engine-parity.json`
      is the project's own stated completion bar for the engine and has never
      been run against the Monkey C port. Tolerances: 0.1 m, 0.01°, 1e-7 coord.
- [x] ~~**Per-hole map URLs.**~~ Done 2026-09-19 —
      `app/js/watch-map-delivery.js` attaches an absolute `url` per hole and
      the asset endpoint is public, unsigned and immutable. See README.
- [ ] **The Connect IQ Mobile SDK is not bundled in either phone build**, so
      the phone cannot talk to a watch at all: no `.xcframework` on iOS, no
      Maven coordinate on Android, and every SDK call in both
      `GarminTransport`s is still commented out and written from inference.
      Nothing below matters until this is done.

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
