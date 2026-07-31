# Mobile app architecture — handover for a fresh build

Written 2026-07-31, after a day of fixing the current GPS play surface. The fixes
worked, but each one uncovered another instance of the same few mistakes. This
describes the architecture the app **should** have, states the facts a new build
needs, and records what not to carry across.

Everything below was verified against the live database and a real device on the
date above. Where something is unverified, it says so.

---

## 1. The model, in one paragraph

The mobile app is a **pure consumer**. The server produces two things: course
**objects** (geometry — tee, green, fairway, route) and, optionally, a **playing
surface** (a flattened per-hole image). The app draws objects on a live map. If a
playing surface exists for the hole it uses that instead. It never captures, never
composites tiles, never flattens, and never writes anything back. Authoring belongs
to the studio and the server worker.

That is the whole contract. Almost every bug fixed on 2026-07-31 was a violation of
it.

---

## 2. What the server provides

### 2.1 Objects — `course_maps`

One row per course. `published = true` means it is usable.

| column | meaning |
| --- | --- |
| `course_id` | canonical key, e.g. `akarana-golf-club` |
| `objects_json` | object, the course geometry |
| `holes_json` | object, per-hole records |
| `hole_count` | 18 |
| `published`, `published_at` | publication state |

Akarana: 60 objects, 18 holes, published. **Play-ready is judged from here, never
from localStorage.**

### 2.2 Playing surface — `course_visuals`

One row per course, `status = 'published'`. The per-hole surfaces live in
`uploaded_assets`, an array of ~19 entries (18 holes plus a course-level entry).

Each hole asset has `path`, `role`, `contentType`, `holeNumber`, and
`metadata.playSurface`:

```jsonc
{
  "model": "mercator-image",
  "projection": "mercator-image",
  "captureZoom": 18,                    // integer — see rule 6
  "originPx": { "x": 66127679, "y": 40967315 },
  "outputDimensions": { "width": 1341, "height": 1889 },
  "sourceBounds": { "north": …, "south": …, "east": …, "west": … },
  "anchorPins": {
    "tee":   { "lat": …, "lng": … },
    "green": { "lat": …, "lng": … },
    "route": [ …4 points… ],
    "greenShape": [ …16 points… ]
  },
  "fallbackPolicy": "live-gps-only",    // the server states the fallback
  "fallbackUnderlay": "live-gps",
  "useGpsPlayFraming": true
}
```

Two things worth noticing, because the current app misses both:

- **The objects needed to frame the hole are inside the asset** (`anchorPins`). The
  app does not have to reconcile two sources to draw or frame a hole.
- **The server already declares the fallback.** `fallbackPolicy: "live-gps-only"`
  means: no surface → live map. The app should honour that field rather than
  inventing its own policy.

As of writing, all 8 published courses have 18 hole assets with `playSurface`.

### 2.3 `captured_surfaces` — legacy, now empty

505 rows deleted 2026-07-31, backed up to `captured_surfaces_backup_20260731`.

These were per-hole **tile manifests** — lists of third-party tile URLs — produced
by a client-side shutter that no longer exists. They are not a playing surface.
**A new app must never read or write this table.** If rows reappear, something is
authoring again.

---

## 3. What the app does

1. Resolve the course to its **canonical key** (rule 1).
2. Load objects from the course package.
3. Enter play with the **live map visible**, framed on the hole using the objects.
4. Ask for a published surface for the hole. If one exists, present it and hide the
   map. If not, stay on the map. That is a normal outcome, not an error.
5. Never write. No scans, no manifests, no uploads.

There is no third state. No "preparing" blackout, no "unavailable" screen, no local
capture fallback.

---

## 4. Hard rules

Each of these was learned by breaking it. The evidence is given so a future session
can tell the difference between a rule and a preference.

### Rule 1 — one canonical course key, everywhere

`lowercase → non-alphanumerics to hyphen → trim hyphens`, i.e.
`"Akarana Golf Club"` → `akarana-golf-club`.

Anything that derives a storage key or does a lookup must normalise first, on both
the write and the read path.

