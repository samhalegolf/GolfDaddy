# App Store rejection 8f5517b3 — what changed

Build 1.0 (740) was rejected on 19 August 2026 on two guidelines. Both are fixed
in the working tree; neither has been built or submitted yet.

## 2.3.8 — placeholder app icons

`ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` was the stock
Capacitor logo (blue X on a white grid) — the template asset from `npx cap add
ios`, never replaced. The Android launcher icons and both splash sets were the
same. The real mark had been in the repo the whole time at
`dev/image-originals/brand-cg-logo-white-g.png`.

`dev/generate-app-icons.py` now derives every native asset from that one master,
so they cannot drift apart again. Run it after any change to the brand mark:

    python3 dev/generate-app-icons.py

It writes the iOS 1024 icon (opaque — iOS rejects alpha), the iOS splash set, the
Android legacy and round launcher icons at five densities, the Android adaptive
foregrounds inside the 66% safe zone, and the eleven Android splash files.

One related fix: `android/.../values/ic_launcher_background.xml` was `#FFFFFF`,
which put the white half of the logo on a white adaptive-icon background. It is
now `#050806`, matching `capacitor.config.json`.

## 5.1.1(v) — login wall on features that are not account based

### What was wrong

The wall had four layers, only one of which was obvious:

1. `scripts/inline/gd-auth-gate-v1.js` force-closed every surface with no
   account, pinned the sign-in panel open, blocked `gdCloseProfileV67` so it
   could not be dismissed, and re-asserted all of it from a capture-phase click
   listener.
2. `scripts/inline/gd-auth-reset-route-bootstrap.js` added `html.gdAuthRouteBoot`
   pre-paint for any signed-out visitor, and `gd-app-base.css` uses that class to
   hide the entire shell with `display:none!important`. "Signed out" meant "blank
   app" before a line of app code ran.
3. `scripts/gd-route-audit.js` routed a signed-out player to the auth screen on
   browser back and on history restore.
4. `scripts/inline/gd-course-picker-search-v2.js` refused GPS entry outright when
   the paid check failed.

None of it was load-bearing. The rangefinder does not read an account: nothing in
`app/js/gps.js`, `distance.js`, `pin.js`, `basemap.js`, `painter.js` or
`marshal.js` touches `GolfDaddyAccounts`, and nothing under `app/` references
`ClarityPermissions` at all. The course endpoints (`course-package`,
`course-library`, `course-maps`, `course-visuals`) are already public for reads.

### What it does now

The app opens for everyone. Sign-in is offered, not forced.

**Free, no account:** home, the course picker and library, the bag, GPS settings,
and the full live rangefinder — position, distances, pin, wind, plays-like.

**Needs an account:** Shot Data, Course Data, Practice Data, player settings,
admin. Each of those routes now calls `window.gdAuthGateAllows(reason)` at its
top, in `gd-route-audit.js`. That is a published function rather than a wrapper
around `window.openStats` and friends, because wrappers do not survive here —
`expose()` re-assigns those globals on a timer at ~250ms and ~1200ms, and
`wireClicks()` intercepts the home tiles in capture phase and calls the internals
directly. A wrapper installed at boot is both overwritten and bypassed.

**Needs a membership:** keeping score, logging where shots finish, the round
record, resume, and the bubble. A player without one is no longer refused entry —
they get the rangefinder, and `app/js/access.js` withholds the rest. Signed-in
and signed-out unentitled players get the same free rangefinder, so signing up
never makes the app worse.

`app/js/access.js` is the single place that decides which signals write round
history. Everything absent from its `GATED_SIGNALS` map — `FIX_RECEIVED`,
`PLACED`, `BALL_MOVED`, `LOCK`, `UNLOCK`, hole navigation — is the rangefinder
and stays open. `LOCK` is deliberately not gated: locking a shot is how you
choose the point distances are measured from.

Defence in depth: the marshal effects in `boot.js` refuse to persist anything in
rangefinder mode regardless of what reached them, and `access.js` re-reads the
account itself rather than trusting `?rangefinder=1` from the URL. The worst a
forged URL achieves is a free rangefinder.

### Deliberately fails closed

A membership check that cannot complete still lands in rangefinder mode — a check
that did not finish is not evidence of access. It now says so ("Couldn't check
your membership - distances only for this round") instead of refusing the round,
which is strictly better than the old behaviour on patchy course signal.

## Still to do

- `npm run native:sync` (could not be run from the remote session: the build
  wipes `dist/`, and deletes are not permitted over the desktop bridge)
- `node dev/auth-route-boot-release.test.js` — the seven static checks pass; the
  browser half needs Chrome installed locally
- Walk the signed-out flow on device before resubmitting: open the app cold, tap
  Play, pick a course, confirm the map and distances work, then confirm Shot Data
  and the scorecard offer sign-in rather than opening empty
- In the App Store Connect reply, say plainly that the app now opens to the
  rangefinder with no account, and that sign-in is required only for saved data
