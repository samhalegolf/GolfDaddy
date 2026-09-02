# Clarity Caddy — Garmin build & store upload runbook

Everything Garmin's portal accepts is a **signed `.iq` file**, produced locally
by the Connect IQ compiler. There is no cloud build. This is the whole path
from a clean Mac to an upload.

---

## 0. Reality check

The Monkey C source in `garmin/source/` has **never been compiled**. Expect the
first `./build.sh build` to produce a list of compiler errors — that is the
normal state of a 4,150-line port written without an SDK, not a sign anything
is wrong. Fix them, then continue. Steps 1–4 below get you to that point.

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

Work through the compiler output. The README's "Known unverified items" list
is where the errors are most likely to cluster: the touch-event API shape in
`CaddyInputDelegate.onTouch`, `Position.Info.accuracy`, the
`makeImageRequestWithDictionary` callback signature, and `WatchUi.KEY_LAP`.

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
      solid-colour placeholder. Replace it with the real Clarity Caddy mark.
- [ ] **Bubble Engine parity fixtures.** `dev/fixtures/bubble-engine-parity.json`
      is the project's own stated completion bar for the engine and has never
      been run against the Monkey C port. Tolerances: 0.1 m, 0.01°, 1e-7 coord.
- [ ] **Per-hole map URLs.** The Garmin map path fetches hole rasters by URL
      rather than receiving pushed bytes (see README). If `course_watch_maps`
      serves short-lived signed URLs, the phone-side manifest for Garmin needs
      URLs that outlive the fetch. This is unresolved phone-side work.

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
