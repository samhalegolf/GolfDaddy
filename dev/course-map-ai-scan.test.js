/*
 * AI scan wiring, locked.
 *
 * Two halves and a row: the synchronous endpoint proves the caller and parks the picture,
 * the background function runs the model and writes the overlay, and Studio captures the
 * view and polls. Each half has a cheap way to go wrong silently - a background function
 * that trusts its own request body, a picture left on the row forever, a capture whose
 * georef describes a different picture than the one sent - so they are pinned here.
 *
 * Static source checks, in the style of dev/studio-map-overlay.test.js. The model call
 * itself is not exercised (no key, no network); its prompt and parser are covered by
 * dev/ai-scan-core.test.js and its pixel conversion by dev/overlay-georef-core.test.js.
 *
 * Run: node dev/course-map-ai-scan.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }

const sync = read("functions/course-map-ai-scan.mjs");
const background = read("functions/course-map-ai-scan-background.mjs");
const store = read("functions/lib/gd-map-overlay-store.mjs");
const page = read("scripts/studio/courses/map-overlay/map-overlay-page.js");
const toml = read("netlify.toml");
const pkg = JSON.parse(read("package.json"));
const workflow = read(".github/workflows/structural-smoke.yml");

test("the synchronous half is registered, admin-only, and refuses what it cannot run", () => {
  assert.ok(sync.includes('path: "/api/course-map-ai-scan"'), "the function does not declare its /api path");
  assert.ok(toml.includes("/api/course-map-ai-scan"), "no /api/course-map-ai-scan redirect in netlify.toml");
  assert.ok(sync.includes('from "./lib/gd-map-overlay-store.mjs"') && sync.includes("verifiedAdminEmail(req)"), "the caller must be proven through the shared store");
  assert.ok(sync.includes("if (!admin) return json(403"), "a non-admin must be refused before anything is written");
  assert.ok(sync.includes("process.env.ANTHROPIC_API_KEY"), "an unconfigured site must say so instead of queueing a scan that can never run");
  assert.ok(sync.includes("imageGeoreference(payload.georef)") && sync.includes('error: "bad georef"'), "a georef the core rejects must be refused with its reason");
  assert.ok(sync.includes("MAX_IMAGE_CHARS"), "an oversize picture is refused with a sentence, not a gateway error");
  assert.ok(sync.includes("a scan is already running"), "a second scan on a running one must be refused, not stacked");
  assert.ok(sync.includes("/.netlify/functions/course-map-ai-scan-background"), "the sync half must ping the background half");
  assert.ok(sync.includes('status: "queued"'), "the request is parked as queued for the background half to claim");
});

test("the background half trusts only the course id and clears the picture whatever happens", () => {
  assert.ok(background.includes('import Anthropic from "@anthropic-ai/sdk"'), "the model is called through the official SDK");
  assert.ok(pkg.dependencies && pkg.dependencies["@anthropic-ai/sdk"], "@anthropic-ai/sdk is not a dependency, so the function would not bundle");
  assert.ok(background.includes("const courseId = slug(payload && payload.courseId)"), "the request body must contribute only the course id");
  assert.ok(!/payload\.(image|georef|append|notes)/.test(background), "the background half must not read the picture or the georef from its own request - the sync half proved the caller and parked them");
  assert.ok(background.includes('request.status !== "queued"'), "only a queued request may run");
  assert.ok(background.includes("client.beta.messages.stream("), "the call is streamed so a long answer cannot hit an HTTP timeout");
  assert.ok(background.includes('betas: ["server-side-fallback-2026-07-01"]') && background.includes('fallbacks: "default"'), "server-side fallback is on");
  assert.ok(background.includes('format: { type: "json_schema", schema: AI_SCAN_OUTPUT_SCHEMA }'), "the answer is constrained by the core's schema");
  assert.ok(background.includes('DEFAULT_MODEL = "claude-opus-5-5"'), "the default model is Claude Opus 5.5");
  assert.ok(background.includes("aiShapesToOverlay(parsed.features, georef)"), "pixels go through the georef core, never a local conversion");
  assert.ok(background.includes("saveOverlay({ courseId, features: converted.features, savedBy: request.requestedBy, append: true })"), "the result is saved onto what is there, through the store, as the person who asked");
  assert.ok(background.includes("parseScanAnswer(answer.text, shapes)"), "the answer is read against the recorded shapes, so a correction lands on the one it replaces");
  /* finish() writes base + outcome; base carries no image, and the outcome never does. */
  const finish = background.slice(background.indexOf("const finish = async outcome =>"), background.indexOf("try {"));
  assert.ok(finish.includes("Object.assign({}, base, outcome, { finishedAt"), "the outcome row is built from base + outcome");
  const baseLine = background.slice(background.indexOf("const base = {"), background.indexOf("};", background.indexOf("const base = {")));
  assert.ok(!baseLine.includes("image"), "base must not carry the picture, or every finished scan keeps a megabyte of JPEG on the row");
  assert.ok(background.includes('stopReason === "refusal"') && background.includes('stopReason === "max_tokens"'), "refusal and truncation are reported as failures, not read as empty answers");
  assert.ok(background.includes("} catch (error) {") && background.includes('status: "failed", error: message'), "an exception lands on the row as failed, not as a scan stuck at running");
});

