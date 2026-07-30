/* The app consumes frames. It does not make them, and it never hangs waiting.
 *
 * Framing and flattening belong to the studio and the server worker. The app plays
 * on published cloud frames, and on the live map when there is no frame. Three
 * things have to hold together for that to be true, and each failed once:
 *
 *   1. No local shutter during play. gdRenderCoursePlayHoleFrame used to fall
 *      through to buildCaptureManifest when neither a cloud nor a stored manifest
 *      matched - a ~320-tile fetch composited on the phone and written to
 *      localStorage at ~300KB per hole. Five holes of that plus the course library
 *      exceeds a ~5MB WKWebView budget, iOS evicts, and the key it took was the
 *      in-progress round. Its two sibling call sites guarded correctly; this one
 *      did not, and the asymmetry is the whole defect.
 *
 *   2. A hole with no frame gets the live map. The stylesheet already assumed this
 *      - every #map suppression rule carries :not(.gdCapturedFrameUnavailable) -
 *      but the hard gate is :not(.gdGpsLiveMapAllowed) and nothing granted it, so
 *      an unpublished hole was a black screen. The grant must read a body class
 *      set by the frame owner, never a reason string chosen by the caller, or any
 *      caller can unlock the live map by naming itself.
 *
 *   3. The hole-switch transition is bounded. Its mask hides #map and covers the
 *      screen, and only gdEndGpsHoleSwitchTransition could take it down - which
 *      needs a manifest matching the active hole. With (1) in place more holes
 *      reach play with no manifest at all, so an unbounded mask would strand them
 *      behind "Loading Hole N frame..." until relaunch.
 *
 * Asserted against source: the surrounding files are 120KB+ of browser globals and
 * DOM, per the convention in captured-frame-partial-flatten.test.js. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CAMERA = fs.readFileSync(path.join(ROOT, "scripts", "inline", "gd-captured-hole-frame-camera-v19.js"), "utf8");
const OWNER = fs.readFileSync(path.join(ROOT, "scripts", "inline", "gd-gps-play-runtime-owner-v1.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "styles", "inline", "gd-gps-play-runtime-owner-v1-css.css"), "utf8");

/* Whitespace is not load-bearing here and the sources are tab-indented and deeply
   nested, so compare on a collapsed copy rather than on exact formatting. */
const flat = (s) => s.replace(/\s+/g, " ");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test("the course-play pipeline refuses to shutter during play", () => {
  const region = flat(CAMERA).match(
    /var cloudManifest=cloudPublishedSurfaceManifest[\s\S]*?if\(opts\.cacheOnly\)return true;/
  );
  assert.ok(region, "the cloud-then-local pipeline block must still be identifiable");
  const slice = region[0];
  const guard = slice.indexOf("capturedGpsPlayActive()");
  const build = slice.indexOf("buildCaptureManifest(");
  assert.ok(guard !== -1, "the pipeline must consult capturedGpsPlayActive before capturing");
  assert.ok(build !== -1, "the off-play capture path should still exist for the studio surface");
  assert.ok(
    guard < build,
    "the guard must come BEFORE buildCaptureManifest - after it, the tiles are already fetched " +
    "and written, which is the ~300KB-per-hole leak this prevents"
  );
});

test("every play-reachable capture site is guarded the same way", () => {
  /* ensureCurrentCaptureManifest and fitCaptured were already correct; the pipeline
     was not. Locking them together stops a future call site reintroducing the
     asymmetry that caused this.

     The visual-lock site is deliberately exempt: it passes backgroundCapture:true,
     which is the studio authoring request driven by the visual engine, not a play
     path. Keying the exemption off that flag rather than off a position in the file
     keeps it principled - a new unguarded play capture cannot claim it without also
     declaring itself a background capture. */
  const sites = flat(CAMERA).split("buildCaptureManifest(bounds,");
  assert.ok(sites.length >= 4, "expected at least three bounds-driven capture sites");
  let guarded = 0;
  let authoring = 0;
  sites.slice(1).forEach((after, i) => {
    if (/^[^;]*backgroundCapture:true/.test(after.slice(0, 1400))) { authoring += 1; return; }
    assert.ok(
      /capturedGpsPlayActive\(\)[^;]*(missingCapturedManifest|return)/.test(sites[i].slice(-400)),
      "play-reachable capture site " + (i + 1) + " must be preceded by a capturedGpsPlayActive guard"
    );
    guarded += 1;
  });
  assert.ok(guarded >= 3, "expected three guarded play-reachable sites, found " + guarded);
  assert.strictEqual(authoring, 1, "expected exactly one background/authoring capture site, found " + authoring);
});

test("a hole with no frame is granted the live map", () => {
  assert.ok(
    /function gdGpsNoCapturedFrameForHole\(\)/.test(OWNER),
    "the grant must be a named predicate, not inlined at the use site"
  );
  assert.ok(
    /gdGpsLiveMapExplicitlyAllowed\(reason\)\{[\s\S]*?gdGpsNoCapturedFrameForHole\(\)/.test(flat(OWNER).replace(/ /g, "")) ||
    /gdGpsNoCapturedFrameForHole\(\)/.test(flat(OWNER).match(/function gdGpsLiveMapExplicitlyAllowed[\s\S]*?\}/)[0]),
    "gdGpsLiveMapExplicitlyAllowed must consult it, or the map stays hidden"
  );
});

