const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const core = fs.readFileSync(path.join(root, "scripts", "gd-app-core.js"), "utf8");
const engine = fs.readFileSync(path.join(root, "scripts", "gd-green-shape-engine.js"), "utf8");
const pinLock = fs.readFileSync(path.join(root, "scripts", "gd-course-library-pin-lock.js"), "utf8");
const brandIcons = fs.readFileSync(path.join(root, "scripts", "inline", "gd-brand-icon-render.js"), "utf8");
const routeAudit = fs.readFileSync(path.join(root, "scripts", "gd-route-audit.js"), "utf8");

function assertContains(source, needle, message) {
  assert(source.includes(needle), message || `contains ${needle}`);
}

function assertNotContains(source, needle, message) {
  assert(!source.includes(needle), message || `does not contain ${needle}`);
}

function assignmentCount(source, expression) {
  return (source.match(new RegExp(expression, "g")) || []).length;
}

assertContains(index, 'id="gdGreenShapeEngine"', "Green Shape Engine owner is loaded before core");
assert(index.indexOf('id="gdGreenShapeEngine"') < index.indexOf("scripts/gd-app-core.js"), "Green Shape Engine loads before core");
assertNotContains(index, 'id="gdWandBeltLayersV1"', "retired Wand belt layer is not loaded");
assertNotContains(index, 'id="gdWandFlowLayersV1"', "retired Wand flow layer is not loaded");
assertNotContains(index, 'id="gdWandPanel"', "standalone Wand panel is retired");
assertNotContains(index, "gdWandDiagStyle", "dead Wand diagnostics CSS is no longer loaded");
assertNotContains(index, "gdWandSampleTruthStyleV1", "dead Wand sample-truth CSS is no longer loaded");

assertContains(core, "Standalone Wand UI retired", "core leaves a narrow retirement note");
assertNotContains(core, "function findTonalEdgeCandidates", "core no longer owns probe candidate detection");
assertNotContains(core, "function buildHealthyBubble", "core no longer owns magnetic healthy-bubble fitting");
assertNotContains(core, "window.GolfDaddyGreenWandEngine={", "core no longer assigns the detector API");
assertContains(engine, "Sandbox Green Wand Engine v2", "new owner contains the current detector block");
assertContains(engine, "window.GolfDaddyGreenWandEngine={", "compatibility detector API is assigned in owner");
assertContains(engine, "window.GDGreenShapeEngine=window.GolfDaddyGreenWandEngine", "future engine alias is assigned");
assertContains(engine, "analyzeGreenWand", "current detector exposes analyzeGreenWand");
assertContains(engine, "async function detect", "engine exposes a data-oriented AutoMapper detection contract");
assertContains(engine, "validateDetection", "engine exposes deterministic crop-level validation");
assertContains(engine, "findTonalEdgeCandidates", "probe candidate detection lives in the engine owner");
assertContains(engine, "buildRidgeLines", "ridge detection lives in the engine owner");
assertContains(engine, "buildHealthyBubble", "magnetic healthy-bubble fitting lives in the engine owner");
assertContains(engine, "buildOuterShell", "polygon/shell generation lives in the engine owner");
assert.strictEqual(assignmentCount(engine, "window\\.GolfDaddyGreenWandEngine\\s*=(?!=)"), 1, "one current detector global assignment exists");

assertContains(core, "function drawGreenPolygon", "shared saved-green rendering stays in core");
assertContains(core, "function drawGreenDistances", "shared green distance labels stay in core");
assertNotContains(core, "function scanGreen", "standalone Wand scanner is retired from core");
assertNotContains(core, "function openGpsWand", "standalone Wand route entry is retired from core");
assertNotContains(core, "function toggleGreenWand", "standalone Wand toggle is retired from core");
assertNotContains(core, "engine.analyzeGreenWand", "core no longer hosts standalone engine UI calls");

assert(!fs.existsSync(path.join(root, "scripts", "inline", "gd-wand-belt-layers-v1.js")), "retired Wand belt file was deleted");
assert(!fs.existsSync(path.join(root, "scripts", "inline", "gd-wand-flow-layers-v1.js")), "retired Wand flow file was deleted");
assert(!fs.existsSync(path.join(root, "styles", "inline", "gd-wand-diag-style.css")), "dead Wand diagnostics CSS file was deleted");
assert(!fs.existsSync(path.join(root, "styles", "inline", "gd-wand-sample-truth-style-v1.css")), "dead Wand sample-truth CSS file was deleted");

assertNotContains(pinLock, "function startMapperGreenWand", "mapper no longer opens standalone Wand UI");
assertNotContains(pinLock, "hydrateMapperGreenForWand", "mapper no longer hydrates Wand-compatible globals");
assertNotContains(pinLock, "saveCurrentGreen('wand_accepted')", "mapper no longer wraps accepted Wand output");
assertContains(pinLock, "async function automapperRunGreenShapeRefinement", "AutoMapper owns a narrow Green Shape Engine refinement handoff");
assertContains(pinLock, "automapperBuildGreenShapeCrop", "AutoMapper supplies a constrained imagery crop to the engine");
assertContains(pinLock, "engine.detect", "AutoMapper calls the engine data API, not the standalone Wand UI");
assertContains(pinLock, "automapper-green-shape-refinement-accepted", "AutoMapper records accepted refinement diagnostics");
assertContains(pinLock, "automapper-green-shape-refinement-rejected", "AutoMapper records controlled rejection diagnostics");
assertContains(pinLock, "automapper-green-shape-refinement-skipped", "AutoMapper records deterministic skip diagnostics");
assertContains(pinLock, "osm_auto_green_refined", "accepted refinement is labelled as an AutoMapper refinement source");
assertContains(pinLock, "await saveOsmAutoHole", "AutoMapper persistence awaits the internal refinement stage");
assertNotContains(pinLock, "openGpsWand({source:'automapper-green-shape-engine'", "refinement path does not activate Wand UI");
assertNotContains(brandIcons, "greenToolBtn", "right rail no longer creates a standalone Wand button");
assertNotContains(routeAudit, "dockGreen", "canonical route audit no longer routes a Green dock button");
assertNotContains(routeAudit, "openGpsWand", "canonical route audit no longer preserves standalone Wand entrypoints");

console.log("green-shape-engine-owner tests passed");
