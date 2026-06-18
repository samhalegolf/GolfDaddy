# Hole Frame Navigation Update Notes

## Summary

This update changes normal GPS hole movement so it switches the active Hole Frame rather than rebuilding or re-entering the GPS module.

## Included changes

- Home remains a browser/device back boundary.
- Normal next/previous hole navigation avoids GPS re-entry where possible.
- Hole Frame helper functions are present for active-hole switching.
- The left-side Hole Rail is the intended hole navigation control.
- The legacy top-centre hole switcher is hidden by a CSS safety rule.
- Background automatic cloud sync failures on startup/session resume are kept silent so the play screen does not show a large connection warning.
- Manual/account-critical sync actions can still show a blocking connection warning when needed.

## Manual checks

1. From Home, browser/device back should not reopen old GPS state.
2. From GPS, Hole 2 back to Hole 1 should not visibly rebuild the GPS screen.
3. Only the left-side Hole Rail should be visible.
4. Startup should not show a large cloud/sync connection badge over the map.
5. Manual account sync/login/signup errors should still surface when genuinely blocking.
