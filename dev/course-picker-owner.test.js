const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const picker = fs.readFileSync(path.join(root, "scripts", "inline", "gd-course-picker-search-v2.js"), "utf8");
const core = fs.readFileSync(path.join(root, "scripts", "gd-app-core.js"), "utf8");
const routeAudit = fs.readFileSync(path.join(root, "scripts", "gd-route-audit.js"), "utf8");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");

function count(source, needle) {
  return source.split(needle).length - 1;
}

assert.strictEqual(count(picker, "window.GDCoursePicker=api"), 1, "picker exposes exactly one public owner assignment");
assert(!core.includes("window.GDCoursePicker=api"), "core does not expose the picker owner");
assert(!picker.includes("GDCoursePickerOwner"), "retired partial owner name is gone from picker");
assert(!core.includes("GDCoursePickerOwner"), "retired partial owner name is gone from core");

assert.strictEqual(count(picker, "function selectCourseForPlay"), 1, "picker has one selection owner");
assert.strictEqual(count(picker, "function requestPickerGps"), 1, "picker has one one-shot GPS owner");
assert.strictEqual(count(picker, "function invokeMappingOnce"), 1, "picker has one mapping invocation gate");
assert(picker.includes("const controller=window.runCourseMappingAttempt||window.gdRunCourseMappingAttempt;"), "picker calls the mapping controller boundary");
assert(!picker.includes("gdResolveCoursePlayHole"), "picker does not use the legacy resolver alias as an owner");

const forbiddenPickerInternals = [
  "autoMapOsmCourse",
  "resolveCourseGeometryForAutoMapper",
  "shouldRunForAutoMapper",
  "GDGreenShapeEngine",
  "GolfDaddyGreenWandEngine",
  "beginInteractiveGreenFallback",
  "gdBeginInteractiveGreenFallback",
  "gdClaude",
  "claude-hole"
];
for (const forbidden of forbiddenPickerInternals) {
  assert(!picker.includes(forbidden), `picker must not implement or call ${forbidden}`);
}

assert(index.includes("window.GDCoursePicker.open({source:'home-play',returnTarget:'home'})"), "static Play tile delegates to GDCoursePicker.open");
assert(routeAudit.includes('return window.GDCoursePicker.open({source:"route-audit",returnTarget:"gps"});'), "route audit defers picker opening to owner");

const legacyDelegates = [
  "window.renderCourses=function(courses){return api.renderCourses(courses);};",
  "window.manualSearch=function(query){return api.search(query);};",
  "window.gdOpenChangeCourse=function(event){return api.open({event,source:\"change-course\",returnTarget:\"gps\"});};",
  "window.gdOpenCoursePickerCourse=function(course){return api.selectCourse(course,{source:\"legacy-global\"});};",
  "window.gdOpenCoursePickerSelectionFromElement=function(element){return api.selectFromElement(element);};",
  "window.gdCoursePickerRequestGps=function(){return api.requestLocation();};"
];
for (const delegate of legacyDelegates) {
  assert(picker.includes(delegate), `legacy global delegates through owner: ${delegate}`);
}

assert(core.includes("window.GDCoursePickerCoreBridge={"), "core retains only a named bridge for picker dependencies");
assert(core.includes('return window.GDCoursePicker.selectCourse(course,{source:"core-compat-select"});'), "core course-open compatibility delegates to the owner when loaded");
assert(!picker.includes("window.runCourseMappingAttempt||window.gdRunCourseMappingAttempt||window.gdResolveCoursePlayHole"), "picker has no fallback chain that restores old resolver ownership");

console.log("course-picker-owner tests passed");
