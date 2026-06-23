# UPDATE APPLIED — Framed Box Camera Rebuild V7

This patch makes the framed-box system the final camera authority.

## Main fix
The mapped course / object-scan pre-lock camera was still firing broad hole framing after the debug boxes loaded. That made the app look like it accepted the new index but reverted to the old hole view.

V7 replaces that path:

- `gdFrameMappedPreLockPreset()` now uses the framed-box system.
- `gdFrameMappedPreLockHoleView()` now uses the framed-box system.
- `gdQueueMappedPreLockHoleFrame()` now repeatedly applies the new two-anchor frame-up.
- `gdFocusMappedPreLockHole()` is wrapped so old pre-lock setup cannot win after hole changes/unlock.

## Setup / hole frame-up
Pre-lock is now a two-anchor solve:

- mapped green is pushed into `GREEN / HOLE FRAME`
- mapped tee/start is pushed into `TEE FRAME`
- map rotation is accounted for when solving the camera centre
- tee frame is lower and wider

## Lock / zoom
Lock and zoom remain single-object framing:

- green mode frames only a tight green target
- layup/fairway mode frames only the bubble
- no tee/start included in lock or zoom
- no broad hole fallback
- aggressive fill ratios and higher max zoom are used
- CSS map rotation is accounted for when placing the target into the frame

## Debug
`window.__gdLastTargetFrameFit` and `window.__gdLastPrelockTwoAnchorFit` are written after camera solves so live testing can inspect what actually ran.
