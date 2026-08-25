/*
 * Studio Map Viewport, locked.
 *
 * The page is view-only and owns none of its own data: the provider list belongs to
 * gd-app-core.js, the course selection belongs to the real picker, and "what the scanner
 * would use" belongs to the imagery registry on the server. Every one of those is a boundary
 * that would be cheap to cross by accident - a hardcoded provider table here, a private
 * course search there - and each crossing is silent until the copy drifts from the original.
 * These assertions make the boundaries visible.
 *
 * The other half is the pick-only mode this page needed from the picker. That mode sits in
 * the middle of the app's own selection path, so it is pinned in both directions: it must
 * exist, and it must not touch the player's recents or the mapping pipeline.
 *
 * Static source checks + one sandboxed registry load, in the style of dev/studio-wiring.test.js.
 *
 * Run: node dev/studio-map-viewport.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const PAGE = "scripts/studio/courses/map-viewport/map-viewport-page.js";

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }

const page = read(PAGE);
const core = read("scripts/gd-app-core.js");
const picker = read("scripts/inline/gd-course-picker-search-v2.js");
const shell = read("scripts/studio/studio-shell.js");
const adminDb = read("scripts/studio/gd-admin-course-db.js");
const source = read("index.html");

/* ---------- the page registers where the shell will find it ---------- */

test("the page registers itself under GDStudioPages[\"map-viewport\"]", () => {
  assert.ok(
    page.includes('window.GDStudioPages["map-viewport"] = render'),
    "the shell renders a page by looking up window.GDStudioPages[record.id] — nothing else finds this file"
  );
});

test("the page is studio-only in index.html", () => {
  const re = new RegExp('data-gd-surface="studio"[^>]*src="' + PAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  assert.ok(re.test(source), "map-viewport-page.js is not marked data-gd-surface=\"studio\"");
});

function loadRegistry() {
  const code = read("scripts/studio/studio-registry.js");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "studio-registry.js" });
  return sandbox.window.GDStudioRegistry;
}

test("the registry knows the page and the nav reaches it", () => {
  const registry = loadRegistry();
  const record = registry.get("map-viewport");
  assert.ok(record, "no registry record with id \"map-viewport\"");
  assert.strictEqual(record.parent, "courses", "Map Viewport should sit under Courses");
  const courses = registry.navTree.filter((entry) => entry.id === "courses")[0];
  assert.ok(courses && (courses.children || []).indexOf("map-viewport") >= 0,
    "map-viewport is not in the Courses nav children — the page would exist with no way to reach it");
});

/* ---------- boundary 1: the provider list is borrowed, never copied ---------- */

test("gd-app-core publishes the live provider list and its layer builder", () => {
  assert.ok(core.includes("window.GDMapSources={"), "gd-app-core.js no longer publishes window.GDMapSources");
  ["list:mapSources", "buildLayer:gdBuildBaseLayer", "keyValue:mapSourceKeyValue", "covers:mapSourceCovers", "ready:mapSourceReady"]
    .forEach((snippet) => {
      assert.ok(core.includes(snippet), "window.GDMapSources is missing: " + snippet);
    });
});

