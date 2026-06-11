# Clarity Rename Plan

## Goal

Move the app identity from Golf Daddy to Clarity Caddie without breaking saved data, module wiring, or the locked Green Wand flow.

## Current Pass

- Rename user-facing app surfaces to Clarity Caddie.
- Use Clarity Golf Systems as the parent brand in docs/metadata.
- Add the first GC-style monogram treatment in the home header and course picker.
- Update package/readme/fixture docs so the project identity no longer reads as Golf Daddy.
- Add Clarity-prefixed browser globals as compatibility-safe aliases.

## Compatibility Boundary

Keep these stable until there is a separate migration pass:

- `window.GolfDaddy*` globals
- `gd_*` localStorage/sessionStorage keys
- `golf_daddy_*` developer tuning keys
- `scripts/gd-*.js` filenames
- Green Wand engine names and storage contracts

These names are runtime contracts, not just display text. Renaming them directly risks losing stored player/course data or breaking modules that load in a specific order.

## Next Safe Pass

1. Add formal storage migration helpers from old keys to Clarity keys.
2. Keep old keys as fallback reads for at least one release.
3. Rename developer-only labels and logs after tests pass.
4. Rename files only after script references and cache-busting URLs are updated together.
5. Remove old aliases only after confirmed saved data survives across reloads.

## Verification

- Extract and syntax-check inline scripts with `node --check`.
- Syntax-check supporting scripts.
- Load `http://localhost:5173/?v=clarity-rename-1`.
- Confirm home, course picker, Play/GPS, Data Hub, profile, and Green Wand still open.
- Confirm saved courses and practice/course data still appear.
