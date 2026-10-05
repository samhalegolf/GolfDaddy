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
const shell = read("scripts/studio/studio-shell.css");
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
    "/api/course-maps", "objects_json", "holes_json", "supabase.co"
  ].forEach((snippet) => {
    assert.ok(!page.includes(snippet), "the overlay page must write nothing but the overlay — found: " + snippet);
  });
  const keys = page.match(/localStorage\.(?:setItem|getItem)\(([^,)]+)/g) || [];
  assert.ok(keys.length && keys.every((k) => k.includes("STORE_KEY")), "the only thing kept in the browser is the page's own state");
  assert.ok(page.includes('var STORE_KEY = "gd_studio_map_overlay_v1"'), "the page keeps its state under its own key");
});

test("the mapper run is gated on a saved overlay, so what runs is what is on screen", () => {
  assert.ok(page.includes("el.run.disabled = !has || session.dirty"), "Run mapper must be disabled while there are unsaved shapes");
});

/* ---------- placing by eye ---------- */

test("every change autosaves, and leaving the page flushes what is waiting", () => {
  assert.ok(/function changed\(\) \{[\s\S]*?scheduleSave\(SAVE_DELAY_MS\)/.test(page), "changed() must schedule a save");
  assert.ok(page.includes('data-gd-overlay="save"') && page.includes("flushSave().then(function () {"), "Save saves now, on top of the autosave");
  assert.ok(/return function cleanup\(\) \{\s*\/\*[^*]*\*\/\s*flushSave\(\);/.test(page), "cleanup must flush a pending save before tearing down");
  assert.ok(page.includes("if (session.rev === sentRev)"), "a save only adopts the server copy when nothing changed while it was in flight");
});

test("shapes come from the shared builders: a fairway line, a clicked green through the wand", () => {
  assert.ok(source.includes('src="scripts/studio/courses/map-overlay/map-overlay-shapes.js'), "the shape builders are not loaded");
  assert.ok(source.indexOf("map-overlay-shapes.js") < source.indexOf("map-overlay-page.js"), "the builders must load before the page");
  assert.ok(page.includes("shapes.fairwayFromLine(line, session.fairwayWidth)"), "a finished line must become a fairway polygon");
  assert.ok(!page.includes("teeBeyondLine"), "a fairway no longer drops a tee of its own - tees are placed by hand");
  assert.ok(page.includes('var WAND_API = "/api/course-map-wand"'), "a green pin must go through the wand endpoint");
  assert.ok(page.includes("shapes.circle(point, defaultRadius(kind))"), "a pin the wand cannot read still leaves a green to shape");
  assert.ok(!page.includes('data-gd-overlay="tool-hole"'), "no hole-line tool at this stage");
});

test("a bunker is a pin the same wand outlines, on its bunker profile", () => {
  assert.ok(page.includes('railButton("tool-bunker"'), "no Bunker tool");
  assert.ok(page.includes("seed: point, kind: kind, scale: size }, WAND_API"), "the click must tell the wand which kind it is outlining, and at what size");
  assert.ok(page.includes("WAND_TARGET_MPP[kind]") && page.includes("WAND_MAX_M2[kind]"), "the capture must be sized for the kind being outlined");
  assert.ok(page.includes("shapes.BUNKER_RADIUS_M"), "a bunker pin the wand cannot read still leaves a bunker to shape");
  const wand = read("functions/course-map-wand.mjs");
  assert.ok(wand.includes("WAND_PROFILES, kind"), "the endpoint must refuse a kind the wand has no profile for");
});

test("hole numbers are optional: new shapes carry the working hole, a selected shape can be renumbered", () => {
  assert.ok(page.includes('data-gd-overlay="hole"'), "no hole number field");
  assert.ok(/function addFeature\(raw, quiet\) \{[\s\S]*?session\.hole[\s\S]*?hole: holeNumber\(hole\)/.test(page), "new shapes must take the working hole number");
  assert.ok(/function holeFieldChanged\(\) \{[\s\S]*?f\.hole = n;[\s\S]*?changed\(\);/.test(page), "renumbering a selected shape must save");
});

/* ---------- drafts ---------- */

test("a session is a draft the mapper ignores until it is marked ready", () => {
  const sql = read("supabase/migrations/20260929_add_course_map_overlay_status.sql");
  assert.ok(sql.includes("alter column status set default 'draft'"), "new overlays must start as drafts");
  assert.ok(sql.includes("add column if not exists status text not null default 'ready'"), "overlays already in use must stay readable");
  assert.ok(store.includes('status: "draft", updated_by: savedBy'), "every shape save must put the overlay back to draft");
  assert.ok(endpoint.includes("writeOverlayStatus(courseId, payload.status)"), "marking ready must be its own request that leaves the shapes alone");
  assert.ok(worker.includes('if (row && row.status === "ready") course.overlay = features;'), "the worker must merge only a ready overlay");
  assert.ok(worker.includes("ignoredFeatures: course.overlayDraft"), "a skipped draft must show on the job's diagnostics");
  assert.ok(page.includes('data-gd-overlay="ready"') && page.includes('api("POST", "", { courseId: id, status: "ready" })'), "no Mark ready in the page");
  assert.ok(page.includes("This overlay is still a draft, and the mapper ignores drafts."), "running the mapper on a draft must ask before marking it ready");
});

/* ---------- opened from a failed row ---------- */

test("Course Database rows open the drawer, and it arrives with what the last run saw", () => {
  assert.ok(adminDb.includes('onclick="event.stopPropagation();return gdAdminCourseLocationOverlay('), "no Draw button on the course rows");
  assert.ok(adminDb.includes("${gdAdminCourseDbDrawButton(item,status)}"), "the Draw button is not in the row markup");
  assert.ok(endpoint.includes("body.objects = await loadCourseObjects(courseId)") && endpoint.includes("body.lastRun = await loadLastRun(courseId)"), "the drawer's load must carry the saved objects and the last run");
  assert.ok(endpoint.includes('bunker: "bunkers"'), "OSM bunkers must be drawn so they are not placed twice");
  assert.ok(page.includes("function drawObjects()") && page.includes("function renderLastRun()"), "the page must show the saved objects and the last run");
  assert.ok(/function drawObjects\(\) \{[\s\S]*?interactive: false[\s\S]*?\n    \}/.test(page), "saved objects are reference only - never clickable");
  assert.ok(!/session\.features[^\n]*session\.objects|session\.objects[^\n]*session\.features\.push/.test(page), "saved objects must never be copied into the overlay");
});

test("captured tiles are fetched at the capture zoom, not whatever zoom the map shows", () => {
  /* Leaflet's template layers take {z} from the map's own tile zoom; the green wand read the
     wrong ground at every map zoom but its capture zoom until this was pinned. */
  assert.ok(/function tileUrlAt\(cx, cy, z\) \{[\s\S]*?layer\._tileZoom = z;[\s\S]*?finally \{ layer\._tileZoom = saved; \}/.test(page), "tileUrlAt must point the layer's tile zoom at z for the call and restore it");
  assert.ok(page.includes("img.src = tileUrlAt(cx, cy, z)"), "stitched tiles must be addressed through tileUrlAt");
  assert.ok(page.includes("attempt(1)"), "the wand retries one zoom coarser before falling back to a circle");
});

test("the tool picked stays picked: placing never switches tools, and there is no next-step chain", () => {
  ["NEXT_TOOL", "doneAndNext", 'data-gd-overlay="next"'].forEach((snippet) => {
    assert.ok(!page.includes(snippet), "the set workflow is gone - found: " + snippet);
  });
  const placing = page.slice(page.indexOf("function handleMapClick("), page.indexOf("/* ---- pins into shapes ----"));
  assert.ok(placing.length > 0 && !placing.includes("setTool("), "placing a fairway, green, tee or bunker must not change the tool");
});

test("bunker wand: its reach steps smaller and bigger, and overlapping bunkers merge into one", () => {
  const core = read("functions/lib/gd-surface-refine-core.mjs");
  const wand = read("functions/course-map-wand.mjs");
  assert.ok(page.includes('data-gd-overlay="wand-smaller"') && page.includes('data-gd-overlay="wand-bigger"'), "no bunker wand size control");
  assert.ok(wand.includes("scale: payload.scale"), "the endpoint must pass the size to the wand");
  assert.ok(core.includes("const radiusM = profile.radiusM * size;"), "the wand's sweep must scale with the size");
  assert.ok(page.includes('data-gd-overlay="merge"') && page.includes("shapes.mergeOverlapping(f.points, merged, shapes.DETAIL_MAX_POINTS)"), "overlapping bunker outlines must merge through the shared builder");
});

test("pins mode: a fairway's ends become a fairway, a green pin is outlined at once, tees and bunkers stay pins", () => {
  assert.ok(page.includes('data-gd-overlay="mode-pins"'), "no Pins mode");
  assert.ok(page.includes('addFeature({ kind: tool, pin: true, points: [point] })'), "a green, tee or bunker pin is its centre");
  assert.ok(!page.includes('addFeature({ kind: "fairway", pin: true'), "a fairway's start and end make the fairway straight away");
  assert.ok(page.includes('if (tool === "green") { setStatus("Green pinned - finding its edge…"); wandPin(pin.id); }'), "a green pin goes straight through the wand");
  assert.ok(/if \(f\.pin && f\.kind === "green"\) wandPin\(f\.id\)/.test(page), "a green pin dragged while the wand works is outlined again where it lands");
  assert.ok(page.includes('data-gd-overlay="shape-pins"') && page.includes("function shapePin(pinId)"), "pins must be able to become shapes");
  const core = read("functions/lib/gd-map-overlay-core.mjs");
  assert.ok(core.includes("const points = feature.pin ? pinShape(feature) : feature.points;"), "the mapper must read a pin as its default shape");
});

test("past the provider's imagery the map blows up the last tiles instead of going black", () => {
  assert.ok(page.includes("watchImageryCeiling(layer);"), "the mounted layer must be watched for its zoom ceiling");
  assert.ok(page.includes("tiles.options.maxNativeZoom = z - 1;"), "a zoom whose tiles all fail must become the layer's ceiling");
  assert.ok(page.includes("mapObj.setMaxZoom(DRAW_MAX_ZOOM)"), "the map keeps zooming past the ceiling");
});

test("shapes are deleted by dropping them on the bin", () => {
  assert.ok(page.includes('data-gd-overlay="bin"'), "no bin on the map");
  assert.ok(/if \(event\.type !== "pointercancel" && overBin\(event\)\) \{[\s\S]*?removeFeature\(f\.id\)/.test(page), "dropping a shape on the bin must delete it");
});

test("shapes and corners drag by touch as well as by mouse", () => {
  assert.ok(page.includes('node.addEventListener("pointerdown"'), "a drag must start from a pointer press, which a finger sends");
  assert.ok(page.includes('document.addEventListener("pointermove", onDragMove)') && page.includes('document.addEventListener("pointercancel", onDragEnd)'), "a drag must follow pointer moves and end on a cancelled touch");
  assert.ok(!/\.on\("mousedown"/.test(page), "no drag may still start from a mouse-only press");
});

test("a fairway line can be finished, undone and cancelled without a keyboard", () => {
  ["draft-finish", "draft-undo", "draft-cancel"].forEach((name) => assert.ok(page.includes('data-gd-overlay="' + name + '"'), name + " missing from the map"));
  assert.ok(page.includes('el["draft-finish"].addEventListener("click", finishFairway)'), "Finish must finish the fairway");
});


test("the wand endpoint is registered, admin-only and writes nothing", () => {
  const wand = read("functions/course-map-wand.mjs");
  assert.ok(wand.includes('path: "/api/course-map-wand"'));
  assert.ok(toml.includes("/api/course-map-wand"), "no /api/course-map-wand redirect in netlify.toml");
  assert.ok(wand.includes("if (!admin) return json(403"), "a non-admin must be refused");
  assert.ok(wand.includes("wandAtPoint("), "the endpoint must use the shared wand engine");
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
  assert.ok(worker.includes("overlay: overlayDiagnostics(course)") && worker.includes("if (course.overlayError) return { error: course.overlayError };"),
    "job diagnostics must say what the overlay contributed, that it was a draft, or that it could not be read");
});

test("the table migration exists and is service-role only", () => {
  const sql = read("supabase/migrations/20260928_create_course_map_overlays.sql");
  assert.ok(sql.includes("create table if not exists public.course_map_overlays"));
  assert.ok(sql.includes("course_id text primary key"), "one row per course");
  assert.ok(sql.includes("enable row level security"));
  assert.ok(sql.includes("auth.role() = 'service_role'"), "nothing on a player's device reads or writes this table");
});

test("Link: drag from one shape to another, or tap both, to put them on one hole", () => {
  assert.ok(page.includes('railButton("tool-connect"'), "no Link tool");
  assert.ok(page.includes("function linkFeatures(a, b)") && page.includes("var hole = a.hole || b.hole || freeHole();"), "linking must share a hole number, taking the first numbered one");
  assert.ok(page.includes('node.setAttribute("data-gd-feature", f.id)') && page.includes("document.elementFromPoint(x, y)"), "a Link drag must find the shape it was dropped on");
  assert.ok(page.includes("function drawLinks()"), "shapes on one hole must be drawn joined");
});

test("the shape just placed can be dragged without switching to Move", () => {
  assert.ok(page.includes('return !!f && canEdit() && (tool === "move" || f.id === lastPlacedId);'), "only Move, or the last placed shape, can be dragged");
  assert.ok(page.includes("lastPlacedId = f.id;"), "placing a shape must make it the draggable one");
});

test("greens and bunkers are shaped by a few smooth points once the wand has outlined them", () => {
  assert.ok(page.includes("return shapes.smoothOutline(ring, kind);"), "a wand shape must be kept as its smooth outline");
  assert.ok(page.includes('function isSmooth(f) { return !f.pin && !!shapes.SMOOTH[f.kind] && f.source !== "colour"; }'), "every smooth kind is edited by its handles, unless the colour wand outlined it");
  assert.ok(page.includes("f.points = shapes.smoothRing(handles, smooth.steps);"), "dragging a handle must re-curve the outline through its handles");
  assert.ok(page.includes("if (f.pin || isSmooth(f) || isDetailed(f) || f.kind === \"tree\") return out;"), "a smooth or detailed shape has no add-a-point dots");
  assert.ok(page.includes('into.points = detailed ? merged : shapes.smoothOutline(merged, "bunker");'), "a merged bunker is smooth too, unless a colour-wand bunker is in it");
});

test("the shape just placed stays live: left/right step sensitivity, up/down size, Enter or Space keeps it", () => {
  assert.ok(page.includes('document.addEventListener("keydown", onAdjustKey, true);') && page.includes('document.removeEventListener("keydown", onAdjustKey, true);'),
    "the arrow keys must reach the live shape ahead of the map's own panning, and be let go on the way out");
  assert.ok(/if \(key === "ArrowLeft"\) stepSensitivity\(-1\);\s*else if \(key === "ArrowRight"\) stepSensitivity\(1\);\s*else if \(key === "ArrowUp"\) stepSize\(1\);\s*else if \(key === "ArrowDown"\) stepSize\(-1\);/.test(page), "arrow keys mapping");
  assert.ok(page.includes('else if (key === "Enter" || key === " " || key === "Spacebar") commitAdjust(false);'), "Enter or Space keeps it");
  assert.ok(page.includes("shapes.fairwayFromLine(adjust.line, width)"), "up/down on a fairway changes its width");
  assert.ok(page.includes("wandOutline(mine.seed, kind, size)"), "up/down on a wand shape runs the wand again at the next size");
  assert.ok(page.includes("f.points = shapes.smoothOutline(adjust.candidates[next], f.kind);"), "left/right step through the edges the wand found");
  assert.ok(/function handleMapClick[\s\S]*?settle\(/.test(page) && /function settle[\s\S]*?if \(adjust\) commitAdjust\(true\);/.test(page), "placing the next shape keeps the last one");
  assert.ok(page.includes('var into = f.kind === "bunker" ? mergeBunker(f.points, f.hole, f) : null;'), "a bunker merges only once it is kept");
});

test("water: a Water tool that draws round the water or uses the wand", () => {
  assert.ok(page.includes('railButton("tool-water"'), "no Water tool");
  assert.ok(page.includes('data-gd-overlay="method-draw"') && page.includes('data-gd-overlay="method-wand"') && page.includes('data-gd-overlay="method-line"'), "no Wand / Draw round / Line + wand switch");
  assert.ok(page.includes('water: ["wand", "draw", "line", "colour"]') && page.includes('bunker: ["wand", "draw", "line", "colour"]') && page.includes('fairway: ["width", "line", "colour"]'), "water and bunkers draw round or line-wand; fairways line-wand");
  assert.ok(page.includes("shapes.simplifyOutline(") && page.includes("addFeature({ kind: drawn.kind, points: ring });"), "a drawn line must become an outline of the tool's kind");
  assert.ok(page.includes('el.map.addEventListener("pointerdown", onMapPress);') && page.includes('if (gesture === "lasso") beginLasso(event);'), "drawing round starts on a press on the map");
  assert.ok(page.includes("water: 0.5") && page.includes("water: 12000"), "the wand capture must be sized for water");
});

test("trees and hazard: tools that save as their own kinds", () => {
  assert.ok(page.includes('railButton("tool-trees"') && page.includes('railButton("tool-hazard"'), "no Trees / Hazard tools");
  assert.ok(page.includes('hazard: ["draw", "colour"]'), "a hazard is drawn round, or picked with the colour wand");
  assert.ok(page.includes('trees: ["single", "oval", "draw", "find", "colour"]'), "trees: a single tree, a cluster oval, drawn round, or found");
});

test("single trees: a click drops one, up / down size it, and the next starts at that size", () => {
  assert.ok(page.includes('else if (methodOf(tool) === "single") placeTree(point);'), "a click with Tree drops a tree");
  assert.ok(page.includes('addFeature({ kind: "tree", points: shapes.treeAt(point, session.treeRadius || shapes.TREE_RADIUS_M) })'), "a tree is a small ring at the remembered size");
  assert.ok(page.includes("session.treeRadius = Math.round(shapes.ringRadiusM(f.points) * 10) / 10;"), "sizing a tree sets the next one's size");
  assert.ok(page.includes("session.treeSamples.push(f.id);"), "a tree placed by hand is a sample for the finder");
});

test("cluster oval: a press and drag stretches an oval of trees", () => {
  assert.ok(page.includes('addFeature({ kind: "trees", points: ring });') && page.includes("shapes.ellipseInBox(a, b, done.round)"), "the oval becomes a trees area");
});

test("tree finder: learns from the trees placed by hand, drops trees in the box, live for left / right / Enter / Esc", () => {
  assert.ok(page.includes("var samples = sampleTrees().slice(-TREE_SAMPLE_MAX);"), "the finder reads the session's hand-placed trees");
  assert.ok(page.includes("shapes.treeFinder(cap.image, shapes.colourModel(pool)"), "the finder runs on the box's picture with the samples' colour");
  assert.ok(page.includes("var live = finder ? { step: stepFinder"), "left / right / Enter / Esc work on the dropped trees");
  assert.ok(page.includes('source: "finder"'), "found trees are marked as the finder's");
});

test("waste area: drawn round and grown, or picked with the colour wand", () => {
  assert.ok(page.includes('railButton("tool-waste"'), "no Waste tool");
  assert.ok(page.includes('waste: ["grow", "colour"]'), "waste: Draw + grow, Colour wand");
  assert.ok(page.includes('if (drawn.kind === "waste") { growPlace({ ring: ring }, "waste"); return; }'), "a drawn waste area is grown out");
  assert.ok(page.includes("shapes.growFromArea(cap.image, from.map(cap.toPx), opts)"), "the grow runs growFromArea on the captured picture");
  assert.ok(page.includes("shapes.floodSelect(press.cap.field, press.seed.x, press.seed.y, press.tol)"), "the colour wand floods from the press");
  assert.ok(page.includes('addFeature({ kind: kind, points: points, source: "colour" });'), "Enter makes the pick a shape of the tool in hand");
});

test("every shape tool has the colour wand", () => {
  ["fairway", "green", "tee", "bunker", "water", "trees", "hazard", "waste"].forEach(kind => {
    assert.ok(new RegExp(kind + ': \\[[^\\]]*"colour"\\]').test(page), kind + " has no colour wand");
  });
  assert.ok(page.includes("shapes.maskOutline(sel.mask, cap.image.width, cap.image.height, shapes.DETAIL_MAX_POINTS)"), "the pick keeps its detail");
  assert.ok(page.includes('var merged = kind === "bunker" ? mergeBunker(points, session.hole, null, true) : null;'), "a colour-wand bunker merges, keeping its detail");
});

test("areas kept beside each other meet along a shared seam that moves for both", () => {
  assert.ok(page.includes('var SEAM_KINDS = ["fairway", "water", "hazard", "waste", "trees"];'), "fairway, water, hazard, waste and trees seam");
  assert.ok(page.includes("var joined = sealSeams(f);"), "a shape must seam when it is kept");
  assert.ok(page.includes("lockedB: lockedCorners(g, f, owners)"), "a seam with a third shape must be locked");
  assert.ok(page.includes("g.points = shapes.applyWeld(w.orig, w.runs, f.points, from);"), "a dragged seam must move the shape on the other side");
  assert.ok(page.includes('data-gd-overlay="seams"'), "seams can be turned off");
});

test("undo: Ctrl+Z / Cmd+Z and a button take back the last change", () => {
  assert.ok(page.includes('viewButton("undo", "undo",'), "no Undo button");
  assert.ok(page.includes("if (!undoing) noteUndo();"), "every change must be recorded for undo");
  assert.ok(page.includes('(event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && String(event.key || "").toLowerCase() === "z"'), "Ctrl+Z / Cmd+Z must undo");
  assert.ok(page.includes("session.features = JSON.parse(undoStack.pop());"), "undo must put the shapes back");
  assert.ok(page.includes("if (draft.length) { undoDraftPoint(); return; }"), "while laying a line, undo takes back its last point");
  assert.ok((page.match(/resetUndo\(\);/g) || []).length >= 2, "the history starts again when a course loads or a scan replaces the shapes");
});

test("a detailed outline shows its key corners and bends where its edge is grabbed", () => {
  assert.ok(page.includes("if (isDetailed(f)) return shapes.keyCorners(screenRing(f.points));"), "a detailed outline must show only its key corners");
  assert.ok(page.includes('onPress(entry.edge, function (e) { beginDrag(f.id, "edge", -1, e); });'), "a press on the edge must bend it");
  assert.ok(page.includes("if (isDetailed(f) && mode !== \"body\") beginBend(f, e);"), "a corner or edge drag on a detailed outline must bend it");
  assert.ok(page.includes("setBent(f, shapes.tidyBend(d.bend.last, d.bend.added), d.bend);"), "a bend keeps only the corners it needs");
});

test("line wand: a finished line on Line + wand is grown out in the browser", () => {
  assert.ok(page.includes('if (session.mode === "shapes" && session.method[kind] === "line") { growPlace({ line: line }, kind); return; }'), "finishing a line-wand line must grow it");
  assert.ok(page.includes("shapes.growFromLine(cap.image, from.map(cap.toPx), opts)"), "the line wand runs growFromLine on the captured picture");
  assert.ok(page.includes("if (adjust.grow) { regrow(f, by); return; }"), "up/down on a line-wand shape changes its reach");
});

test("bigger wand: bunkers and water step past 2x", () => {
  assert.ok(page.includes("var WAND_SIZES_BIG = WAND_SIZES.concat([2.5, 3.2, 4, 5, 6]);"), "bunker / water sizes go to 6x");
  assert.ok(page.includes("while (half > WAND_CAPTURE_MAX_HALF_PX && z > 14)"), "a big wand capture coarsens rather than growing without bound");
});

test("one screen: tools float over the map, the rest is in the pull-down", () => {
  assert.ok(page.includes('containerEl.classList.add("gdStudioOverlayHost")') && page.includes('containerEl.classList.remove("gdStudioOverlayHost")'), "the page must take over the workspace while it is up, and give it back");
  assert.ok(page.includes('data-gd-overlay="menu"') && page.includes("function setMenu(open)"), "no pull-down for the course, imagery and publishing");
  assert.ok(shell.includes(".gdStudioWorkspace.gdStudioOverlayHost { padding: 0; overflow: hidden;"), "the workspace must not scroll under the overlay page");
});

let failed = 0;
tests.forEach((t) => {
  try { t.fn(); console.log("  ok  " + t.name); }
  catch (error) { failed++; console.log("FAIL  " + t.name + "\n      " + (error && error.message)); }
});
console.log((failed ? "FAILED " + failed + "/" : "passed ") + tests.length + " studio map overlay checks");
process.exit(failed ? 1 : 0);
