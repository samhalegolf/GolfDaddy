# Practice Data — five jobs assessed against the code, and a plan
2026-08-13 · Clarity Caddy

Source documents: Practice Data Processing Architecture, Photo Scanner, Practice
Data Email Routing, CSV Input Testing, CSV Graph Regression Testing.

---

## The bet

The CSV/structured pipeline is the one that has to be **solid** — it's
deterministic, testable, and it's what every graph downstream is built on. The
photo scanner stays **beta** on purpose: it is allowed to be imperfect, as long
as it is honest about being imperfect and fails cleanly. This plan spends its
effort accordingly — most of it on making the CSV path provably correct, and only
enough on the scanner to make it behave like a beta feature rather than a broken
one. The scanner logic itself is not touched.

## The one-paragraph version

The structured-data half of this is in better shape than the documents assume:
the CSV parser is already one shared file running both in the browser and on the
server, with a provenance model that records what it doesn't know instead of
guessing. The photo scanner is the opposite — it works, but it runs entirely in
the phone, narrates its internals to the user, and dies if the page goes away.
The real problem underneath both is that **there are two practice pipelines with
two different row shapes and two different storage tables**, and the newer,
better one isn't the one the app actually uses. Fixing that is the job that
makes the other four cheap.

---

## Job by job

### 1. Practice Data Processing Architecture — partly done, one big gap

**Already server-side and good.** `scripts/gd-practice-parser-core.js` is a
single portable file loaded two ways: by `index.html` in the browser and by
`functions/practice-data-parser.js` on Netlify (pinned into the bundle via
`included_files` in `netlify.toml`). Email CSV attachments are parsed server-side
today and written to `practice_import_batches` / `practice_native_shots`. The
unit/date/provider provenance model — record the gap, never infer from magnitude
— is exactly the "stable contract" thinking the architecture document asks for.

**Still in the app, and shouldn't be.**

- The photo scanner (Tesseract in the webview, driven from `gd-app-core.js`).
- The frequently-tuned quality gates: `scripts/gd-launch-monitor-data.js` holds
  the dynamic gate, custom gates, source-trust parsing and tolerance settings.
  These are precisely the "frequently tuned validation" the document names, and
  today they ship inside an App Store release.

**The boundary the document describes doesn't exist yet.** There are two
"Clarity-native" shapes in the codebase:

| | Clarity-native rows | Launch-monitor payload |
|---|---|---|
| Produced by | parser core (paste, email CSV) | photo scan, file upload, legacy text capture |
| Row shape | `{shotId, club, carryDistance, offlineDistance, …}` | `clubGroups[].metrics[]` via `gdLmMetricForKey` |
| Stored in | `practice_native_shots` (Supabase), `gd_native_practice_shot_data_v1` (local) | `shot_library_batches` (Supabase), launch-monitor store (local) |
| Used by the app | almost nowhere — only the admin Practice Data panel and the route audit | everything: shot library, cluster analysis, bubble |

The better pipeline is the one nothing consumes. **Decision taken: converge on
Clarity-native.**

### 2. Photo Scanner — works, but fails four of the document's five requirements

**Its own ingestion system:** effectively yes. The pure logic is isolated in
`scripts/clarity-table-ocr.js` (+ `clarity-table-ocr-pixels.js`), with headless
tests, a ground-truth fixture and a documented adapter. That separation holds.

**Beta marker:** not present anywhere.

**Generic user-facing status:** not met. The job's `checkpointText` is shown to
the user verbatim, and it currently says things like:

> Splitting columns · Reading boxes 12/57 · Cutting + naming strips · Reading the
> offcut (club + summary rows) · Reading strips · Reading strip 3/11 · Deep
> scanning direction markers · Deep scan strip 2/5

That is the internal pipeline read out loud.

**Processing continues if the user leaves:** no. `gd_practice_import_job_v1`
persists the *record* of the job in localStorage, but the work itself is an
async chain inside the page. Leave, and it stops; come back and you get "Import
stopped before it completed."

**Stall / timeout:** partial. There's a 9s timeout per OCR call and a `finally`
fail-boundary so the UI can't hang forever, but no whole-job stall threshold and
no defined retry path.

Note on scope: **the scanner logic itself is not being touched by this plan.**
That means "keeps processing while you're away" can't be fully delivered — see
Phase 4 for what is honestly achievable without moving it to the server.

