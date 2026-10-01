# Facility organise — plan

**Date:** 2026-10-01
**Why:** Millbrook. The mapper split the resort into four 18s called "Course 1 - 6298m North-West" and so on. The
one card we hold for it is **"Remarkables/Arrow Course"** — an 18 built from two named nines. Nothing we have today can
turn "four 18s" into "these nines, played in these combinations, with these names". Naming can only rename; it needs
to be allowed to **re-organise**.

## What we have today

| Piece | What it does | What it can't do |
|---|---|---|
| Parent (`course_maps.facility_key` + `facility_name`) | Groups a facility's courses; picker shows "Millbrook Golf Resort" → its courses | Say how the courses relate (nines, combinations) |
| Mapper naming (`nameLoopsFromCards`) | Pairs cards with separated courses, one to one | Needs 2+ cards; can't use a card twice; can't split an 18 into nines; can't name from one card |
| Update Scorecards (Studio button) | Fetches cards, renames siblings when every sibling has a card | Never changes the grouping, splits or merges anything, or handles combination cards |
| Unnumbered path (Sophia Green) | Understands nines and combination cards (`sliceClaimIntoLoops`, multi-nine structure) | Only runs on sites with no OSM hole numbers |
| App play order | Player taps two nines; remembered on the phone only | Plays only the front nine; no stored combinations anywhere |

## What "organised" means

A facility is three layers:

1. **Parent** — "Millbrook Golf Resort". Already stored.
2. **Ground** — the physical pieces of golf: nines, or 18s that are never split. One `course_maps` row each, with
   geometry. This is what the mapper finds.
3. **Playable courses** — what a golfer books and a card describes. Either one ground piece (a stand-alone 18, a
   nine played twice) or a **combination** of two nines ("Remarkables / Arrow"). No geometry of its own — it points
   at its nines.

The picker shows: parent → playable courses. Fallback when nothing is known: "Course 1", "Course 2" with a
N/S/E/W hint (what we do now), and for nines "Nine A — North".

## The organise step

One server function, `organiseFacility(facilityKey)`, that works out a **plan of changes**, then applies the safe ones.

**Inputs:** every `course_maps` row under the facility, every card stored for it, the OSM outlines' names.

**1. Read the ground.** Are the pieces nines or 18s?
- A card set made of nines or "X/Y" combinations says the site is built from nines.
- An 18 on the ground whose hole 9 green and hole 10 tee are both by the clubhouse, and whose two halves match two
  different nine cards, is really two nines.
- Reuse what the unnumbered path already knows: the multi-nine structure test and `sliceClaimIntoLoops`.

**2. Match cards to ground, allowing reuse.**
- A 9-hole card → one nine.
- An 18-hole card → an ordered pair of nines (front, back), or one 18.
- A nine may appear in several combinations — that is the point at Millbrook.
- Matching stays relative (par-3 positions, long/short order), scored jointly, with a winning margin — same rules as
  the current matcher, applied per nine instead of per 18.

**3. Name things.**
- Nines get names from the cards that share them: "Remarkables/Arrow" and "Remarkables/Coronet" share a nine →
  that nine is "Remarkables".
- A combination is named from its card.
- OSM outline names still win when present. Provisional names remain the fallback.

**4. Write the plan before applying it.** Each change is listed with its evidence and confidence:
rename · split an 18 into two nines · add a combination · set aside a neighbouring club · retire a row nothing
explains.

**5. Apply only what's safe.**
- Renames and new combinations: automatic above the confidence bar.
- Splits, retirements and anything touching a course that has **saved rounds**: shown in Studio for one-click
  approval, never automatic.
- Ids never change. A split keeps the 18's row as a combination and adds the two nines as new rows, so existing
  rounds, visuals and watch maps keep working.
- Backup rows before any destructive change, as we did today.

**When it runs:**
- After the mapper publishes a multi-course facility.
- After Update Scorecards stores new cards — this is the "stronger naming run", now with permission to re-organise.
- From a Studio button "Organise facility", with the plan shown first.

## Database changes

- `course_combinations` (new table): `id`, `facility_key`, `name`, `front_course_id`, `back_course_id`, `card_key`,
  `confidence`, `source`. An earlier `facility_play_orders` column was dropped because it lived on a course row;
  combinations are facility-level facts, so they get their own table.
- `course_maps.ground_kind` (new, nullable): `nine` | `course`. Lets the picker and app tell nines from 18s without
  counting holes (a 10-hole TPC row today is neither).
- `course_maps.organised_at`, `organise_plan` (jsonb): the last plan and when it ran, so Studio can show what was
  done and what is waiting for approval.

## Phases

| Phase | What | Risk |
|---|---|---|
| 1 | `organiseFacility` as a **dry run**: builds the plan, stores it, Studio shows it. Renames applied. | Low — names only |
| 2 | `course_combinations` table; picker lists combinations under the parent; Studio approval for splits/retirements | Medium — new table, picker change |
| 3 | App plays a combination as one 18 (front nine then back nine in one round). Today it only opens the front nine. | Medium — round/scoring code |
| 4 | Run automatically after mapping and after Update Scorecards | Low once 1–3 are proven |

Phase 1 alone fixes the Millbrook naming as far as the cards allow and shows, in Studio, exactly what it would do
with the rest.

## Small fixes to fold in

- Card names keep HTML entities: "Millbrook Resort **&amp;amp;** Country Club". Decode them in the scorecard reader.
- `nameLoopsFromCards` needs two cards; with one card and one clearly matching course it should still name that one.
- Rename `loop` → `course` / `nine` in this code as it is touched (agreed in `HANDOVER_MULTI_COURSE_2026-08-25.md`).

## Decisions (Sam, 2026-10-01)

1. **Combinations show in the picker** as their own lines under the parent ("Remarkables / Arrow"). Picking two
   nines by hand stays as the fallback when no cards exist.
2. **Splits and retirements wait for one-click approval in Studio.** Renames and new combinations apply
   automatically above the confidence bar.
3. **Phase 3 (playing two nines as one 18-hole round) is later.** Phases 1, 2 and 4 go first; until phase 3, picking
   a combination opens its front nine as today.
