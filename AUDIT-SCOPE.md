# GolfDaddy — Audit Scope

Findings from reviewing the course-play resolver / Claude hole-labeler diff
(committed as `56cccc7`).

> **Revision note (v3).** v1 claimed a cached Overpass response starves the Claude
> labeler and made that the headline. **That was wrong** — see §2a, retained as a
> retraction. v3 identifies the actual root cause (§0), traced from the reported
> symptoms: *"loading screen was messy, then the hole matcher didn't fire, then it
> fired heaps."* Anything working from v1 or v2 should re-read §0.

---

## 0. ROOT CAUSE — the labeler's identity is a moving map centre

**One bug produces all three reported symptoms.** The Claude labeler identifies a
course by *rounded map coordinates*, and for exactly the courses that need Claude,
those coordinates come from **the live Leaflet viewport**.

### The chain

`guideCoursePoint()` (`pin-lock.js:1433`) picks the Overpass query centre with a
three-tier fallback:

```js
const lat=Number(course?.courseLat??course?.lat??course?.latitude);   // 1. stored course point
if(Number.isFinite(lat)&&Number.isFinite(lng))return {lat,lng};
const finder=courseFinderPoint(course);                              // 2. finder point
if(finder)return finder;
return mapSessionCenter(courseObj());                                // 3. ← map.getCenter()
```

`mapSessionCenter()` (`pin-lock.js:160`) terminates in `map.getCenter()` — the
live map viewport. A course with **no stored lat/lng** therefore queries Overpass
around *wherever the map is currently looking*. That is precisely the population
of courses that are unmapped and need Claude.

That centre is embedded in the Overpass URL. The labeler parses it back out of
the URL (`centerFromUrl`, `gd-claude-hole-labels.js:61`) and derives its entire
identity from it:

```js
function storeKey(center) {
  return STORE_PREFIX + center.lat.toFixed(4) + ',' + center.lng.toFixed(4);   // 4dp ≈ 11 metres
}
```

**Pan or auto-frame the map 11 metres and the labeler believes it is looking at a
different course.**

### How that produces each symptom

| Symptom | Mechanism |
|---|---|
| **"Fired heaps"** | `pendingKeys[key]` (`labeler:283`) is the duplicate-job guard. Keyed on the drifting key, it stops deduping — one new Claude job per Overpass fetch. `hasRecentEmptyLabelResult(key)` (`labeler:84`), the brake built specifically to stop re-firing, is keyed the same way and is equally defeated. |
| **The sustaining loop** | Claude writes labels under key A. Resolver retries automap with `fresh:true` → new Overpass fetch → map has moved → key B → `readLabels(keyB)` → `null` → holes still look unlabeled → **fires another job**. Labels never reach automapper, so the resolver falls back, so the user retries, so it fires again. Self-sustaining, and it bills real Claude jobs. |
| **"Messy loading screen"** | Multiple concurrent resolver attempts each driving `updateCourseLoading` with their own progress values (62, 74, …). |
| **"Didn't fire"** | Genuinely the `labeling`/`generating` bug: the resolver refused to wait on a generate-mode job, so it looked like nothing happened. **`56cccc7` fixed this half.** Keep that commit. |

### The half-fix already in the tree

`resolutionKeyFor()` (`labeler:177`) reaches into `window.__gdCoursePlayResolverActive.key`
to borrow the resolver's *stable* course/hole key, which makes
`pendingResolutionKeys` dedupe correctly. But pin-lock **deletes that global when
the attempt ends** (`pin-lock:3780`), after which `resolutionKeyFor` falls back to
the drifting `storeKey`. So dedupe works *only while a resolver attempt is in
flight* — a narrower window, the same collapse.

It is also the same authority smell one level down: the labeler reaching into the
resolver's global to borrow an identity it should have been **handed**.

### Two key spaces for one thing

- pin-lock caches guides by `courseId` / name slug — `guideCacheKey()` (line 1441). **Stable.**
- the labeler keys everything by rounded lat/lng — `storeKey()`. **Drifting.**

Same course. Two identities. They disagree. That disagreement *is* the bug.

### The fix

