# UPDATE APPLIED — Framed Box Camera Rebuild V8

## Purpose

V8 corrects the frame contract and removes the remaining camera fight between the mapped-course pre-lock camera and the new framed-box camera.

## Correct frame semantics

- `hole` / inner frame = setup green/hole frame only.
- `lock` / middle frame = shot lock-in target frame.
- `zoom` / outer frame = green/landing target zoom.
- `tee` = setup-only tee frame.

Lock-in now fits to the middle `LOCK FRAME`, not the inner `GREEN / HOLE FRAME`.

## Main fixes

- Added final V8 overrides after V7 so the corrected functions win.
- Stopped calling the old mapped green-focus/pre-lock fit before applying the framed-box fit.
- Replaced old pre-lock camera calls with a single two-anchor fit: tee into tee frame, green into hole frame.
- Separated target zoom from old green focus / `gdGreenArrivalMode` behaviour.
- Made green-target lock much more aggressive by using a tight green-centre target instead of scanned green/full-hole bounds.
- Made lock and zoom use stronger fill and zoom boost.
- Added short authority window to ignore stale broad `map.fitBounds()` calls while the V8 camera is taking over.
- Added debug state:
  - `window.__gdLastTargetFrameFit`
  - `window.__gdLastPrelockTwoAnchorFit`
  - `window.__gdV8FitBoundsBlocked`

## What was fighting it

The older `gdGpsMappedCameraAndGreenFocusV1` camera path was still scheduling broad `fitBounds()` / green-focus framing after the new boxes loaded. Earlier patches were repeatedly correcting after that old path fired, which caused visible jumping. V8 replaces those calls instead of chaining through them.
