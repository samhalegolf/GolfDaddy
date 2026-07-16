# UPDATE APPLIED — Framed Box Camera Rebuild V6

## Purpose
Make the framed-box camera system much more aggressive and remove the last broad fallback behaviour from the locked shot camera path.

## Key changes

- Green-target lock now frames a tight green-centre target, not the whole green outline/polygon.
- Fairway/layup lock frames the shot bubble only.
- Lock/zoom no longer include tee/start or route bounds.
- Lock/zoom now use stronger direct pixel zoom and allow map over-zoom up to ~23.
- A locked shot blocks old `map.fitBounds()` calls from pulling the camera back out.
- Lock refit now repeats after render so old render work cannot immediately undo the framed-box fit.
- `TEE FRAME` moved lower and widened.
- Added setup-only two-point camera fitting so the tee/start marker is pushed into `TEE FRAME` while the green is pushed into `GREEN / HOLE FRAME`.
- The tee frame remains irrelevant once the shot is locked.

## Notes
The intended test is now:

1. In pre-lock/setup, the start/tee marker should sit inside the low `TEE FRAME` while the green sits in the upper `GREEN / HOLE FRAME`.
2. On lock, the tee frame should be ignored completely.
3. On lock, the green or fairway bubble should fill the `LOCK FRAME` much more aggressively than previous builds.
4. The camera should not pull back out to a broad hole view after render.