> **Evidence.** `surfaceCourseKey()` fell back to a display name and the key builder
> preserved case, producing `Akarana_Golf_Club` while the rest of the app used
> `akarana-golf-club`. The published-visual lookup missed, so **18 published play
> surfaces were invisible** and every hole reported "no frame". Days of symptoms
> traced to one slug. `dev/course-key-normalisation.test.js` already warned about
> this for the sync path; the camera was missed.

### Rule 2 — the live map is the default, the surface is the upgrade

Never hide the map and require something to earn its way on screen.

> **Evidence.** The CSS was `#map { visibility: hidden }` unless a body class granted
> an exception. Every state that was not a fully-loaded surface — loading, prompt
> up, no surface at all — was therefore black, and each new case needed another
> `:not()` exemption. Inverting the default deleted ten selectors and a whole class
> of bug.

### Rule 3 — no polling for state transitions

Route/lifecycle cleanup runs **on the transition**, bounded and cancellable. A
`setInterval` cannot do it correctly.

> **Evidence.** `homeGuardTick` ran every 260ms, read six body classes, and if any
> were set tore down "leftovers" and navigated home. A class on `document.body`
> carries no timing information, so it could not distinguish *leftover from the route
> I left* from *state of the route I am entering*. It deleted the Head To the Tee
> prompt and forced home four times a second — the original "trip home" bug — and the
> repeated `showHome()` work was the freeze. Queued cleanup also needs a token so a
> new flow cancels a pending tick.

### Rule 4 — declaring an absence is a state, not an event

"This hole has no surface" must be idempotent per hole. Independent subsystems will
ask repeatedly.

> **Evidence.** `tool-sync`, `resume-round` and `resume-round-restore` each asked on
> their own schedule; with no surface published, each re-ran the full unavailable
> path — DOM writes, class rewrite, debug event, visibility recompute — ~3.5×/second
> indefinitely.

### Rule 5 — the app authors nothing

> **Evidence.** The app built a manifest **from a published cloud visual**, then
> wrote it back through `gdCapturedSurfaceWriteScan`, which the sync module wrapped
> to push to `captured_surfaces`. It was re-uploading published surfaces as legacy
> tile manifests on every load, refilling the table it could no longer consume.

### Rule 6 — integer `captureZoom`

Cloud frames must use an integer `captureZoom` or GPS play markers drift. Observed
value is `18`.

### Rule 7 — localStorage is a cache, and it is small

iOS WKWebView gives roughly **5MB**. It **survives app updates**, so shipping a fix
does not clean existing devices — a migration must remove bad keys.

> **Evidence.** A device reached 7.3MB / 77 keys, most of it `~300KB` tile manifests
> per hole. iOS evicted to make room and the key it took was
> `gd_gps_resume_round_v1` — the in-progress round. Now 3.0MB.

### Rule 8 — never assign onto a `Storage` object

`localStorage.setItem = fn` does **not** override the method. `Storage` is a WebIDL
legacy platform object with a named-property setter, so the assignment **stores an
entry** whose value is the function's source text. Use `Object.defineProperty`, and
keep flags in module scope, not on `storage`.

> **Evidence.** The durable-storage mirror did this. Chromium also overrode the
> method so all 13 tests passed, while **iOS WebKit did not** — leaving only the
> boot-time seed mirroring. A device was found with its durable copy of the
> in-progress round **over two hours stale**.

### Rule 9 — the test suite is Chromium-only

`dev/*.test.js` launch Chromium (falling back to system Chrome). Native-only
behaviour is invisible to CI. A green suite is not evidence the app works. When a
defect is WebKit-specific, assert on something observable in **both** engines — see
rule 8, where the stray keys were catchable but the failed override was not.

---

## 5. What not to carry across

Do not port any of this into a fresh app:

- **The captured-surface capture/flatten path** — `buildCaptureManifest`,
  `flattenCaptureManifest`, `scheduleCaptureFlatten`, tile compositing. It belongs to
  the studio. The app has no use for it.