test("the store owns the row and both endpoints share it", () => {
  assert.ok(store.includes("export async function writeAiScan"), "no writeAiScan in the store");
  assert.ok(store.includes('Prefer: "resolution=merge-duplicates" }'), "a status write must merge, never overwrite the saved features");
  assert.ok(store.includes("ai_scan,course_map&course_id=eq."), "loadOverlay must read the scan state with the features");
  assert.ok(fs.existsSync(path.join(ROOT, "supabase/migrations/20260929_add_course_map_overlay_ai_scan.sql")), "no migration adds the ai_scan column");
  const overlay = read("functions/course-map-overlay.mjs");
  assert.ok(overlay.includes("aiScan: publicAiScan(overlay.aiScan)"), "GET /api/course-map-overlay must expose the scan state for polling");
});

test("Studio captures the view it shows, georeferences the scaled picture, posts, and polls", () => {
  assert.ok(page.includes('var AI_API = "/api/course-map-ai-scan"'), "the page does not talk to /api/course-map-ai-scan");
  assert.ok(page.includes("layer.getTileUrl({ x: cx, y: cy, z: z })"), "tiles must come from the mounted layer's own URL builder - no second provider list");
  assert.ok(page.includes('img.crossOrigin = "anonymous"'), "tiles must be fetched with CORS or the canvas is tainted");
  assert.ok(page.includes("captureZoom: z + Math.log2(scale)"), "the georef must describe the SCALED picture - the pixels the model answers in");
  assert.ok(page.includes("originPx: { x: x0 * 256 * scale, y: y0 * 256 * scale }"), "the origin must scale with the picture");
  assert.ok(page.includes("AI_MAX_EDGE_PX = 1568"), "the capture is scaled to the model's reading size client-side, so no server-side resize changes the pixels");
  assert.ok(page.includes("Math.sqrt(AI_MAX_PIXELS / (full.width * full.height))"), "the capture must also stay under the API's megapixel threshold - the first live scan was over it and would have been resized behind our back");
  assert.ok(page.includes("function drawGrid(") && page.includes("drawGrid(out, AI_GRID_PX)"), "a labelled coordinate grid must be burned into the picture");
  assert.ok(page.includes("function drawAnchors(") && page.includes("anchors: capture.anchors, grid: capture.grid"), "known greens and saved shapes are drawn on and sent as anchors");
  assert.ok(page.includes("var anchors = drawAnchors(out, toPx);") && page.indexOf("var anchors = drawAnchors(out, toPx);") < page.indexOf("drawGrid(out, AI_GRID_PX)"), "anchors are drawn before the grid so the grid labels stay legible on top");
  assert.ok(sync.includes("anchors: (Array.isArray(payload.anchors)") && sync.includes("grid: Number.isFinite(Number(payload.grid))"), "the sync half must park anchors and grid with the request");
  assert.ok(background.includes("anchors: request.anchors, grid: request.grid"), "the background half must hand anchors and grid to the prompt");
  assert.ok(page.includes('toDataURL("image/jpeg"'), "JPEG, or a satellite view is megabytes of PNG");
  assert.ok(!page.includes('data-gd-overlay="ai-replace"'), "no replace option - a scan always saves onto what is there");
  assert.ok(page.includes("anchors.push({ kind: f.kind, label: label, id: f.id"), "recorded shapes and pins go to the scan by label and id");
  assert.ok(sync.includes('id: String(a && a.id || "")'), "the sync half must keep each anchor's id");
  assert.ok(page.includes("function pollScan(") && page.includes("AI_TIMEOUT_MS"), "the page must poll for the outcome and give up eventually");
  assert.ok(page.includes('scan.status === "queued" || scan.status === "running"'), "a scan in flight is resumed on re-entry");
  assert.ok(page.includes("if (scanTimer) clearTimeout(scanTimer);"), "cleanup must stop the poll");
});

