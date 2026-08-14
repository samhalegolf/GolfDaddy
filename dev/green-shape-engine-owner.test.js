/* The Green Shape (Green Wand) engine is server-side only.
 *
 * This test used to assert the opposite of half of what it asserts now. Its job was to pin
 * that the engine had been lifted out of gd-app-core.js into its own browser file, and that
 * the standalone Wand UI around it was gone. The first half is obsolete: the AutoMapper moved
 * fully server-side (functions/lib/gd-automapper-core.mjs), which left the browser engine with
 * no caller at all, so scripts/gd-green-shape-engine.js was deleted rather than left shipping
 * as a 700-line copy that nothing runs and nothing checks.
 *
 * What is still worth pinning, and is what remains below: the engine does not creep back into
 * gd-app-core.js, the retired Wand UI stays retired across the mapper, the right rail and the
 * route audit, and the deleted files stay deleted.
 *
 * Run: node dev/green-shape-engine-owner.test.js */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const core = fs.readFileSync(path.join(root, "scripts", "gd-app-core.js"), "utf8");
const pinLock = fs.readFileSync(path.join(root, "scripts", "gd-course-library-pin-lock.js"), "utf8");
const brandIcons = fs.readFileSync(path.join(root, "scripts", "inline", "gd-brand-icon-render.js"), "utf8");
const routeAudit = fs.readFileSync(path.join(root, "scripts", "gd-route-audit.js"), "utf8");

function assertContains(source, needle, message) {
  assert(source.includes(needle), message || `contains ${needle}`);
}

function assertNotContains(source, needle, message) {
  assert(!source.includes(needle), message || `does not contain ${needle}`);
}

// ---- the browser engine is gone, and stays gone ----

assert(!fs.existsSync(path.join(root, "scripts", "gd-green-shape-engine.js")),
  "the browser Green Shape Engine was deleted - the server core is the only copy");
assertNotContains(index, 'id="gdGreenShapeEngine"', "and is no longer shipped to the browser");
assertNotContains(index, "gd-green-shape-engine.js", "no stale script tag points at it");

/* The globals it used to publish must not reappear anywhere on the client. A second
   implementation of this algorithm is exactly what was just removed. */
assertNotContains(core, "window.GolfDaddyGreenWandEngine={", "core does not re-assign the detector API");
assertNotContains(core, "function findTonalEdgeCandidates", "core does not own probe candidate detection");
assertNotContains(core, "function buildHealthyBubble", "core does not own magnetic healthy-bubble fitting");
assertNotContains(core, "engine.analyzeGreenWand", "core does not call a client detector");

assertContains(core, "Standalone Wand UI retired", "core leaves a narrow retirement note");

// ---- the server core is the owner ----

const serverCore = fs.readFileSync(path.join(root, "functions", "lib", "gd-green-shape-core.mjs"), "utf8");
assertContains(serverCore, "now the only copy", "the server engine says it is the owner");
assertContains(serverCore, "analyzeGreenWand", "and still exposes the detector entry point");
assertContains(serverCore, "validateDetection", "and deterministic crop-level validation");

// ---- shared green rendering stays where it always was ----

assertContains(core, "function drawGreenPolygon", "shared saved-green rendering stays in core");
assertContains(core, "function drawGreenDistances", "shared green distance labels stay in core");

// ---- the standalone Wand UI stays retired ----

assertNotContains(index, 'id="gdWandBeltLayersV1"', "retired Wand belt layer is not loaded");
assertNotContains(index, 'id="gdWandFlowLayersV1"', "retired Wand flow layer is not loaded");
assertNotContains(index, 'id="gdWandPanel"', "standalone Wand panel is retired");
assertNotContains(index, "gdWandDiagStyle", "dead Wand diagnostics CSS is no longer loaded");
assertNotContains(index, "gdWandSampleTruthStyleV1", "dead Wand sample-truth CSS is no longer loaded");

assertNotContains(core, "function scanGreen", "standalone Wand scanner is retired from core");
assertNotContains(core, "function openGpsWand", "standalone Wand route entry is retired from core");
assertNotContains(core, "function toggleGreenWand", "standalone Wand toggle is retired from core");

assertNotContains(pinLock, "function startMapperGreenWand", "mapper no longer opens standalone Wand UI");
assertNotContains(pinLock, "hydrateMapperGreenForWand", "mapper no longer hydrates Wand-compatible globals");
assertNotContains(pinLock, "saveCurrentGreen('wand_accepted')", "mapper no longer wraps accepted Wand output");
assertNotContains(pinLock, "automapperRunGreenShapeRefinement", "the AutoMapper Green Shape refinement handoff no longer runs client-side");
assertNotContains(pinLock, "automapperBuildGreenShapeCrop", "the client no longer builds AutoMapper green-shape imagery crops");
assertNotContains(pinLock, "await saveOsmAutoHole", "client-side AutoMapper persistence (saveOsmAutoHole) no longer exists");
assertNotContains(pinLock, "openGpsWand({source:'automapper-green-shape-engine'", "refinement path does not activate Wand UI");
assertNotContains(brandIcons, "greenToolBtn", "right rail no longer creates a standalone Wand button");
assertNotContains(routeAudit, "dockGreen", "canonical route audit no longer routes a Green dock button");
assertNotContains(routeAudit, "openGpsWand", "canonical route audit no longer preserves standalone Wand entrypoints");

assert(!fs.existsSync(path.join(root, "scripts", "inline", "gd-wand-belt-layers-v1.js")), "retired Wand belt file was deleted");
assert(!fs.existsSync(path.join(root, "scripts", "inline", "gd-wand-flow-layers-v1.js")), "retired Wand flow file was deleted");
assert(!fs.existsSync(path.join(root, "styles", "inline", "gd-wand-diag-style.css")), "dead Wand diagnostics CSS file was deleted");
assert(!fs.existsSync(path.join(root, "styles", "inline", "gd-wand-sample-truth-style-v1.css")), "dead Wand sample-truth CSS file was deleted");

console.log("green-shape-engine-owner tests passed");
