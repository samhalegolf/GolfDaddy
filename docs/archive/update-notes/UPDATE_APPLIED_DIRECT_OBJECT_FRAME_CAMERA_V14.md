# Update Applied — Direct Object Frame Camera V14

## Reason
V13 was still too easy to confuse because the mapped-start prompt itself was treated as camera ownership. That could block course-opening / mapped-hole focus calls before a fresh green object was available, leaving the map at a stale/random view.

## Main change
V14 keeps the simple rule:

```text
object bounds -> selected frame -> scale/translate
```

But tightens what counts as an object and when the camera is allowed to block old Leaflet moves.

## Behaviour

### Setup / pre-frame
- Fits the fresh current green object into `GREEN / HOLE FRAME`.
- Uses live `greenCentre` / `greenPolygon` first.
- Falls back to current mapped-hole green data from the active course/hole.
- Does not fit the full hole.
- Does not include tee in the bounds.
- Tee is only used to orient the map when available.

### Lock
- Fits the active shot object/bubble into `LOCK FRAME`.
- Does not include tee or the whole hole.
- Overrides the old `gdHeadToTeeShotFrame()` whole-hole fit so Head To Tee cannot re-broaden the view after lock.

### Target zoom
- Fits the same active shot object into `GREEN / LANDING ZOOM`.
- Tap again restores the previous camera transform.

## Saved object pause
- Keeps saved V11 hole-image / green-truth camera manifests paused for clean testing.
- Does not treat prompt state alone as camera ownership anymore.
- Saved camera objects can still be reset with:

```js
gdResetHoleImageFresh()
gdSimpleFrameUseSavedCourseObjects(false)
```

## Debug
With target-frame debug on, the readout shows:

```text
owner • object • frame • source • zoom
```

Expected source during this test:

```text
fresh-course/live-only
```

## Validation
- V14 inline script syntax checked with `node --check`.
- Netlify build passed with `npm run build:netlify`.
