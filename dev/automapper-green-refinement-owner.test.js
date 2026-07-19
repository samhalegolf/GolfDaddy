const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const engine = fs.readFileSync(path.join(root, "scripts", "gd-green-shape-engine.js"), "utf8");
const mapper = fs.readFileSync(path.join(root, "scripts", "gd-course-library-pin-lock.js"), "utf8");
const core = fs.readFileSync(path.join(root, "scripts", "gd-app-core.js"), "utf8");

function assertContains(source, needle, message) {
  assert(source.includes(needle), message || `contains ${needle}`);
}

function assertNotContains(source, needle, message) {
  assert(!source.includes(needle), message || `does not contain ${needle}`);
}

function count(source, needle) {
  return source.split(needle).length - 1;
}

function lineIndex(source, needle) {
  const lines = source.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(needle));
  assert(index >= 0, `missing line containing ${needle}`);
  return index;
}

assertContains(engine, "async function detect(input)", "GDGreenShapeEngine.detect exists in the engine owner");
assertContains(engine, "function validateDetection(result, constraints)", "GDGreenShapeEngine.validateDetection exists in the engine owner");
assertContains(engine, "detect,", "engine export includes detect");
assertContains(engine, "validateDetection,", "engine export includes validateDetection");
assertContains(engine, "window.GDGreenShapeEngine=window.GolfDaddyGreenWandEngine", "future-facing Green Shape alias is assigned");

assert.strictEqual(count(mapper, "async function automapperRunGreenShapeRefinement"), 1, "AutoMapper has exactly one Green Shape refinement adapter");
assert.strictEqual(count(mapper, "await automapperRunGreenShapeRefinement({"), 1, "mapping owner has one insertion point for refinement");
assertContains(mapper, "const refinement=!state.green?await automapperRunGreenShapeRefinement", "mapping owner calls the refinement before saving a green");
assertContains(mapper, "const engine=automapperGreenShapeEngine();", "adapter resolves the Green Shape engine");
assertContains(mapper, "const detected=await engine.detect({", "adapter calls GDGreenShapeEngine.detect");
assertNotContains(engine, "automapperRunGreenShapeRefinement", "engine does not call back into AutoMapper");
assertNotContains(engine, "saveOsmAutoHole", "engine does not own AutoMapper persistence");
assertNotContains(engine, "saveCourseObject", "engine does not own course object persistence");

assertContains(mapper, "function automapperBuildGreenShapeCrop(manifest,centerPx)", "crop construction stays in mapping ownership");
assertContains(mapper, "automapperReadCapturedManifest(course,hole)", "adapter uses captured-surface imagery");
assertContains(mapper, "gd_captured_hole_frame_v19_", "captured-surface crop key remains the crop source");
assertContains(mapper, "if(attempt&&!isCurrentMappingAttempt(attempt))return skip('stale-mapping-attempt');", "adapter rejects stale mapping attempts");
assertContains(mapper, "if(!manifest)return skip('no-renderable-crop');", "adapter has a no-imagery gate");
assertContains(mapper, "if(!centerPx)return skip('projection-unavailable');", "adapter has a projection gate");
assertContains(mapper, "if(!detected||!detected.ok)return reject(detected?.rejectionReason||'engine-rejected'", "adapter records engine rejections");
assertContains(mapper, "if(!verdict.ok)return reject(verdict.reason", "adapter records geometry validation rejections");
assertContains(mapper, "return {accepted:true,greenShape:simplified", "adapter returns accepted geometry without saving it directly");

assertContains(mapper, "function saveCourseObject(input={})", "existing course object save path owns persistence");
assertContains(mapper, "source:greenSource", "green source metadata is persisted by saveCourseObject");
assertContains(mapper, "greenShapeRefinement:{engine:'GDGreenShapeEngine'", "accepted refinement metadata is attached before persistence");
assertContains(mapper, "source:greenSource,", "accepted geometry delegates to the existing save path");
assertContains(mapper, "maxDedupeDistanceM:4", "accepted green object uses the existing dedupe gate");
assertContains(mapper, "const refinement=!state.green?", "existing geometry precedence blocks refinement when a green is already mapped");
assertContains(mapper, ":{accepted:false,phase:'skipped',reason:'green-already-mapped'}", "stronger existing geometry is preserved");

assertContains(mapper, "automapper-green-shape-refinement-accepted", "diagnostics record accepted refinements");
assertContains(mapper, "automapper-green-shape-refinement-rejected", "diagnostics record rejected refinements");
assertContains(mapper, "automapper-green-shape-refinement-skipped", "diagnostics record skipped refinements");
assertContains(mapper, "details:Object.assign({},detail,{skipReason:reason})", "skips keep specific reasons");
assertContains(mapper, "details:Object.assign({},detail,extra,{rejectionReason:reason})", "rejections keep specific reasons");

assertContains(mapper, "function startMapperGreenWand", "standalone Wand fallback remains present");
assertContains(mapper, "saveCurrentGreen('wand_accepted')", "standalone Wand acceptance path remains present");
assertNotContains(mapper, "openGpsWand({source:'automapper-green-shape-engine'", "refinement path does not invoke standalone Wand UI");
assertNotContains(mapper, "startMapperGreenWand({source:'automapper-green-shape-engine'", "refinement path does not invoke mapper Wand UI");
assertNotContains(mapper, "gdCompactWandOpen({source:'automapper-green-shape-engine'", "refinement path does not invoke compact Wand UI");
assertNotContains(mapper, "gdWandActive", "integration does not assign Wand-active body or shell state");
assertNotContains(mapper, "gdShellLayer=\"wand\"", "integration does not move shell ownership to Wand");
assertNotContains(mapper, "document.body.classList.add('wand", "integration does not add Wand body classes");
assertNotContains(mapper, "document.body.classList.add(\"wand", "integration does not add Wand body classes");

assertContains(core, "function scanGreen", "standalone Wand UI remains outside the AutoMapper adapter");
assertContains(core, "engine.analyzeGreenWand", "standalone Wand UI delegates to the engine separately");
assertNotContains(core, "automapperRunGreenShapeRefinement", "core does not own the AutoMapper refinement adapter");

assert(
  lineIndex(index, 'id="gdGreenShapeEngine"') < lineIndex(index, "scripts/gd-course-library-pin-lock.js"),
  "engine script loads before AutoMapper code that consumes it"
);

console.log("automapper-green-refinement-owner tests passed");