**Identity must be handed in by the component that has it, not reverse-engineered
from a URL regex against a moving map.** `center` stays as a *query parameter*; it
stops being the *identity*.

- **Minimal (shippable now, independent of §2):** key the labeler's `pendingKeys`,
  `pendingResolutionKeys`, and label store by `courseId` rather than `storeKey`.
  This alone kills the loop.
- **Structural (§2c):** the callable API takes `courseKey` as its first field,
  making the drift impossible to reintroduce.

This promotes §2 from "code quality" to **the actual fix**, and it is now the top
priority. The 2s grace period in `56cccc7` should be removed as part of it (see §2b).

---

## 1. Nothing owns the GPS screen state — `document.body.classList` does

*(Verified directly. Stands. Keep out of the resolver work.)*

**The intended owner exists.** `setShellLayer(layer)` (`index.html:30431`) is a
clean state machine: toggle exactly one of `shell-home` / `shell-gps` /
`shell-module`, clear the GPS sub-flags on exit. `enterGpsModule()` uses it correctly.

**~30 call sites bypass it** — in `index.html`, `gd-course-library-pin-lock.js:3637`,
and `clarity-player-settings.js:120`.

**Three classes encode one fact.** `shell-gps`, `gdGpsActive`, `gps-active` are
always written together and always read together:

```js
document.body.classList.contains('shell-gps') ||
document.body.classList.contains('gdGpsActive') ||
document.body.classList.contains('gps-active')
```

**254 references to `gdGpsActive`.** Nobody trusts any writer to have set all
three, so every reader accepts any one. The OR *is* the bug report: there is no
state, only a rumour, and readers take a vote.

**Duelling timers.** `index.html` removes the same four GPS classes on a
`setTimeout(…, 0)` **and** again on a `setTimeout(…, 80)` — someone losing a race
and increasing a delay until it stopped reproducing. (276 `setTimeout` calls in
`index.html`; worth sweeping for others of this shape.)

**Fix:** collapse the three flags to one; make `setShellLayer` (or a small
`gdShell` module) the only code permitted to touch them; route every direct
`classList.add('shell-gps', …)` through it.

```
grep -rn "classList\.\(add\|remove\)([^)]*\(shell-gps\|gdGpsActive\|gps-active\)" \
  --include=*.js --include=*.html . | grep -v dist/
```

---

## 2. The resolver doesn't resolve — the labeler self-triggers

**Stated design:** automapper tries → if it fails, Claude labeler tries → on
success it hands automapper something to consume.

**Actual mechanism:** the labeler is never *invoked* by the resolver. It
monkey-patches `window.fetch` (`labeler:500`), watches for Overpass guide queries,
and calls `requestLabels()` from inside the response handler. The resolver can't
call it and can't await it — it can only read `window.gdClaudeHoleLabels.status`
and guess. §0 is the direct consequence: a component that triggers off a URL has
to derive identity from that URL.

| Code in `56cccc7` | Exists because |
|---|---|
| `claudeLabelerWaiting()` sniffing status strings | no handle to ask |
| `waitForClaudeLabelerStart()` polling every 100ms | no promise to await |
| `resolutionKey` + `attemptToken` correlation | the global might belong to a *different* course |
| stale-`failed` short-circuit | same |

**In fairness:** the interceptor is a sane *retrofit*. It rewrites the Overpass
payload with labels spliced in, so automapper consumes normal-looking OSM data and
needs zero knowledge Claude exists. **Keep that.** The defect is that it *also*
owns triggering and identity.

### 2a. RETRACTED: "the cache starves the labeler" *(v1 headline — false)*

1. **The localStorage cache read is dead code.** `cachedOsmGuideBundle()`
   (`pin-lock:1520`) is `return null;` — hardcoded since the initial commit
   (`1d996b2`). The branch at line 1532 never fires; the `setItem` at 1546 writes
   a cache nobody reads.
2. **The resolver already forces a fresh fetch.** The only live short-circuit is
   in-memory `mapperOsmGuideMemory` (line 1530), gated on `!opts.fresh` — and the
   resolver passes `fresh: opts.fresh !== false` (line 3714, defaults **true**).
   Nothing in the tree passes `fresh:false`.