test("the grant reads a body class, never a caller-supplied reason", () => {
  const fn = flat(OWNER).match(/function gdGpsNoCapturedFrameForHole\(\)[\s\S]*?\},false\); \}/);
  assert.ok(fn, "gdGpsNoCapturedFrameForHole must be findable");
  assert.ok(
    /classList\.contains\("gdCapturedFrameUnavailable"\)/.test(fn[0]),
    "it must read the class the frame owner sets"
  );
  assert.ok(
    !/reason/.test(fn[0]),
    "a reason string would let any caller unlock the live map by naming itself"
  );
});

test("the stylesheet's live-map gate still matches the grant", () => {
  assert.ok(
    /:not\(\.gdGpsLiveMapAllowed\) #map/.test(CSS),
    "the hard gate this grant exists to satisfy must still be the one in the stylesheet"
  );
  assert.ok(
    /:not\(\.gdCapturedFrameUnavailable\)/.test(CSS),
    "the suppression rules must keep treating an unavailable frame as an exception"
  );
});

test("the hole-switch transition arms a bounded timeout", () => {
  const m = CAMERA.match(/var HOLE_SWITCH_TRANSITION_TIMEOUT_MS\s*=\s*(\d+)/);
  assert.ok(m, "the timeout must be a named constant");
  const ms = Number(m[1]);
  assert.ok(ms > 0 && ms <= 15000, "an unbounded or very long mask is the hang this replaced, got " + ms);
  assert.ok(
    /gdBeginGpsHoleSwitchTransition\(hole,reason,token\)\{[\s\S]*?armHoleSwitchTransitionTimeout\(/.test(flat(CAMERA)),
    "beginning a transition must arm the timeout, or nothing bounds the mask"
  );
});

test("the transition timeout is not cancelled while the mask is still up", () => {
  /* clearHoleFrameLoading has callers that fire when the surface has merely
     RENDERED, which is before fitCaptured ends the transition. Clearing there
     would drop the safety net with the mask still on screen. */
  const fn = flat(CAMERA).match(/function clearHoleFrameLoading\(\)[\s\S]*?\}\); \}/);
  assert.ok(fn, "clearHoleFrameLoading must be findable");
  assert.ok(
    !/clearHoleSwitchTransitionTimer\(/.test(fn[0]),
    "clearHoleFrameLoading must NOT cancel the transition timer - two of its callers run " +
    "on render, before the transition has actually ended"
  );
});

test("legacy fat tile manifests are purged unconditionally", () => {
  /* The app authors nothing - automapper is server-side and objects come from the
     database - so every course-shaped key here is cache and there is no local
     original to protect. An earlier draft carried evictableStorageKeys' "keep
     anything not yet in the cloud" rule, which on a phone whose scans were never
     flagged as synced would have skipped precisely the keys worth deleting. */
  const fn = flat(CAMERA).match(/function gdPurgeLegacyFatFrames\(opts\)[\s\S]*?return result; \}/);
  assert.ok(fn, "gdPurgeLegacyFatFrames must be findable");
  assert.ok(
    !/cloudHydrated|pushed\[|keptUnsynced/.test(fn[0]),
    "the purge must not reintroduce a cloud-synced exemption - it would spare the fat keys"
  );
  assert.ok(
    /Array\.isArray\(m\.tiles\)&&m\.tiles\.length/.test(fn[0].replace(/ /g, "")) ||
    /Array\.isArray\(m\.tiles\)/.test(fn[0]),
    "only manifests still carrying a tile list are removed; a lean imagePath manifest is what renders"
  );
  assert.ok(/dryRun/.test(fn[0]), "a dry run must be available for inspecting a device before deleting");
});

test("the purge runs on native and reports what it reclaimed", () => {
  const src = flat(CAMERA);
  assert.ok(
    /GDNative&&window\.GDNative\.isNative[\s\S]{0,220}gdPurgeLegacyFatFrames/.test(src),
    "the purge must be gated to native and scheduled at boot"
  );
  assert.ok(
    /Purged legacy captured-frame manifests/.test(src),
    "it must report through ClarityErrorReporter - the device that needs this is a phone with no inspector"
  );
});

test("the purge runs once even though install() is re-entrant", () => {
  /* install() is called again by later layers during their own wire() passes, so
     a scheduler placed inside it fires once per call. On a device that meant six
     purges in six seconds: one did the work, five were no-ops. The guard has to
     be inside the function, not at the call site, or a future caller loses it. */
  const fn = flat(CAMERA).match(/function gdPurgeLegacyFatFrames\(opts\)[\s\S]*?return result; \}/);
  assert.ok(fn, "gdPurgeLegacyFatFrames must be findable");
  assert.ok(/purgeRan/.test(fn[0]), "the one-shot guard must live inside the function");
  assert.ok(/opts\.force/.test(fn[0]), "a forced pass must stay available for a device console");
  assert.ok(
    /opts\.dryRun!==true\)purgeRan=true/.test(fn[0].replace(/ /g, "")),
    "a dry run must not consume the one-shot guard"
  );
});

test("a no-op purge writes nothing to the 50-entry timeline", () => {
  /* That timeline is the only forensic record on a device. Five no-op purge
     entries evicted the events being investigated. */
  const fn = flat(CAMERA).match(/function gdPurgeLegacyFatFrames\(opts\)[\s\S]*?return result; \}/);
  assert.ok(
    /if\(doomed\.length\)safe\(function\(\)\{gdCoursePlayDebugEvent\("legacy-fat-frames-purged"/.test(fn[0].replace(/ /g, "")),
    "the debug event must be guarded on something actually having been removed"
  );
});

let failed = 0;
tests.forEach((t) => {
  try { t.fn(); console.log("  ok  " + t.name); }
  catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
});
if (failed) { console.error("app-frame-consumption failed: " + failed + " check(s)"); process.exit(1); }
console.log("app-frame-consumption passed: " + tests.length + " checks");
