# Courses with more than 18 holes — plan

Written 2026-08-19. Revised twice: once after researching four real facilities
and the WHS rating rules, and again after Sam corrected the North Shore facts,
which removed most of the plan. Clarity Caddy only.

## The short version

**Make GPS Play and the scorecard handle whatever `hole_count` says, and let a
round start on any hole. Then delete the two nine-pairing files and replace them
with nothing.**

No new tables. Everything below is the reasoning, and the two things worth
storing later once they earn it.

## What North Shore actually is

North Shore Golf Club, Albany is 27 holes numbered continuously **1–27**. There
is exactly one hole 20 on the property.

Its three named courses are **play orders**, not names of nines:

| Course | Holes, in order |
|---|---|
| Blue | 1 → 18 |
| Gold | 19 → 27, then 1 → 9 |
| Red | 10 → 18, then 19 → 27 |

All three are the same thing with a different start hole, wrapping round 27:
**Blue starts at 1, Red at 10, Gold at 19.** Each plays 18 holes. That is one
integer per course, not a data model.

> **Warning for anyone reading the club's website.** The official course tour
> page says something different — "The Red course includes holes 1 to 9", "the
> Blue course encompasses holes 10 to 18", "The Gold course consists of holes 19
> to 27". That reads as three named *nines*, which is not how the club is played.
> Any automated scorecard parser pointed at that page will produce the wrong
> structure with high confidence. This is the main reason the scraper described
> in the previous draft of this plan is no longer recommended.

## Why this needs almost no machinery

Because the hole numbers are unique within the site, the physical hole number is
already a complete identity. Hole 20 needs no qualifier. Geometry, captured
surfaces and shot events are keyed by hole number today and stay correct with no
change at all.

The mapper already produces this shape. OSM tags a 27-hole club as three loops
each numbered 1–9; `detectHoleNumberCollision()` catches the collision and hands
off to the Native Geometry Resolver, which derives physical numbering from
scorecard distances. That is how `north-shore` ended up with `holes_json` keyed
`"1"`–`"27"`. **By the time anything reaches `course_maps`, hole numbers are
unique within the site.** Royal Auckland & Grange will land in the same shape,
whatever its own signage calls the three circuits.

So there is no storage problem to solve. There is a *presentation* problem: the
app assumes 18.

## What to actually change

**1. Remove the 18-hole assumption from play and scoring.**
Round setup, the scorecard and next/previous-hole navigation should read the
site's real hole count and allow a start hole other than 1. Jump-to-hole already
works; this is about not hardcoding the length and the start.

**2. Delete `scripts/gd-multi-nine-courses.js` outright.**
Per rebuild rule 2: the file, its `<script>` tag in `index.html` (line 362), the
hardcoded Howeston registry, and the `gd_nine_selection_v1` localStorage key. Its
only real behaviour is renumbering holes to 1–18, which its own comment admits
breaks scan alignment when the pairing changes.

**3. Gut `ninesFor()` in `app/js/nines.js`.**
It invents contiguous 9-hole blocks and labels them "Nine A/B/C" — names no club
uses, for a structure that does not need to exist. If nothing else needs the
module afterwards, delete the file and its `<script>` tag too rather than
leaving an empty owner.

**4. Collapse the selection keys.**
`clarity:nines:v1` in `scripts/inline/gd-durable-storage.js` (line 49) and
`gd_nine_selection_v1` both store a nine pairing. Neither is needed. If anything
persists at all it is a start hole on the round, which already has a home.

`/api/course-package` is unchanged — it already returns `holes: [{holeNumber,…}]`
keyed by physical number for all 27.

## What to build later, when it earns it

**A routing name, when a saved round needs one.**
The moment a completed round should read "Gold" rather than "holes 19–9", store
three rows: `{site_id, name, start_hole, hole_count}`. Three integers and three
strings for North Shore, nothing for every other course in the database. This is
also the prerequisite for handicap posting, since the WHS rates each 18-hole
combination as its own course (Interpretation 5.6/6). Not needed until then.

**A facility grouping — not needed, and now built as search instead.**

St Andrews Links is eight courses — Old, New, Jubilee, Eden, Strathtyrum,
Balgove (9 holes), Castle, and Craigtoun (the former Duke's, rebranded January
2026) — over four clubhouses and several miles. The first draft of this plan
proposed a `facility_id` to group them.

That is not needed. Google Maps gives every one of those courses its own pin and
no parent record, and it is not worse off for it. Grouping is geography, not
schema, so it belongs in search:

1. **Nominatim** resolves a name to places. Results within 25km of each other
   are one place; more than one place asks which. One place asks nothing.
