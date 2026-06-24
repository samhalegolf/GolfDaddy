# Update Applied — Strict Confirmed Green Bridge V18

## Intent

V17 proved the camera/loading-gate concept but accepted an auto-course-mapper payload too early. It could treat a mapped payload as confirmed even when there was not a usable green shape, which allowed the play camera to move into a grey/blank tile area.

V18 makes the confirmation rule strict:

```text
No confirmed green shape = keep loading gate up.
No fallback centre.
No route-end guess.
No stale saved course object.
No visible camera movement.
```

## What changed

- Added a final `gdStrictConfirmedGreenBridgeV18` layer.
- Overrides setup/prelock/lock/target zoom after V17.
- Revalidates any stored V17 confirmed green.
- Rejects point-only `autoCourseMapper` confirmations.
- Accepts auto mapper only when it provides explicit green geometry/shape with sensible green dimensions.
- Manual confirmed green is still allowed from the current target/green marker.
- Keeps the loading overlay visible until a strict green exists.
- Lowers live raster cap to z17 while still allowing visual overzoom.
- Blocks older V17 confirmed-green fit calls if V18 has no strict green.

## Accepted green sources

1. Manual confirmed target/green marker.
2. Auto mapper green shape/polygon with valid green-size bounds.

## Rejected sources

- Route end.
- Broad mapped hole payloads.
- `data.complete` alone.
- Point-only auto mapper centre.
- Saved V11/V12 green truth/cache objects.

## Testing

No deploy performed. Local checks only.
