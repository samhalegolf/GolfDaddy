# Branding / Name Change Handoff

Live app folder:

`/Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current`

Run:

`npm start`

Preview:

`http://localhost:5173/`

Primary file:

`index.html`

## Current State

This is still a single-file local web app with supporting scripts. Most visible UI text, home shell, GPS shell, course picker, Data Hub, Practice Data, and Course Data live in `index.html`.

Recent GPS Focus Mode work is in `index.html` and should be preserved:

- focus mask CSS near the top of the file
- `gdFocusPane` setup near the Leaflet map initialization
- focus/framing helpers around `gdClearGpsFocusModeLayer`, `gdFocusModeCorridor`, `gdUpdateGpsFocusModeLayer`
- bubble drag simplification and expanded hit area around `gdInstallSmoothBubbleDrag`, `gdSyncBubbleDragHitArea`, `renderCustomBubble`
- aim-line extension/object recognition helpers around `gdAimLineEndPoint`

Green Wand remains locked. Read `GREEN_WAND_LOCK.md` before touching Wand sampling, tile crop, contour, shell, magnetic pull, or calibration logic.

## Branding Goal

Next task is a branding/name change. The new name/brand has not been specified in this thread. Start by asking for:

- New product/app name
- Tagline or subtitle
- Whether the player badge name `SAM` / `SAMCOACH` should change
- Whether icon/logo/color direction should change
- Whether this is only user-facing branding or also internal namespaces/storage keys

## Recommended Scope

Do the rename in two passes:

1. User-facing branding only
2. Internal namespaces/storage keys only if explicitly requested

Pass 1 is safer and likely enough for the user-visible app.

Avoid renaming localStorage keys, `GolfDaddy*` module names, `gd_*` keys, or script filenames unless the user explicitly asks for an internal/code-level rename. Those names are wired into storage compatibility and module APIs.

## Likely User-Facing Touch Points

In `index.html`:

- `<title>Golf Daddy Core Clean v1</title>` near the top
- direct-file fallback text:
  - `Open Golf Daddy from localhost`
- home header:
  - `aria-label="Golf Daddy home"`
  - `GOLF DADDY`
  - `better thoughts on the course`
  - `aria-label="Golf Daddy home navigation"`
- course picker brand:
  - `Golf Daddy`
  - `Better choices on the course`
- HTML comment around the app version/name, if desired
- CSS comments such as `Golf Daddy App Shell...` only if the user wants code comments cleaned too

Player/profile labels:

- GPS badge defaults:
  - `SAM` around `#playerName`
  - `SAMCOACH` may be rendered from profile/account data or defaults; search before editing.

Package metadata:

- `package.json` description contains `Golf Daddy`.

Supporting scripts with visible/log/comment brand strings:

- `scripts/gd-course-library-pin-lock.js`
- `scripts/gd-namespace.js`
- `scripts/gd-shot-events.js`
- `scripts/gd-launch-monitor-data.js`
- `scripts/gd-windross-seed.js`

Most of these are internal/logging strings. Treat them as lower priority for a visual rename.

## Internal Names To Avoid Renaming By Default

Do not casually change these without a migration plan:

- `window.GolfDaddy`
- `window.GolfDaddyCore`
- `window.GolfDaddyShotEvents`
- `window.GolfDaddyLaunchMonitorData`
- `window.GolfDaddyCourseLibrary`
- `gd_*` localStorage/sessionStorage keys
- `GD_*` constants
- filenames under `scripts/gd-*.js`

These are implementation/compatibility identifiers, not just branding.

## Verification

After edits:

```bash
python3 - <<'PY'
from pathlib import Path
html=Path('index.html').read_text()
parts=[]
for part in html.split('<script')[1:]:
    if '>' not in part:
        continue
    body=part.split('>',1)[1]
    if '</script>' in body:
        parts.append(body.split('</script>',1)[0])
Path('/tmp/gd-index-scripts.js').write_text('\n'.join(parts))
PY
node --check /tmp/gd-index-scripts.js
```

Then reload:

`http://localhost:5173/?v=<cache-bust>`

Check at least:

- Home loads and new brand appears
- Play/GPS opens
- Course picker brand/subtitle updated
- Direct `file://.../index.html` fallback still points users to localhost
- No console errors

## Notes From Recent Work

The current preview server may stop between sessions. If localhost refuses connection, run `npm start` from the app folder.

Latest preview cache-bust used during this session:

`http://localhost:5173/?v=focus-mode-30`

