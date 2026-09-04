# Marketing snapshot machine

Three screenshots per golf course, taken from the real play screen rather than mocked up.

| frame | what it shows |
|---|---|
| `01-pre-lock.png` | the hole framed with the start pill up — nothing placed yet |
| `02-head-to-tee.png` | Head To the Tee pressed on a par 4 or 5, bubble on the shot target |
| `03-approach.png` | placed 130m out, bubble on the green, then nudged slightly up and left |

Two halves, and the split is not arbitrary. **Studio → Marketing → Snapshot
Machine** decides *what* to shoot. **`marketing/run-snapshots.mjs`** takes the
pixels. A browser page cannot screenshot itself at a device scale factor it is
not being displayed at, and these are 1170×2532 — a 390×844 phone layout at
DPR 3 — so the camera has to be Playwright driving headless Chromium.

## Once

```bash
npm run demo:install
```

```bash
npm run marketing:login
```

`marketing:login` opens a real browser at the site, waits for you to sign in,
and saves `marketing/.auth.json`. The play screen reads `/api/course-package`
with a bearer token, so a signed-out run would shoot a bare OSM map. That file
holds a live session — it is gitignored, and deleting it signs the runner out.

## Every run

1. Open the Studio at `/studio/`, go to **Marketing › Snapshot Machine**.
2. **Add a course** — this opens the real course search. Pick one, repeat for
   as many as you want. The basket persists across reloads.
3. **Build selected courses** if they are not already mapped. Six steps per
   course, in dependency order, all of them the same production jobs the Course
   Database buttons queue: map from OSM → scorecards → collect extra objects →
   capture imagery → apply visual treatment → refine shapes. Steps already
   satisfied are skipped, so a fully built course walks straight through.
4. **Plan selected courses.** The machine reads the built package back and
   chooses two holes. Override anything you disagree with.
5. **Download snapshot-plan.json** into this folder.
6. ```bash
   npm run marketing:snapshots
   ```

Output lands in `marketing-output/<timestamp>/` — one folder per course, plus
`contact-sheet.html` (open it; that is the thing to review) and
`run-report.json`.

```bash
npm run marketing:snapshots -- --course te-arai-links
```

`--headed` watches it happen. `MARKETING_BASE_URL` points it somewhere other
than production.

## How the holes get chosen

Signature-hole evidence first, terrain second.

**Signature hole.** `/api/marketing-hole-intel` runs one web search per course
through the same Brave/Google-CSE client the scorecard resolver uses, and reads
**titles and snippets only** — nothing is fetched, no club's page is scraped.
It extracts hole numbers that sit within 120 characters of signature-hole
language, weighted by how strong the phrase is ("most photographed" > "signature
hole" > "famous" > "toughest") and by how many separate results agree. A
confidently named hole outranks any terrain score a course can produce; a weak
mention only breaks ties. Admin-gated, and skipped entirely if no search key is
configured — which is the ordinary case, and not a failure.

**Terrain variance**, the fallback and the usual answer:

- the **tee-shot** hole is the par 4 or 5 whose *corridor* carries the most
  varied terrain — three kinds of thing (bunker, water, fairway) beats many of
  one kind, water outranks sand, and a dogleg counts for a lot;
- the **approach** hole is the one with the most varied *green surrounds* —
  greenside bunkers, a fronting pond, a traced green outline;
- they are never the same hole where a course has two.

Both live in `scripts/gd-marketing-snapshot-core.js`, which is pure and loaded
by the Studio page *and* by this runner — the Studio proposes holes so you can
override them, and the runner has to reach the same holes hours later with no
Studio open. `node dev/marketing-snapshot-core.test.js` pins the rules.

**Units** come from where the course is: yards in the US, Canada, the UK and
Japan; metres everywhere else. Genuinely mixed regions default to metres and
show the choice in the Studio so you can flip it.

## What the runner actually does

It uses the app's own signals, not synthetic drags across a map:

- placement is `marshal.signal("PLACED", {point})`
- the nudge is `marshal.signal("AIM_DRAGGED", {point})`, where the point comes
  from reading `#aimBubble`'s real screen box, offsetting it 26px left and 38px
  up, and asking `painter.latLngAt()` what that is — exactly what a finger drag
  does. Offsetting a lat/lng directly would be wrong on a rotated shot-up frame,
  which every one of these is.
- Head To the Tee is a real click on the real button, because that one *has* a
  button.

Geolocation is deliberately denied. A fix would put the Marshal into Live flow
and take the screen off the placement these frames are built from — and there is
no fix to be had in a data centre anyway. Preview is the honest state for a
course nobody is standing on.

Each course gets a fresh browser context, so the units seed lands before any
script runs and one course's scorecard/bag state cannot leak into the next
course's frames.