### 3. Practice Data Email Routing — the routing part is already built

`functions/practice-email-intake.js` already does what the routing section
describes: `laneForAttachment()` sends `.csv/.txt/.tsv` and `text/*` down the CSV
pathway, images down the photo pathway, `.json` to the structured pathway, and a
CSV-shaped email body with no attachment is detected and treated as an
attachment. Email really is the one place the two systems meet. Nothing to do
here.

Two real gaps:

**The address is not simple.** Today it's
`practice+<slugged profile UUID>@claritygolf.app` — a plus sign and thirty-odd
characters of hex. It's also *derived*, not stored, which means it can never be
changed or revoked.

**The photo lane is a dead end.** An emailed photo is uploaded to the
`practice-photos` bucket and a `needs_review` batch row is created with zero
rows — and then nothing processes it. The only route forward is the app pulling
the image back down to the phone and running the local scanner
(`gdPracticeLoadEmailPhotoBatch`). Emailing a photo from a laptop and having it
appear on the phone does not currently work end to end.

**Security worth naming now.** Identity comes only from the address itself.
Making the address simple and human makes it guessable, so the security that
"stays behind the scenes" has to become real: verified senders per player, and
quarantine for anything else.

### 4. CSV Input Testing — a good foundation, aimed slightly wrong

`dev/practice-parser-parity.test.js` is genuinely strong: 24 inline fixtures,
run through both the server and browser bindings, asserting they agree row for
row, plus unit-system, session-date, provider and validation behaviour.

Two things stop it being the regression library the document asks for:

1. **It asserts agreement and properties, not results.** There is no
   "this file must produce exactly these Clarity-native rows" anywhere. The
   document's pass condition — an expected result per fixture — isn't met.
2. **It doesn't run in CI.** `.github/workflows/structural-smoke.yml` runs about
   70 suites; neither this one nor any of the four `table-ocr` suites are in it.

Coverage against the document's variation list, read against the parser:

| Variation | Status |
|---|---|
| Column names / ordering | covered |
| Extra / missing optional columns | covered |
| Metres vs yards, units in headers | covered, and covered well |
| Numbers as text, decimals, blanks, quoted | mostly covered |
| Different delimiters | covered (`,` `\t` `;` `\|`) |
| **Metadata above the table** | **not handled** — line 1 is assumed to be the header |
| **Duplicate / summary / malformed rows** | **not handled** — no AVERAGE/STD DEV filter on the CSV path (the photo path has one) |
| Different club naming conventions | thin — `inferClubValue()` is a narrow regex; "Pitching Wedge", "3 Hybrid", "P/W" are a coin toss |
| Multiple clubs vs one per file | works implicitly, untested |
| **Left/right and degree/lateral forms** | **not handled** — `6.2R`, `L 4.2`, `4.2°` all fail `asNumber()` and error the row |

The three bold rows are real parser work, not just missing tests.

### 5. CSV Graph Regression Testing — blocked until the contract converges

The downstream chain exists and is headlessly testable:
native rows → `buildPracticeGateInput()` → shot library →
`gd-shot-cluster-analysis.js` (`analyzeStore`, `analyzeBubbleFit`,
`analyzeClusterHunter`) → `calculateBubbleProfile()` in `bubble-engine.js` →
the play surface. `dev/my-bubble-aim.test.js` already proves you can drive that
headlessly.

But the middle seam is exactly the one that's broken: Clarity-native rows don't
flow into the shot library, so "generate → import → convert → graph → compare"
can't be written end to end today. **This job has to come after the
convergence.**

---

## The plan

### Phase 0 — protect what already works *(half a day)*

- Add `practice-parser-parity.test.js` and the four `table-ocr` suites to
  `structural-smoke.yml`. They pass today and nothing guards them.
- Add an aggregate `npm run test:practice` script.

### Phase 1 — the CSV regression library *(Job 4)*

Do this first: it's the net for everything after it.

- `dev/fixtures/practice-csv/<case>/input.csv` + `expected.json` — expected being
  the Clarity-native rows plus the batch's provenance (unit system, source, session
  date, provider, gaps).
- `dev/practice-csv-regression.test.js` — parse → build batch → diff against
  expected, printing a per-case diff.
- Generate the variation set from the document, one family per bullet. Generated
  in bulk, but every `expected.json` gets eyeballed once and then frozen.