2. **Overpass** resolves that place to the courses on it — `leisure=golf_course`
   within 5.2km, merged with `course_maps` so mapped courses are playable at
   once.

Two requests, and the second deliberately drops the search term: Craigtoun,
Balgove, Jubilee and Eden are not called St Andrews anything, so a query
carrying the term returns half the list and looks like it worked.

**The rule that keeps it honest: render distance, never hierarchy.**
"Craigtoun Course · 4.1km" is a fact we measured. "St Andrews Links › Craigtoun"
is an ownership claim invented from proximity. Same list, same order — and it is
why an unrelated club appearing on the list costs nothing. There is no
relationship to be wrong about.

Built 2026-08-19: `functions/lib/gd-courses-near-core.mjs`,
`functions/courses-near.mjs` (`GET /api/courses-near?lat=&lng=`), and the area
step in `scripts/inline/gd-course-picker-search-v2.js`. Covered by
`dev/courses-near.test.js`. Falls back to today's flat list whenever the nearby
lookup returns nothing, so offline, a busy Overpass, or a thin OSM area all
degrade to current behaviour rather than an empty screen.

## Order of work

1. Remove the hardcoded 18 from round setup, scorecard and hole navigation.
2. Allow a start hole other than 1.
3. Delete `gd-multi-nine-courses.js`; prove it with `npm run test:boot` + grep.
4. Gut or delete `app/js/nines.js` and the two selection keys.
5. Play North Shore and check that starting at 19 and wrapping to 9 produces a
   sane scorecard and correct per-hole GPS.

## Notes from the research worth keeping

- **The industry norm is one static row per 18-hole combination** — Arccos,
  18Birdies, Hole19, SkyGolf, most of Garmin's database. It is also their main
  complaint generator: Arccos has a support article called *"How do I request a
  course combination?"* whose remedy is emailing them a scorecard. Nothing here
  needs to reproduce that.
- **Mid-round re-routing is unserved.** Garmin explicitly refuses it ("once you
  have selected both nines, you cannot update the selection"); 18Birdies makes
  you delete the round and re-enter it. Only SwingU supports it. With a start
  hole and continuous numbering, Caddy gets it for free — a player sent somewhere
  else at the turn just keeps playing.
- **Nobody keys shot data to physical holes across combinations.** SkyGolf keeps
  separate leaderboards per routing; 18Birdies warns rounds disappear from a
  course's history when played "under a duplicate or different course profile".
  Caddy already does the right thing here and should keep doing it.
- **Terminology**, if a name is ever needed: "facility", "course", "nine",
  "combination". No app or rulebook uses "loop"; Hole19's "path" is overloaded
  with swing path in their own glossary.
- **Boulcott's Farm is not 27 holes** — a standard 18 plus a separate 6-hole
  course, the "Summerset Six". A second `course_maps` row if it is ever wanted.

## Unrelated data fixes worth doing anyway

Two rows in `course_maps` are wrong and will confuse any course search:

- `old` → "Old Course", at 55.5255 / −4.6413, which is the Troon coast, not
  St Andrews.
- `saint-andrews` → "Saint Andrews Golf Course", which is in Iowa, competing for
  the same name.

## Sources

- [Rules of Handicapping, incl. Interpretation 5.6/6 (PDF)](https://www.scga.org/pdfs/Rules%20of%20Handicapping_9.1_24092019_DRAFT.pdf)
- [R&A — Rules of Handicapping definitions](https://www.randa.org/en/roh/definitions)
- [North Shore GC — course tour](https://www.northshoregolfclub.co.nz/course-tour) (see the warning above)
- [Royal Auckland & Grange — course tour](https://raggc.com/course/course-tour/)
- [Boulcott's Farm — Summerset Six](https://www.boulcottsfarmhgc.co.nz/summerset-six-and-driving-range)
- [St Andrews Links — getting here (clubhouse locations)](https://extranet.avian.co.uk/SAL/static-templates/getting-here.html)
- [Golf Business News — Links Trust takes over Craigtoun](https://golfbusinessnews.com/news/courses/st-andrews-links-trus-takes-the-reigns-at-craigtoun/)
- [Arccos — how do I request a course combination?](https://support.arccosgolf.com/hc/en-us/articles/360036138932-How-do-I-request-a-course-combination)
- [Garmin forum — playing 27 and 36 hole courses](https://forums.garmin.com/outdoor-recreation/golf/f/approach-s70/388789/playing-in-27-and-36-hole-courses)
- [SwingU — add the back nine holes of a course](https://help.swingu.com/article/49-can-i-setup-two-9-hole-courses-as-an-18-hole-round)
