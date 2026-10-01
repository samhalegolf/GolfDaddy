# Sophia Green CC scan — what went wrong, and what changed

**Course:** 소피아그린CC (Sophia Green CC), Yeoju, South Korea. 27 holes as three nines:
세종 Sejong, 여강 Yeogang, 황학 Hwanghak. No hole numbers in OSM; the geometry is the
hand-drawn mapping overlay (27 tees, 27 greens, 21 fairways).
**Job:** `0037932e-35b0-4036-844c-9b2001ff4b2a`, 2026-10-01 02:10 UTC, `status: done`.

## What it published

| Row | Name | Problem |
|---|---|---|
| `cc-37-178n-127-708e` | 황학(黃鶴)코스 \| Par 36 | holes dealt from across the site |
| `par-36` | 세종(世宗) 코스 \| Par 36 | overwritten a moment later by Yeogang |
| `par-36` | 여강(驪江)코스 \| Par 36 | the survivor |

Green-to-next-hole walks in the published nines ran 700–1500m. Real nines don't.

## Why

1. **Ids.** A sibling's id was the slug of its name. Korean names slug to nothing, so both
   `… | Par 36` cards became `par-36`, and the second write merged over the first. The id was
   also global: any other club with a card ending "Par 36" would have adopted the row.
2. **Hole lines ignored the drawn tees.** Each green took its nearest fairway and the line
   started at the fairway's far end. Par 3s with no fairway borrowed a neighbour's, so one
   fairway started two holes, and every hole measured about a third short of its card.
3. **Cards claimed ground one at a time.** Each card took the nine holes that best fitted its
   lengths from anywhere on the site. The three cards are near twins (best/second margins
   0.005–0.014), so this was close to a coin toss per hole, and the last card got the
   leftovers. The matcher also only ever saw the 17 most confident of the 27 holes, and the
   scale check compared a nine's card against the nine *shortest* holes on the site.
4. **Names** kept the club page's `| Par 36`.
5. **The debug routine never fired** for the earlier failed run: `Cannot find module
   '@netlify/blobs'`. Netlify esbuild-bundles `alert-utils.js` into the ES-module worker,
   which hides its `require()` from the file tracer, so the package was never shipped.
   `external_node_modules` in `netlify.toml` had no effect (this function is traced, not
   esbuild-bundled) and has been removed.

## What changed

- **Ids** (`loopCourseId`): `<facility id>-<romanised name>` (`cc-37-178n-127-708e-yeogang`),
  or `<facility id>-course-<n>` when there is no real name. Never reused within a run, and
  `findExistingLoopRow` only adopts a row of the same facility.
- **Hole lines** (`gd-geometry-resolver-core.mjs`): fairways pair one-to-one with greens; a
  fairway hole starts at the tee behind its far end; a green without a fairway is a par 3 from
  the tee nearest 150m back. Each green also offers a couple of alternative readings, and the
  matcher never uses a green, fairway or tee twice on one card. No candidate cap; scale is
  compared quantile to quantile; long walks between holes cost properly.
- **Ground first** (`gd-ground-loops-core.mjs`, `claimByGround` in the worker): when the
  cards are all the same length, the site is split into that many routed loops before any card
  is read — the split that keeps every green-to-next-tee walk short — then each card is matched
  to each loop and the best pairing wins. Falls back to the old card-led pass when it doesn't
  fit (mixed card lengths, not enough holes, a card that can't number any loop whole).
- **Names**: `| Par 36` stripped; the romanised name ("Yeogang") is added as an alias.
- **Debug routine**: the worker imports `@netlify/blobs` itself and hands it to
  `alert-utils.useBlobStore`. Checked with Netlify's own bundler: the package now ships.

Replay (`dev/multi-nine-ground-first.test.js`, overlay in `dev/fixtures/`): three rows, three
facility-scoped ids, every loop walk ≤ 442m, no scale warning.

## Still open

- Which nine carries which *name* is weak at this site: the three cards are near twins.
- In two of the three loops a hole line is too rough for the card in strict walking order, so
  the card orders that loop's holes itself (still inside the loop). Better tee placement in the
  overlay would fix that.
- Old sibling rows keep their bare ids (`par-36`, `course-2`, `course-2-5444m-east`, …). They
  are baked into visual storage paths, so they are not renamed. A rescan publishes under the
  new ids, and the old rows then need removing.
