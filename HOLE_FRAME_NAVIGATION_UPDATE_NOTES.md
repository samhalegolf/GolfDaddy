# Hole Frame Navigation Update Notes

Source brief: `Caddy Update .md` / Codex Handover — Hole Frame Navigation Update + Recent Patch Verification.

## What changed

- Kept the Home hard-boundary browser/device back guard so Home does not reopen stale internal routes.
- Patched GPS return helpers so they avoid `enterGpsModule()` and broad `gdV62Refresh()` when GPS is already open.
- Added a lightweight current-round Hole Frame session bridge in the existing play-flow script:
  - `gdSetActiveHoleFrame(holeNumber, opts)`
  - `gdRenderActiveHoleFrame(hole, opts)`
  - `gdMarkActiveHoleLocked()`
- Changed normal next/previous hole movement to switch the active Hole Frame rather than re-entering GPS.
- Suppressed the normal `setHole()` refresh during Hole Frame switching via `window.__gdHoleFrameSwitching`.
- Moved the hole navigation into a left-side vertical rail:

```text
[ > ]
[ H ]
[ < ]
```

## Behaviour intent

Normal hole navigation should now be:

```text
Tap next/previous
→ active hole changes
→ current round session updates
→ Hole Frame renders
→ GPS shell/map instance stays alive
```

It should not be:

```text
Tap next/previous
→ returnGpsMap
→ enterGpsModule
→ gdV62Refresh
→ visible GPS rebuild
```

## Validation performed

- Confirmed `index.html` and `dist/index.html` were populated from the uploaded GitHub/main archive.
- Applied the patch to root `index.html`.
- Ran the Netlify build script to regenerate `dist/` from root files.
- Ran inline JavaScript syntax validation across root `index.html` and `dist/index.html`.
- Confirmed `dist/index.html` contains the Hole Frame update functions.

## Manual acceptance checks still recommended on device

1. Home browser/device back remains a hard boundary.
2. GPS hole 2 → previous → hole 1 does not visibly rebuild/refresh GPS.
3. Next/previous hole movement does not clear GPS/session memory.
4. Pre-lock state still shows correctly after hole switch.
5. Lock In still works and locked state can be restored after moving away and back.
6. Left Hole Rail is clear of the player badge, club card, bottom dock, and right GPS tools.