- **`captured_surfaces` and its sync module.** Legacy end to end.
- **The legacy manifest key space** `gd_captured_hole_frame_v19_*`.
- **`homeGuardTick` and any body-class watchdog.**
- **The frame-unavailable UI** — "Frame unavailable, remap this hole". Under rule 2
  there is nothing to report; you are on the map.
- **The hole-transition mask as a blocking overlay.** It hid `#map` and could only be
  taken down by a matching manifest, so a hole with no surface hung behind it forever.
  If a loading state is wanted, it must not hide the thing it is waiting to replace.

---

## 6. Diagnostics that work

Hard-won on 2026-07-31; all still available without a debug build.

**Errors and telemetry.** `clarity-error-reporter.js` → `POST /api/client-errors` →
Supabase `client_error_events`. Fingerprint-deduped; a repeat **updates** `detail`,
so a row holds the most recent occurrence. `MAX_DETAIL` is 1200 characters.

> Two traps: `flush()` sets a `reporting` guard and `record()` **drops** anything
> arriving while it is set, so queue every row first and flush **once** — otherwise
> only the first row of each burst survives, silently. And the reporter posts from
> the web build too, so gate device-only diagnostics on `GDNative.isNative`.

**Reading a device without Xcode.** With the phone paired:

```bash
xcrun devicectl list devices
xcrun devicectl device copy from --device <UDID> \
  --domain-type appDataContainer --domain-identifier com.claritygolf.caddy \
  --source "Library/WebKit/WebsiteData/Default/<hash>/<hash>/LocalStorage/localstorage.sqlite3" \
  --destination ./ls.sqlite3
```

Values are **UTF-16LE** — decode, do not `cast as text`. Checkpoint the WAL first.
Capacitor Preferences is UserDefaults at
`Library/Preferences/com.claritygolf.caddy.plist`, keys prefixed `CapacitorStorage.`.
Comparing the two is what exposed the stale mirror in rule 8.

**On-device timeline.** `GDCoursePlayPipeline.recordDebugEvent` keeps the last 50
events in `gd_course_play_debug_timeline_v1`. It is never uploaded. It is the best
forensic record on a device — but 50 entries fill fast, so nothing chatty may write
to it.

---

## 7. Build and release

- **Build number is the git commit count**, stamped by `ios/App/stamp-version.sh` as
  an Xcode build phase. Do not hardcode it. `IOS_BUILD_NUMBER` overrides.
- `npm run build:app` → `npx cap sync ios` → archive. `cap sync` alone ships stale
  assets.
- CI (`.github/workflows/structural-smoke.yml`) is an **explicit list**; a new test
  file that is not added there never runs. 21 of 101 files were unregistered.
- The surface split is real: `data-gd-surface="app"` / `"studio"` in `index.html`,
  and `dist/index.html` at site root is the **app** surface.

---

## 8. State as of 2026-07-31

Build **541** uploaded. On the current app:

- Trip home — fixed, confirmed by absence of `HOME_NAV` rows.
- Freeze — fixed with the same change.
- Storage — 7.3MB → 3.0MB; the app no longer writes tile manifests.
- Live map — inverted to default.
- Course key — normalised, so published surfaces should now resolve.
- `captured_surfaces` — emptied, backed up.

**Unverified:** the camera-ownership gate and the course-key normaliser were
verified by reading, not running — both sit behind `mappedAssist()` and a live
Leaflet instance that could not be synthesised in the harness. The normaliser has an
executable test for the transformation itself.

**Open:** slowness. Ten `setInterval`s run in the play path, the tightest at 90ms
(`consumeOverlayRequests`), several doing DOM work per tick. Not yet profiled — a
Safari timeline over ~10s of play would name the expensive ones. A fresh app should
simply not have them (rule 3).

---

## 9. If you build this fresh

The shortest honest description of the app:

> Fetch the course package. Draw the objects on a map. If the server published a
> surface for this hole, show it instead. Nothing else.

The hole we dug came from the app trying to *produce* what it should only *consume*
— capturing tiles, flattening them, writing them back, then defending the resulting
mess with pollers and blackouts. None of that is needed. The server already publishes
everything the app needs, including the fallback policy.