- The three known gaps get fixtures written to what *should* happen, then the
  parser work follows: skip metadata preambles (find the header line rather than
  assuming line 1), parse direction suffixes (`4.2L`, `L 4.2`), reject summary
  rows, and share club-name normalisation with the alias registry.

### Phase 2 — one contract *(Job 1)*

- Reverse the adapter: the scanner's output becomes **Clarity-native rows**, not
  `clubGroups`. The shot library becomes a consumer of that contract rather than
  a second definition of it.
- Delete `gdBuildLaunchMonitorTextCapture` and route file upload through the
  parser core. It's the same job the paste lane already does, done worse — its own
  code comments admit it ("not native storage yet").
- Settle on one store. Either the shot library becomes a projection of
  `practice_native_shots`, or the sync moves over; either way one of
  `shot_library_batches` / `practice_native_shots` stops being written. Small spike
  first, then commit to it.
- Add a contract test: every ingestion path (paste, file, email CSV, photo scan)
  produces rows that pass the same validator.

Once this lands, the emailed-CSV path reaches the app without the manual "load
email batch" step, and the tuned gates can move server-side without breaking a
second row shape.

### Phase 3 — email address and sender trust *(Job 3)*

- Name-based local part on a dedicated subdomain:
  `samhale@practice.claritygolf.app`, with a numeric suffix only when a name is
  already taken.
- **Store the address**, don't derive it: a `practice_email_addresses` table
  (address, player id, account id, active, created) so it can be changed or
  revoked. Derived addresses can't be.
- Behind the scenes: verified senders per player (their sign-up address by
  default, more addable in the app), unknown senders land in a quarantined batch
  the player confirms, plus a per-address rate limit.
- Lane routing stays exactly as it is.

### Phase 4 — make the scanner behave like a beta feature *(Job 2)*

No changes to the scanner itself. The goal here is not accuracy — it's that a
beta feature says it's beta, speaks plainly, and fails cleanly instead of
hanging.

- Beta marker on the scan entry point.
- One mapping function from internal checkpoint → user-facing text
  (Scanning → Reading shot data → Preparing your data → Almost finished). The
  internal text keeps flowing, unchanged, to the admin/Studio debug feed.
- A whole-job stall threshold (~90s without the checkpoint moving) → fail cleanly
  with "Scan stopped — try again" and a one-tap retry from the stored photo.
- Leaving the page: store the photo first, mark an interrupted job *interrupted*
  rather than *failed*, and offer one-tap resume on return.

Being straight about this: with the scan running in the phone, work cannot
continue while the user is away. This phase makes leaving *safe* and returning
*cheap*. Genuinely continuing in the background needs the scan to run on the
server — deferred, and worth revisiting once Phase 2 has given it a stable
contract to write into.

### Phase 5 — graph regression *(Job 5)*

- A small seeded generator module for the dataset shapes: far left/right clusters,
  tight central, very wide, strong diagonal, multiple clusters, outliers,
  short/long spread, varying shot counts, low-variation and chaotic. Deterministic
  — no randomness inside the test.
- Chain: generate → import as Clarity-native → cluster analysis → bubble profile.
- Assert on meaning, not pixels: sign and rough magnitude of the centre offset,
  width/depth ordering across datasets, outlier handling, dispersion moving the
  right way — plus frozen snapshots for two or three canonical sets.

---

## Order and why

```
Phase 0 ──► Phase 1 (CSV library) ──► Phase 2 (one contract) ──► Phase 5 (graph)
                                  └──► Phase 3 (email)   ─┐
                                  └──► Phase 4 (scanner UX) ─┴─ independent, slot anywhere
```

Phase 1 before Phase 2 because you shouldn't converge two pipelines without a
regression net. Phase 2 before Phase 5 because a graph test needs one contract to
test. Phases 3 and 4 don't depend on the others.

## Things to keep in mind

- `scripts/gd-app-core.js` is 24,000 lines and owns the scanner, the job system
  and the practice UI. Phases 2 and 4 both land in it — keep them separate.
- Nothing in the practice or scanner area currently runs in CI.
- `practice_native_shots.hit_at` is deliberately zone-less (monitors export
  wall-clock local time). Keep that in the fixtures and don't "fix" it.
- The parser's refusal to guess — units from magnitude, dates from `07/08/2026` —
  is load-bearing. Fixtures should lock that behaviour in, not erode it.
