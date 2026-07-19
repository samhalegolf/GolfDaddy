const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const core = fs.readFileSync(path.join(root, "scripts", "gd-app-core.js"), "utf8");
const engine = fs.readFileSync(path.join(root, "scripts", "gd-green-shape-engine.js"), "utf8");
const belt = fs.readFileSync(path.join(root, "scripts", "inline", "gd-wand-belt-layers-v1.js"), "utf8");
const flow = fs.readFileSync(path.join(root, "scripts", "inline", "gd-wand-flow-layers-v1.js"), "utf8");
const pinLock = fs.readFileSync(path.join(root, "scripts", "gd-course-library-pin-lock.js"), "utf8");

function assertContains(source, needle, message) {
  assert(source.includes(needle), message || `contains ${needle}`);
}

function assertNotContains(source, needle, message) {
  assert(!source.includes(needle), message || `does not contain ${needle}`);
}

function assignmentCount(source, expression) {
  return (source.match(new RegExp(expression, "g")) || []).length;
}

assertContains(index, 'id="gdWandBeltLayersV1"', "merged Wand belt layer is loaded");
assertContains(index, 'id="gdWandFlowLayersV1"', "merged Wand flow layer is loaded");
assertContains(index, 'id="gdGreenShapeEngine"', "Green Shape Engine owner is loaded before core");
assert(index.indexOf('id="gdGreenShapeEngine"') < index.indexOf("scripts/gd-app-core.js"), "Green Shape Engine loads before core");
assertContains(index, 'id="gdWandPanel"', "standalone Wand panel still exists before extraction");

assertContains(core, "Green Shape Engine ownership moved to scripts/gd-green-shape-engine.js", "core leaves a narrow ownership note");
assertNotContains(core, "function findTonalEdgeCandidates", "core no longer owns probe candidate detection");
assertNotContains(core, "function buildHealthyBubble", "core no longer owns magnetic healthy-bubble fitting");
assertNotContains(core, "window.GolfDaddyGreenWandEngine={", "core no longer assigns the detector API");
assertContains(engine, "Sandbox Green Wand Engine v2", "new owner contains the current detector block");
assertContains(engine, "window.GolfDaddyGreenWandEngine={", "compatibility detector API is assigned in owner");
assertContains(engine, "window.GDGreenShapeEngine=window.GolfDaddyGreenWandEngine", "future engine alias is assigned");
assertContains(engine, "analyzeGreenWand", "current detector exposes analyzeGreenWand");
assertContains(engine, "findTonalEdgeCandidates", "probe candidate detection lives in the engine owner");
assertContains(engine, "buildRidgeLines", "ridge detection lives in the engine owner");
assertContains(engine, "buildHealthyBubble", "magnetic healthy-bubble fitting lives in the engine owner");
assertContains(engine, "buildOuterShell", "polygon/shell generation lives in the engine owner");
assert.strictEqual(assignmentCount(engine, "window\\.GolfDaddyGreenWandEngine\\s*=(?!=)"), 1, "one current detector global assignment exists");

assertContains(core, "function gdBuildGreenCentredTileCropV2", "tile crop remains an adapter, not the pure detector");
assertContains(core, "function gdWandCanvasPointToLatLng", "pixel-to-map conversion remains an adapter");
assertContains(core, "function scanGreen", "standalone UI still calls the detector");
assertContains(core, "engine.analyzeGreenWand", "standalone UI delegates detection to the engine");

assertContains(flow, "window.gdCompactWandOpen", "compact Wand flow is UI-only orchestration");
assertContains(flow, "window.openGpsWand=openAndScan", "flow layer replaces the open handler");
assertContains(belt, "window.collectWandDiagnostics=function(){return ''}", "diagnostics are currently inert");
assertContains(belt, "window.gdShowWandSampleTruth=function(){}", "sample-truth UI is currently inert");

assertContains(pinLock, "function startMapperGreenWand", "mapper fallback still opens standalone Wand UI");
assertContains(pinLock, "hydrateMapperGreenForWand", "mapper hydrates Wand-compatible globals");
assertContains(pinLock, "saveCurrentGreen('wand_accepted')", "mapper receives accepted Wand output through save wrapper");
assertNotContains(pinLock, "GolfDaddyGreenWandEngine.analyzeGreenWand", "AutoMapper/course library does not call detector directly");

console.log("green-shape-engine-owner tests passed");
