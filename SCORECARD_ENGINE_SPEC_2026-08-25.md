# The Scorecard Engine

Spec. Companion to `TE_ARAI_SCAN_INVESTIGATION_2026-08-25.md` and
`MULTI_COURSE_MAPPING_SPEC_2026-08-25.md`.

## Scope

Two jobs, in this order:

1. **Get a scorecard** — resolve a club's card into `{hole, par, distanceM}`.
2. **Use it to identify a course** — decide which mapped loop is which named
   course, by comparing relative hole structure.

**Presenting cards in GPS Play is explicitly last** and is the easy part once the
data above is reliable. It is not in this spec.

## Why it exists

Te Ārai's mapper run had `expectedHoles: null`. That one missing number disabled
the wider-frame retry, the geometry-resolver handoff, *and* the "published
incomplete" warning — three guards, one dependency. `course_scorecards` has zero
rows and no writer, so that null is the normal case for every course.

---

# Part A — Getting a card

## What the engine needs

Three fields per hole. Not five tee sets, not stroke index, not gender variants,
not scores.

```
{ hole: 1, par: 4, distanceM: 380 }
```

The old parser (`_recovered/scorecard-2026-08-02/`) tried to build a fully
playable card, which is where its hardcoded column map came from:

```js
values[0]=Black, [1]=Blue, [2]=White, [3]=Yellow, [4]=Red, [5]=index, [6]=par
```

Five tee columns in fixed order, never reading the header row to check. A club
with four tee sets, or six, or par first, put every value in the wrong field
silently.

## Which tee column to read

**Any of them.** Matching runs on relative structure, not absolute distance, so
the tee set does not need to be identified correctly for identification to work.

When an absolute number *is* wanted, default to **second-from-furthest** — that
is the usual best fit against mapped geometry. But nothing in Part B depends on
getting this right.

This removes the single hardest problem the old parser had.

## Return cards, not a card

A club with two courses usually puts **both cards on one page**. The parser must
return a list:

```
[ { name: "North Course", holes: [...] },
  { name: "South Course", holes: [...] } ]
```

Getting this shape right at the start matters more than parsing accuracy. A
single-card return type forces a rewrite the moment Te Ārai is the input.

## Tolerate gaps

Delete the `holes.length === 18` gate. It threw away a 17-hole parse and moved
on. Twelve clean holes fingerprint a course perfectly well.

Return what was read, with a count. Let the consumer decide if it is enough.

## Hole count is a separate, easier question

"18-hole championship links" in prose gives `expectedHoles` with no table parsing
at all. Extract it independently — it is the single most valuable field and the
cheapest to get.

## Reuse

| Piece | File | Status |
|---|---|---|
| Find the URL | `functions/scorecard-search.js` | works, no caller |
| Fetch the HTML | `functions/scorecard-fetch.js` | works, no caller |
| Cache + share | `functions/scorecard-store.mjs` | works, GET only |
| Resolution ladder | `_recovered/.../gd-gps-scorecard-owner-v1.js:418` | port it |

The ladder is the good part of the old code — memory → device cache → shared
store → guessed URLs → search → seed, cheapest first, search last because it
costs an API call. Port that logic; leave the UI behind.

**Build server-side** (`linkedom` or `cheerio`) so the mapper and the picker
share one implementation. The old one used `DOMParser` and could only run in a
browser — which is the entire reason `course_scorecards` is empty.

Porting gotcha: `linkedom`/`cheerio` have no `innerText`. Two of the old
strategies depend on its line breaks and need rewriting against `textContent`.

## Provenance, not confirmation

No confirmation prompts. Best effort, but every value records where it came from:

```
{ hole: 4, par: 4, distanceM: 380,
  from: { url, table: 2, row: 4, column: "White" } }
```

A wrong number whose source is visible is a one-line correction to a column map.
A wrong number with no origin is a mystery. Corrections are data — a stored
column map per source — never a new parser function.

---

# Part B — Identifying a course from its card

## The principle

**Relativity, not absolute distance.**

