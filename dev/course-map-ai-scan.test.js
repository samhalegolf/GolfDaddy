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
  assert.ok(background.includes("parseScanAnswer(answer.text, shapes, task)"), "the answer is read against the recorded shapes and the task, so a correction lands on the one it replaces and a pin task yields pins");
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
  assert.ok(overlay.includes('Object.prototype.hasOwnProperty.call(payload, "courseMap")') && overlay.includes("writeCourseMap(ownerId, courseMap)"), "a course map save is its own request on the overlay API");
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

test("the task rides on the request: the sync half parks it, the background half resolves it and reports it", () => {
  assert.ok(sync.includes("task: cleanTask(payload.task)"), "the sync half must park the task with the request");
  assert.ok(sync.includes("prompt: typeof raw.prompt === \"string\" ? raw.prompt.slice(0, AI_SCAN_PROMPT_MAX) : null"), "the operator's words are capped, never trusted whole");
  assert.ok(sync.includes("AI_SCAN_OUTPUTS.includes(raw.output) ? raw.output : task.output"), "the output is one the parser knows");
  assert.ok(background.includes("resolveTask(requested, shapes,"), "the background half resolves the task against what is in view");
  assert.ok(background.includes("if (task.needsCourseMap && !courseMap) {") && background.includes("needs a course map and this course has none"), "a course-map task fails before the model runs when no map is saved");
  assert.ok(page.includes("entry.needsCourseMap && !session.courseMap"), "Studio warns when the picked task needs a course map the course lacks");
  assert.ok(background.includes("await storedTask(requested ? requested.id : null, shapes)"), "a request without words runs the operator's saved words for the task");
  assert.ok(background.includes("base.task = { id: task.id, label: task.label, output: task.output, prompt: task.prompt }"), "what ran - words included - goes on the row");
  assert.ok(background.includes("parseScanAnswer(answer.text, shapes, task)"), "the answer is read as the task says - pins or outlines");
  assert.ok(background.includes("if (f.pin) counts.pins += 1;"), "a dry run counts pins");
});

test("the operator's words are edited through /api/course-map-ai-prompts, admin only, stored per task", () => {
  const prompts = read("functions/course-map-ai-prompts.mjs");
  const store = read("functions/lib/gd-ai-scan-prompts-store.mjs");
  assert.ok(prompts.includes('path: "/api/course-map-ai-prompts"'), "the function does not declare its /api path");
  assert.ok(toml.includes("/api/course-map-ai-prompts"), "no /api/course-map-ai-prompts redirect in netlify.toml");
  assert.ok(prompts.includes("verifiedAdminEmail(req)") && prompts.includes("if (!admin) return json(403"), "a non-admin must be refused");
  assert.ok(prompts.includes("scanPromptOutline(") && prompts.includes("outline:"), "Studio is shown what surrounds the words");
  assert.ok(prompts.includes("if (payload.reset)") && prompts.includes("deleteStoredTask(task.id)"), "reset goes back to the default by deleting the row");
  assert.ok(prompts.includes("prompt.length > AI_SCAN_PROMPT_MAX"), "words over the cap are refused with a sentence");
  assert.ok(store.includes('AI_SCAN_PROMPTS_TABLE = "ai_scan_prompts"'), "the store names the table");
  assert.ok(store.includes(".catch(() => [])"), "a missing table reads as nothing stored, never a failed scan");
  assert.ok(fs.existsSync(path.join(ROOT, "supabase/migrations/20261014_create_ai_scan_prompts.sql")), "no migration creates ai_scan_prompts");
});

test("Studio's AI help panel: tasks from the server, words editable and saved, the run carries what is on screen", () => {
  assert.ok(page.includes('var AI_PROMPTS_API = "/api/course-map-ai-prompts"'), "the page does not talk to the prompts endpoint");
  assert.ok(page.includes('data-gd-overlay="ai-panel"') && page.includes("function renderAiPanel(") && page.includes("function toggleAiPanel("), "no AI help panel");
  assert.ok(page.includes(">AI help…</button>"), "the button opens the panel rather than scanning blind");
  assert.ok(page.includes('el.ai.addEventListener("click", toggleAiPanel)'), "the AI button must toggle the panel");
  assert.ok(page.includes('data-gd-ai="task"') && page.includes('data-gd-ai="prompt"') && page.includes('data-gd-ai="output"') && page.includes('data-gd-ai="notes"'), "task, words, output and a per-scan note are all on the panel");
  assert.ok(page.includes('data-gd-ai="save"') && page.includes('data-gd-ai="reset"') && page.includes("function saveAiTask("), "words save and reset");
  assert.ok(page.includes('data-gd-ai="outline"') && page.includes("entry.outline"), "what Claude receives around the words is shown");
  assert.ok(page.includes("if (task) body.task = { id: task.id, output: task.output, prompt: task.prompt };"), "the scan is sent the task as the panel has it - what runs is what is on screen");
  assert.ok(page.includes("aiTask: session.aiTask"), "the task picked last is remembered");
  assert.ok(page.includes('scan.task.output === "pins"') && page.includes("shape them with the wands"), "a pin answer is described as pins to shape");
  assert.ok(page.includes("if (f.pin) {") && page.includes("<circle cx="), "a dry run draws pins as dots");
  assert.ok(!page.includes("Scan this view with AI"), "the old blind-scan button is gone, not left beside the panel");
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