test("the page reads providers through GDMapSources and hardcodes none of them", () => {
  assert.ok(page.includes("window.GDMapSources"), "the page does not consult window.GDMapSources");
  /* A tile template or an endpoint host in this file means a second provider list has started
     growing here, which is exactly the drift GDMapSources exists to prevent. */
  assert.ok(!/https?:\/\/[^"'\s]*\{z\}/.test(page), "a tile URL template appears in the page — providers must come from GDMapSources");
  ["basemaps.linz.govt.nz", "ibasemaps-api.arcgis.com", "tile.openstreetmap.org", "imagery.nationalmap.gov"]
    .forEach((host) => {
      assert.ok(!page.includes(host), "provider endpoint hardcoded in the page: " + host);
    });
});

test("the page renders the active source's attribution", () => {
  /* CC BY on LINZ and CC BY-SA on Queensland make the credit a licence condition, not a
     courtesy — and this page displays those tiles. */
  assert.ok(page.includes("source.attribution"), "the viewport does not render the active source's attribution");
});

/* ---------- boundary 2: the scan answer comes from the server registry ---------- */

test("the scan-source endpoint exists, is registered, and leaks no credentials", () => {
  const fn = read("functions/imagery-source.mjs");
  assert.ok(fn.includes('from "./lib/gd-imagery-sources.mjs"'),
    "the endpoint must read the real registry — a copy of the table would drift from what the scanner does");
  assert.ok(fn.includes('path: "/api/imagery-source"'), "the function does not declare its /api path");
  assert.ok(read("netlify.toml").includes("/api/imagery-source"), "no /api/imagery-source redirect in netlify.toml");
  /* resolveEndpoints returns resolved endpoints AND the api key. publicView is an allow-list
     precisely so a field added there later defaults to hidden. */
  assert.ok(fn.includes("function publicView(source)"), "the endpoint no longer filters what it returns through publicView");
  assert.ok(!/\bapiKey\b/.test(fn), "the endpoint references apiKey — a key in a JSON body is a key in a browser's network log");
  assert.ok(!fn.includes("urlTemplate") && !fn.includes("endpoint:"), "the endpoint returns resolved source URLs");
});

test("the page asks the endpoint rather than deciding scannability itself", () => {
  assert.ok(page.includes("/api/imagery-source?lat="), "the page does not call /api/imagery-source");
  assert.ok(!page.includes("IMAGERY_SOURCES"), "the scan registry must not be reproduced client side");
});

/* ---------- boundary 3: the course picker is the real one, in pick-only mode ---------- */

test("the picker exposes pick-only mode and clears it on both exits", () => {
  assert.ok(picker.includes("pickHandler:null"), "picker state has no pickHandler — pick-only mode is gone");
  assert.ok(picker.includes('state.pickHandler=typeof opts.onPick==="function"?opts.onPick:null;'),
    "open() no longer arms a pick handler from opts.onPick");
  const close = picker.slice(picker.indexOf("function closeOwner(opts={}){"));
  assert.ok(close.slice(0, close.indexOf("function bindListeners")).includes("state.pickHandler=null"),
    "closeOwner must disarm pick-only mode, or a cancelled pick stays armed and swallows the next real selection");
});

test("a pick-only selection never enters the play pipeline or the player's recents", () => {
  const body = picker.slice(picker.indexOf("function selectCourseForPlay(raw,opts={}){"));
  const handoff = body.indexOf("if(state.pickHandler){");
  const recents = body.indexOf("rememberRecentCourse(course);");
  assert.ok(handoff > 0, "selectCourseForPlay has no pick-only hand-off");
  assert.ok(recents > 0 && handoff < recents,
    "the pick-only hand-off must come BEFORE rememberRecentCourse — studio shares an origin with the app, so its recents are the player's recents");
  const preamble = body.slice(handoff, body.indexOf("rememberRecentCourse(course);"));
  ["invokeMappingOnce", "enterGpsPlay", "closePickerSurface"].forEach((snippet) => {
    assert.ok(!preamble.includes(snippet), "the pick-only branch reaches into the play pipeline: " + snippet);
  });
});

test("the page opens the real picker in pick-only mode and never rolls its own search", () => {
  assert.ok(page.includes("window.GDCoursePicker.open({"), "the page does not open the real course picker");
  assert.ok(page.includes("onPick: function (course)"), "the page does not use pick-only mode");
  ["/api/courses-near", "nominatim", "searchInput"].forEach((snippet) => {
    assert.ok(!page.includes(snippet), "the page appears to run its own course search: " + snippet);
  });
});

test("the shell can step aside for the picker and come back", () => {
  assert.ok(shell.includes("window.GDStudioShell = {"), "studio-shell.js no longer exposes GDStudioShell");
  ["hide:", "show:"].forEach((snippet) => {
    assert.ok(shell.includes(snippet), "GDStudioShell is missing: " + snippet);
  });
  assert.ok(page.includes("window.GDStudioShell.hide()") && page.includes("GDStudioShell.show()"),
    "the page must hide the shell to hand over the picker and show it again afterwards");
  /* The picker's Back and Home buttons live in gd-app-core.js and just hide #courseScreen —
     they fire no callback, so a cancel is only observable on the DOM. */
  assert.ok(page.includes("MutationObserver"), "no watch on the picker surface — cancelling would leave Studio hidden");
});

/* ---------- the page writes nothing ---------- */

test("the viewport is view-only", () => {
  [
    "GDCourseLocation.confirm", "GDCourseLocation.propose", "GDCourseLocation.remove",
    "runCourseMappingAttempt", "gdRunCourseMappingAttempt", "openCourse(",
    "method: \"POST\"", "method:\"POST\""
  ].forEach((snippet) => {
    assert.ok(!page.includes(snippet), "the map viewport must not write anything — found: " + snippet);
  });
});

/* ---------- the admin entry point no longer starts a round ---------- */

test("admin \"Edit location\" cannot fall through into GPS play", () => {
  const fn = adminDb.slice(adminDb.indexOf("function gdAdminCourseLocationEdit(courseId){"));
  const body = fn.slice(0, fn.indexOf("/* Look at this course's ground"));
  assert.ok(!body.includes("GDCoursePicker"),
    "gdAdminCourseLocationEdit still falls back to the course picker — that fallback started a round instead of editing a location");
  assert.ok(body.includes("gdAdminCourseLocationViewport(courseId)"), "the fallback should be the read-only viewport");
  assert.ok(adminDb.includes("window.gdAdminCourseLocationViewport=gdAdminCourseLocationViewport"),
    "the viewport action is not exported, so its inline onclick would throw");
  assert.ok(adminDb.includes('onclick="return gdAdminCourseLocationViewport('),
    "no Map viewport button in the course-location actions row");
});

let failed = 0;
tests.forEach((t) => {
  try { t.fn(); console.log("  ok  " + t.name); }
  catch (error) { failed++; console.log("FAIL  " + t.name + "\n      " + (error && error.message)); }
});
console.log((failed ? "FAILED " + failed + "/" : "passed ") + tests.length + " studio map viewport checks");
process.exit(failed ? 1 : 0);