Cached courses do **not** prevent Claude from being triggered. Retained here so
nobody re-derives the wrong conclusion.

### 2b. Deliberate skips (real, but not the bug)

`pendingKeys[key]` early-return · `hasRecentEmptyLabelResult` ·
`labeledCount >= 9 && requestedHoleLabeled` · `NS.backend` unset ·
`requestGeneration`'s `if (!courseName) return`.

In each, Claude correctly never starts — and the 2s grace period from `56cccc7`
now **delays the fallback by up to 2s for nothing**. Remove it as part of §2c.

### 2c. Target design

Keep the interceptor for **injection**. Move **triggering and identity** to an
explicit, awaitable call:

```js
const result = await window.gdClaudeHoleLabels.requestLabels({
  courseKey,        // ← stable identity, handed in. Fixes §0.
  center,           // ← query parameter only. No longer identity.
  elements,
  attemptToken,
  timeoutMs
});
// { status: "labelled" | "not-needed" | "failed" | "unavailable",
//   courseKey, labels, reason }
```

Two requirements not visible in the shape:

- **In-flight dedupe must return the *existing* promise** for a `courseKey` already
  running. Returning `not-needed` silently drops the second caller — today's
  `pendingKeys` bug in a nicer coat.
- **Caller-supplied timeout.** Jobs run 1–3 minutes; the resolver, not the labeler,
  owns wait policy.

Deletes: `claudeLabelerWaiting()`, `waitForClaudeLabelerStart()`, the 100ms poll,
the 2s grace period, `resolutionKeyFor()`'s reach into
`__gdCoursePlayResolverActive`, the stale-failure short-circuit.

**Acceptance test:** open a course with **no stored lat/lng** whose OSM holes carry
no hole numbers. Pan the map during resolution. Then:

1. automapper fails normally;
2. the resolver *explicitly* invokes Claude — **exactly once**, despite the map
   having moved;
3. the labelled result is fed back to automapper and applied;
4. the resolver completes without reading a global status string.

Point 2 is the regression guard for §0. Assert on Claude job count, not just
success.

---

## 3. Shared-mutable-global as the coordination mechanism

§0, §1 and §2 are the same pattern: **104 distinct `window.gd*` globals** across
`scripts/`. A shared mutable global that no component owns, read defensively by
everyone, coordinated with polling, OR-ing, and timeouts.
`gd-namespace.js` exists and looks like an abandoned attempt at fixing this.

---

## 4. Housekeeping

- **`index 2.html` is tracked** — 42,454 lines vs `index.html`'s 56,031, and they
  differ. A *stale* Finder duplicate, committed in `a0edfeb "hshs"`. Delete it
  before someone fixes a bug in the wrong file.
- **`index.html` is 56,031 lines** with heavy inline `<script>`. This is why §1 is
  hard to reason about.
- **`dist/` is committed** and stale. *Appears* harmless — `netlify.toml` sets
  `publish = "dist"` and `command = "npm run build:netlify"` → `clarity-deploy-build.js`,
  which `rmSync`s and regenerates `dist/` from source. **Verify independently
  before removing `dist/` from source control** — the one place where being wrong
  breaks production. Also tracked in there: `dist/.fuse_hidden0000001200000002`,
  `dist/__wtest`.
- Dead code: `cachedOsmGuideBundle()` stub + orphaned `setItem` at `pin-lock:1546`.

---

## Order of work

1. **§0 minimal fix** — key the labeler by `courseId`, not `storeKey`. Kills the
   duplicate-job loop. Small, shippable, independently verifiable.
2. **§4 housekeeping** — minutes; makes everything after it greppable. Codex to
   re-verify the Netlify build itself.
3. **§2c control inversion** — makes §0 structurally impossible to regress, and
   deletes more code than it adds. Removes the 2s grace period.
4. **§1 shell ownership** — biggest win for GPS flakiness, ~30 sites in a 56k-line
   file. Do last, keep separate from steps 1–3: they overlap in GPS behaviour and
   combining them makes regressions unattributable.

`56cccc7` stays. It fixed the "didn't fire" half.
