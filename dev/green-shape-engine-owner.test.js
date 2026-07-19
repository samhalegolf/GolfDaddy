const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const core = fs.readFileSync(path.join(root, "scripts", "gd-app-core.js"), "utf8");
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
assertContains(index, 'id="gdWandPanel"', "standalone Wand panel still exists before extraction");

assertContains(core, "Sandbox Green Wand Engine v2", "core still contains the current detector block before extraction");
assertContains(core, "window.GolfDaddyGreenWandEngine={", "current detector API is assigned");
assertContains(core, "analyzeGreenWand", "current detector exposes analyzeGreenWand");
assertContains(core, "findTonalEdgeCandidates", "probe candidate detection remains in the engine block");
assertContains(core, "buildRidgeLines", "ridge detection remains in the engine block");
assertContains(core, "buildHealthyBubble", "magnetic healthy-bubble fitting remains in the engine block");
assertContains(core, "buildOuterShell", "polygon/shell generation remains in the engine block");
assert.strictEqual(assignmentCount(core, "window\\.GolfDaddyGreenWandEngine\\s*=(?!=)"), 1, "one current detector global assignment exists");

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
