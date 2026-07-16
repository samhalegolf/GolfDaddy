# UPDATE APPLIED — Framed Box Camera Rebuild V9

## What changed

V9 makes the framed-box camera a single owner rather than another refit layered on top of the old mapped camera flow.

### Frame contract
- `GREEN / HOLE FRAME` = inner frame, setup / hole-frame only.
- `LOCK FRAME` = middle frame, shot lock-in target.
- `GREEN / LANDING ZOOM` = outer frame, target zoom only.
- `TEE FRAME` = low setup-only tee/start target.

### Camera fighting fix
The jumpy pre-frame behaviour was caused by older mapped camera and green-focus paths still calling `setView()` / `fitBounds()` after the new frame fit ran. V9 installs a camera-owner gate:
- pre-lock frame owns the camera briefly while it places tee + green;
- lock owns the camera while locked;
- target zoom owns the camera while zoomed;
- older camera calls are blocked and recorded instead of being allowed to pull the view out.

Debug counters:
- `window.__gdV9SetViewBlocked`
- `window.__gdV9FitBoundsBlocked`
- `window.__gdV9LastBlockedSetView`
- `window.__gdV9LastBlockedFitBounds`
- `window.__gdLastTargetFrameFit`
- `window.__gdLastPrelockTwoAnchorFit`

### Aggressive object fitting
- Green lock uses a tight green object only; oversized scanned polygons are rejected.
- Fairway/layup lock uses a bubble object only; oversized bubble shapes are rejected and replaced by a tight centre bubble target.
- Lock-in fits to the middle lock frame, not the inner hole frame.
- Target zoom is separate from green focus and fits to the outer zoom frame.

### Setup framing
- Tee + green pre-frame is a single two-anchor fit.
- Tee target is biased deeper into the low tee frame.
- Green target is biased into the inner hole frame.
