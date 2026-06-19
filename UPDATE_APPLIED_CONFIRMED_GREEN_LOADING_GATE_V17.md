# Update Applied — Confirmed Green Loading Gate V17

## Intent

V17 keeps the camera strict: no fallbacks, no guessing, and no stale rough map centre. The loading screen owns the waiting state until the current hole has a confirmed green from either:

1. the auto course mapper's active mapped hole payload, or
2. a real manual target/green already set on screen.

Once confirmed, the camera fits that exact green into the GREEN / HOLE FRAME. If there is no confirmed green, the camera does not move.

## Main changes

- Added `gdSetCurrentConfirmedGreen(green)` bridge.
- Added `gdGetCurrentConfirmedGreen()` bridge.
- Added `gdResetConfirmedGreenFresh()` for clean testing.
- Added full-screen `#gdConfirmedGreenLoadingGate` overlay.
- Added `body.gdWaitingForConfirmedGreen` state.
- Replaced setup/prelock camera entry points so they:
  - check for current confirmed green,
  - show loading if missing,
  - poll the mapper until confirmed,
  - then fit the confirmed green.
- Replaced lock/target zoom entry points so they also refuse to move without confirmed green.
- No fallback chain was added.
- No deployment was run.

## Camera rule

```text
No confirmed green = loading screen stays up and camera does nothing.
Confirmed mapper/manual green = loading clears and camera frames that exact green.
```

## Accepted sources

```text
manualConfirmedGreen
or
autoCourseMapper
```

## Rejected sources

```text
rough map centre
route end without green confirmation
stale saved course object as a fallback
whole-hole bounds
tee/start bounds
```

## Cheap local checks

- Inline script syntax extraction/check should pass.
- `npm run build:netlify` should pass locally.
