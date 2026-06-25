# Safe UI Branch Notes

Branch: `fix/safe-ui-issues-from-main`

## First patch

Fixes GPS shell navigation visibility and removes the legacy top-centre hole switcher from GPS.

Changed files:

- `styles/gd-shell.css`
- `dist/styles/gd-shell.css`

## Behaviour

- Back/Home stay visible on GPS via fixed shell nav styling.
- Back/Home get explicit background, border, z-index, and pointer-events.
- Legacy `#gdNextHolePopout` / `.gdNextHolePopout` is hidden globally so it cannot appear above the GPS view.

## Related issue

- #11 hidden back and home buttons