test("the course map is stored per course and sent to the model as image 2, never as coordinates", () => {
  const overlay = read("functions/course-map-overlay.mjs");
  assert.ok(store.includes("export function normalizeCourseMap") && store.includes("export async function writeCourseMap"), "the store owns the course map");
  assert.ok(store.includes("ai_scan,course_map&course_id=eq."), "loadOverlay must read the course map with the rest of the row");
  assert.ok(overlay.includes('Object.prototype.hasOwnProperty.call(payload, "courseMap")') && overlay.includes("writeCourseMap(courseId, courseMap)"), "a course map save is its own request on the overlay API");
  assert.ok(overlay.includes("courseMap: publicCourseMap(overlay.courseMap)"), "GET exposes that a map exists without handing the picture back");
  assert.ok(background.includes('{ type: "text", text: "Image 2 (course map, schematic):" }'), "the map goes to the model labelled as image 2");
  assert.ok(background.includes("courseMap: !!courseMap"), "the prompt is told whether image 2 exists, never handed the picture");
  assert.ok(page.includes('data-gd-overlay="course-map"') && page.includes("function uploadCourseMap(") && page.includes("COURSE_MAP_MAX_EDGE_PX"), "Studio lets an operator upload and scales the map down");
  assert.ok(page.includes('railButton("tool-tee"') && page.includes('setTool("tee")'), "tees can be drawn by hand too");
  assert.ok(fs.existsSync(path.join(ROOT, "supabase/migrations/20260929_add_course_map_overlay_course_map.sql")), "no migration adds the course_map column");
});

test("a picture from a non-storable source (Mapbox) is always a dry run that saves nothing", () => {
  assert.ok(sync.includes("NON_STORABLE_PROVIDERS = new Set([MAPBOX_PROVIDER_ID])"), "the sync half must know which sources may not be stored");
  assert.ok(sync.includes("payload.dryRun === true || !!(provenance && provenance.storable === false)"), "dryRun must be forced from provenance, not left to the caller");
  assert.ok(/storable: raw\.storable === false \|\| NON_STORABLE_PROVIDERS\.has/.test(sync), "a Mapbox provenance must read as not storable whatever the caller claims");
  const dry = background.indexOf("if (base.dryRun) {");
  const save = background.indexOf("await saveOverlay(");
  assert.ok(dry > 0 && dry < save, "a dry run must return before the overlay is saved");
  assert.ok(background.slice(dry, save).includes("return await finish("), "the dry run must finish without falling through to the save");
  assert.ok(page.includes("dryRun: true, provenance: sourceTest.provenance"), "Studio sends Mapbox scans as dry runs with their provenance");
});

test("the new tests run in CI", () => {
  ["dev/ai-scan-core.test.js", "dev/course-map-ai-scan.test.js", "dev/map-source-providers.test.mjs"].forEach(t => {
    assert.ok(workflow.includes("node " + t), t + " is not in structural-smoke.yml");
  });
});

let failed = 0;
tests.forEach((t) => {
  try { t.fn(); console.log("  ok  " + t.name); }
  catch (error) { failed++; console.log("FAIL  " + t.name + "\n      " + (error && error.message)); }
});
console.log((failed ? "FAILED " + failed + "/" : "passed ") + tests.length + " ai scan wiring checks");
process.exit(failed ? 1 : 0);