Tee sets vary, OSM geometry and scorecard yardage disagree on doglegs, and units
differ by country. None of that matters. What is invariant is the *shape*: which
hole is longest, which is shortest, where the short holes fall.

A course's relative hole structure is effectively a fingerprint, and the same
fingerprint is recoverable from both the OSM scan and the card. Comparing the two
is enough to identify a course definitively.

## Measure the geometry

OSM's `golf=hole` is normally a **line** from tee to green, not a point — so it
gives the playing line, dogleg included, which is what the scorecard measures.

`lineDistanceM()` already exists at `gd-geometry-resolver-core.mjs:56`.

Fallback when holes are mapped as greens only: green-to-green spacing. Less
precise, still ranks correctly.

> **Check first for Te Ārai:** are holes mapped as ways, or only greens? That
> decides fingerprint quality. The scan found 32 greens and 16 guides, which
> suggests ways exist but are incomplete.

## Score jointly, not greedily

There are N loops and N cards. **Solve the whole assignment at once** — do not
match each loop to its best card independently, which can assign both loops to
the same card.

For 2×2, evaluate both assignments and take the higher total. Larger sites:
Hungarian, or brute force while N is small.

Three signals, all relative:

1. **Rank correlation.** Convert each loop and each card to rank order (longest
   to shortest), correlate. Immune to tee sets, units and dogleg error.
2. **Par-class positions.** Short holes are unambiguous from geometry. "This
   loop's short holes are 3, 8, 12, 16" against "North's par 3s are 3, 8, 12,
   16" is near-decisive — sibling courses rarely share par-3 positions.
3. **Between-course ratio.** Loop A / Loop B total length against Card A / Card B
   total. Both sides measured in their own system, so the ratio is comparable
   even when the absolute scales are not.

## Use the resolver's scoring — do not rebuild it

The machinery already exists and should be lifted, not rewritten:

| Function | File:line | Does |
|---|---|---|
| `scorecardLengthOrder()` | `gd-geometry-resolver-core.mjs:584` | rank fingerprint |
| `rankMap()` | same | rank scoring |
| `distanceScale()` | `:614` | scale reconciliation, warns >12% |
| `matchCandidatesToScorecard()` | `:709` | full matcher |
| `lineDistanceM()` | `:56` | playing-line length |

The resolver today asks *"which card hole is this unnumbered green?"* Part B asks
*"which card matches this loop?"* — the same comparison one level up. Extract the
scoring core so both callers share it.

**Par-3 positions are the fast path; resolver scoring is the tiebreak.** When
signal 2 is decisive, take it. When two cards have similar par patterns, fall
through to full rank scoring.

## Require a margin

Report the winning assignment *and* the runner-up. When the two are close, the
answer is "unresolved" — publish both courses with provisional labels rather than
guessing a name. Mapping is never blocked by this; only naming is.

---

# The three consumers

| Use | Needs | Tolerates gaps | Blocks mapping? |
|---|---|---|---|
| `expectedHoles` | hole count only | n/a | no — re-enables 3 guards |
| Which loop is which course | par + rank order | yes | no — naming only |
| Hole numbering when OSM has none | distances | partly | yes |

Only the third needs the full native resolver.

---

# Order of work

1. **Hole count extraction.** Cheapest, highest value, no table parsing. Fixes
   the `expectedHoles: null` that broke Te Ārai.
2. **Server-side parser** — par + distance, multiple cards per page, gaps
   allowed, provenance on every value.
3. **Port the resolution ladder** and wire the POST to `scorecard-store`, closing
   the loop that has never been closed.
4. **Extract the resolver scoring core** into a shared module.
5. **`matchLoopsToCards()`** — joint assignment, three signals, margin reporting.
6. **GPS Play presentation.** Last, and easy by then.

Steps 1–3 are useful on their own even if 4–6 never happen: a stored card
supplies `expectedHoles` and turns three disabled guards back on regardless of
whether anything ever matches a loop to it.

## Testing

Step 5 is testable **now**, with no fetching, against Te Ārai — two par
sequences and the OSM scan output are enough to prove the matcher before any
parser exists.
