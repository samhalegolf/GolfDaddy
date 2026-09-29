/*
 * Studio Mapping Overlay, locked.
 *
 * The page's one job is to write a course's overlay row and nothing else; the worker's one
 * job is to read it into every payload a mapper job fetches. Both halves have a cheap way to
 * go wrong silently - a second fetchOverpass call site that skips the merge, a page that
 * starts writing objects - so both are pinned here.
 *
 * Static source checks + one sandboxed registry load, in the style of
 * dev/studio-map-viewport.test.js. The overlay's data path (features -> OSM elements -> the
 * real resolver) is exercised in dev/map-overlay-core.test.js.
 *
 * Run: node dev/studio-map-overlay.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const PAGE = "scripts/studio/courses/map-overlay/map-overlay-page.js";

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }

const page = read(PAGE);
const worker = read("functions/course-mapper-worker-background.mjs");
const endpoint = read("functions/course-map-overlay.mjs");
const store = read("functions/lib/gd-map-overlay-store.mjs");
const adminDb = read("scripts/studio/gd-admin-course-db.js");
const source = read("index.html");
const toml = read("netlify.toml");

/* ---------- the page is reachable ---------- */

test("the page registers itself under GDStudioPages[\"map-overlay\"] and is studio-only", () => {
  assert.ok(page.includes('window.GDStudioPages["map-overlay"] = render'), "the shell finds a page by window.GDStudioPages[record.id]");
  const re = new RegExp('data-gd-surface="studio"[^>]*src="' + PAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  assert.ok(re.test(source), "map-overlay-page.js is not marked data-gd-surface=\"studio\" in index.html");
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
  const record = registry.get("map-overlay");
  assert.ok(record, "no registry record with id \"map-overlay\"");
  assert.strictEqual(record.parent, "courses");
  const courses = registry.navTree.filter((entry) => entry.id === "courses")[0];
  assert.ok(courses && (courses.children || []).indexOf("map-overlay") >= 0, "map-overlay is not in the Courses nav children");
});

test("Course Database's row actions open the overlay editor on the selected course", () => {
  assert.ok(adminDb.includes('onclick="return gdAdminCourseLocationOverlay('), "no Draw overlay button in the course-location actions row");
  assert.ok(adminDb.includes("window.gdAdminCourseLocationOverlay=gdAdminCourseLocationOverlay"), "the action is not exported, so its inline onclick would throw");
  assert.ok(adminDb.includes("window.GDStudioMapOverlay.open(payload)"), "the action does not route through GDStudioMapOverlay.open");
  assert.ok(page.includes("window.GDStudioMapOverlay = {"), "the page does not expose GDStudioMapOverlay for Course Database");
});

/* ---------- the page borrows what it must not own ---------- */

test("the page picks courses through the shared hand-off and providers through GDMapSources", () => {
  assert.ok(page.includes("window.GDStudioCoursePick"), "the page does not use the shared course pick hand-off");
  assert.ok(page.includes("window.GDMapSources"), "the page does not consult window.GDMapSources");
  assert.ok(!/https?:\/\/[^"'\s]*\{z\}/.test(page), "a tile URL template appears in the page — providers come from GDMapSources");
  ["/api/courses-near", "nominatim", "GDCoursePicker.open("].forEach((snippet) => {
    assert.ok(!page.includes(snippet), "the page rolls its own course selection: " + snippet);
  });
  assert.ok(page.includes("source.attribution"), "the page does not render the active source's attribution");
});

/* ---------- the page writes the overlay and nothing else ---------- */

test("the page writes only through the overlay API and the mapper job queue", () => {
  assert.ok(page.includes('"/api/course-map-overlay"'), "the page does not talk to /api/course-map-overlay");
  assert.ok(page.includes('"/api/course-mapper-jobs"'), "the page cannot request the mapper run that makes the overlay matter");
  assert.ok(page.includes('kind: "remap"'), "the mapper run must be a remap - the overlay changes hole geometry, so a stale map must be cleared");
  [
    "GDCourseLocation.confirm", "GDCourseLocation.propose", "GDCourseLocation.remove",
    "/api/course-maps", "objects_json", "holes_json", "supabase.co", "localStorage"
  ].forEach((snippet) => {
    assert.ok(!page.includes(snippet), "the overlay page must write nothing but the overlay — found: " + snippet);
  });
});

test("the mapper run is gated on a saved overlay, so what runs is what is on screen", () => {
  assert.ok(page.includes("el.run.disabled = !has || session.dirty"), "Run mapper must be disabled while there are unsaved shapes");
});

/* ---------- placing by eye ---------- */

test("every change autosaves, and leaving the page flushes what is waiting", () => {
  assert.ok(/function changed\(\) \{[\s\S]*?scheduleSave\(SAVE_DELAY_MS\)/.test(page), "changed() must schedule a save");
  assert.ok(!page.includes('data-gd-overlay="save"'), "there is no Save button - saving is automatic");
  assert.ok(/return function cleanup\(\) \{\s*\/\*[^*]*\*\/\s*flushSave\(\);/.test(page), "cleanup must flush a pending save before tearing down");
  assert.ok(page.includes("if (session.rev === sentRev)"), "a save only adopts the server copy when nothing changed while it was in flight");
});

test("shapes come from the shared builders: a fairway line with a tee behind it, a pinned green through the wand", () => {
  assert.ok(source.includes('src="scripts/studio/courses/map-overlay/map-overlay-shapes.js'), "the shape builders are not loaded");
  assert.ok(source.indexOf("map-overlay-shapes.js") < source.indexOf("map-overlay-page.js"), "the builders must load before the page");
  assert.ok(page.includes("shapes.fairwayFromLine(line, session.fairwayWidth)"), "a finished line must become a fairway polygon");
  assert.ok(page.includes("shapes.teeBeyondLine(line, allGreens())"), "a fairway must bring its tee");
  assert.ok(page.includes('var WAND_API = "/api/course-map-wand"'), "a green pin must go through the wand endpoint");
  assert.ok(page.includes("shapes.circle(point, shapes.GREEN_RADIUS_M)"), "a pin the wand cannot read still leaves a green to shape");
  assert.ok(!page.includes('data-gd-overlay="hole"') && !page.includes('data-gd-overlay="tool-hole"'), "no hole numbering or hole-line tool at this stage");
});

test("shapes are deleted by dropping them on the bin", () => {
  assert.ok(page.includes('data-gd-overlay="bin"'), "no bin on the map");
  assert.ok(/if \(overBin\(event\)\) \{[\s\S]*?removeFeature\(f\.id\)/.test(page), "dropping a shape on the bin must delete it");
});

test("the wand endpoint is registered, admin-only and writes nothing", () => {
  const wand = read("functions/course-map-wand.mjs");
  assert.ok(wand.includes('path: "/api/course-map-wand"'));
  assert.ok(toml.includes("/api/course-map-wand"), "no /api/course-map-wand redirect in netlify.toml");
  assert.ok(wand.includes("if (!admin) return json(403"), "a non-admin must be refused");
  assert.ok(wand.includes("wandGreenAtPoint("), "the endpoint must use the shared wand engine");
  assert.ok(!/saveOverlay|supabaseFetch|writeAiScan/.test(wand), "the wand only answers; the page saves");
});

/* ---------- the endpoint ---------- */

test("the overlay endpoint is registered, admin-only, and reads OSM through the mapper's own query", () => {
  assert.ok(endpoint.includes('path: "/api/course-map-overlay"'), "the function does not declare its /api path");
  assert.ok(toml.includes("/api/course-map-overlay"), "no /api/course-map-overlay redirect in netlify.toml");
  assert.ok(endpoint.includes('from "./lib/gd-map-overlay-store.mjs"'), "the endpoint must use the shared overlay store");
  assert.ok(store.includes("/auth/v1/user"), "admin identity must be proven against Supabase auth, not asserted");
  assert.ok(!endpoint.includes("/auth/v1/user"), "the endpoint must not carry its own copy of the admin proof - the store owns it");
  assert.ok(endpoint.includes("if (!admin) return json(403"), "a non-admin must be refused before anything is read or written");
  assert.ok(store.includes("normalizeOverlayFeatures("), "features must be normalised before they are stored");
  assert.ok(endpoint.includes("osmGuideQuery(") && endpoint.includes("fetchOverpass("), "the OSM context must come from the same query the mapper runs");
  assert.ok(store.includes('method: "DELETE"'), "an empty overlay must delete the row, not store []");
  assert.ok(endpoint.includes("delete out.image"), "a poller must never be handed the scan's picture back");
  /* An AI's answer arrives in image pixels with a georef; the conversion is the georef core's,
     never re-derived here, and a georef the core cannot use is a 400 with its reason. */
  assert.ok(endpoint.includes('from "./lib/gd-overlay-georef-core.mjs"'), "the endpoint does not use the georef core for pixel-space posts");
  assert.ok(endpoint.includes("aiShapesToOverlay(raw, payload.georef"), "pixel-space features are not converted through aiShapesToOverlay");
  assert.ok(endpoint.includes("saveOverlay({ courseId, features: raw, savedBy: admin, append:"), "saving must go through the store's saveOverlay so both endpoints mean the same thing by a save");
  assert.ok(endpoint.includes('error: "bad georef"'), "a georef the core rejects must be refused with its reason");
});

/* ---------- the worker ---------- */

test("every Overpass fetch in the worker carries the overlay", () => {
  assert.ok(worker.includes('from "./lib/gd-map-overlay-core.mjs"'), "the worker does not import the overlay core");
  assert.ok(worker.includes("function fetchCoursePayload(course, query)"), "no fetchCoursePayload in the worker");
  assert.ok(worker.includes("mergeOverlayIntoPayload(payload, course.overlay)"), "fetchCoursePayload does not merge the overlay");
  /* The only bare fetchOverpass call allowed is the one inside fetchCoursePayload. A second
     one is a payload the overlay is missing from, and whichever requery gets adopted is the
     one the resolver reads. */
  const bare = worker.split("fetchOverpass(").length - 1;
  assert.strictEqual(bare, 1, "expected exactly one fetchOverpass( call (inside fetchCoursePayload), found " + bare);
  assert.ok(worker.includes("await attachCourseOverlay(course)"), "loadCourseCenter does not attach the overlay, so no job would see it");
  assert.ok(worker.includes('OVERLAYS_TABLE = "course_map_overlays"'), "the worker reads a different table than the migration creates");
  assert.ok(worker.includes("overlay: course.overlayError ? { error: course.overlayError } : overlaySummary(course.overlay)"),
    "job diagnostics must say what the overlay contributed, or that it could not be read");
});

test("the table migration exists and is service-role only", () => {
  const sql = read("supabase/migrations/20260928_create_course_map_overlays.sql");
  assert.ok(sql.includes("create table if not exists public.course_map_overlays"));
  assert.ok(sql.includes("course_id text primary key"), "one row per course");
  assert.ok(sql.includes("enable row level security"));
  assert.ok(sql.includes("auth.role() = 'service_role'"), "nothing on a player's device reads or writes this table");
});

let failed = 0;
tests.forEach((t) => {
  try { t.fn(); console.log("  ok  " + t.name); }
  catch (error) { failed++; console.log("FAIL  " + t.name + "\n      " + (error && error.message)); }
});
console.log((failed ? "FAILED " + failed + "/" : "passed ") + tests.length + " studio map overlay checks");
process.exit(failed ? 1 : 0);
