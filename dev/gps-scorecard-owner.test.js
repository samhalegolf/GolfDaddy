const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const core = fs.readFileSync(path.join(root, "scripts", "gd-app-core.js"), "utf8");
const owner = fs.readFileSync(path.join(root, "scripts", "inline", "gd-gps-scorecard-owner-v1.js"), "utf8");
const runtime = fs.readFileSync(path.join(root, "scripts", "inline", "gd-gps-play-runtime-owner-v1.js"), "utf8");
const flow = fs.readFileSync(path.join(root, "scripts", "inline", "gd-gps-play-flow-layers-v1.js"), "utf8");
const beta = fs.readFileSync(path.join(root, "scripts", "inline", "gd-gps-beta-mode-shell.js"), "utf8");
const pinLock = fs.readFileSync(path.join(root, "scripts", "gd-course-library-pin-lock.js"), "utf8");
const multiNine = fs.readFileSync(path.join(root, "scripts", "gd-multi-nine-courses.js"), "utf8");

function assertContains(source, needle, message) {
  assert(source.includes(needle), message || `contains ${needle}`);
}

function assertNotContains(source, needle, message) {
  assert(!source.includes(needle), message || `does not contain ${needle}`);
}

function assignmentCount(source, expression) {
  return (source.match(new RegExp(expression, "g")) || []).length;
}

assertContains(index, 'id="gdGpsScorecardOwnerV1"', "scorecard owner is loaded explicitly");
assertContains(owner, "window.GDGpsScorecard=GDGpsScorecard", "one scorecard owner API exists");
assertContains(owner, "setHoleScore", "owner exposes score entry API");
assertContains(owner, "syncCurrentHole", "owner exposes current-hole sync API");
assertContains(owner, "reset", "owner exposes reset API");
assertContains(owner, "destroy", "owner exposes destroy API");

[
  "function gdScorecardNormalizeName",
  "function gdEnsureScorecardForCourse",
  "function openScorecard",
  "function renderScorecard",
  "function saveHoleScore",
  "function playSelectedHole",
  "function setHole(",
  "function adjustHoleScore",
  "const scorecard=",
  "GD_SCORECARD_WEBSITE_SOURCES"
].forEach((needle) => assertNotContains(core, needle, `core no longer defines moved scorecard implementation: ${needle}`));
assertContains(core, "GPS scorecard ownership moved to scripts/inline/gd-gps-scorecard-owner-v1.js", "core leaves a narrow ownership note");

assertNotContains(runtime, "gd-gps-scorecard-owner-v1.js", "runtime no longer embeds the scorecard owner section");
assert.strictEqual(assignmentCount(owner, "window\\.GDGpsScorecard\\s*=(?!=)"), 1, "owner assigns the scorecard API once");
assert.strictEqual(assignmentCount(runtime, "window\\.GDGpsScorecard\\s*=(?!=)"), 0, "runtime does not replace scorecard API");
assert.strictEqual(assignmentCount(flow, "window\\.GDGpsScorecard\\s*=(?!=)"), 0, "play flow does not replace scorecard API");

assertContains(flow, "window.GDGpsScorecard.queueNextHole", "next-hole score save delegates queued score work to owner");
assertNotContains(flow, "function wrapSaveScore", "play flow no longer wraps saveHoleScore");
assertNotContains(flow, "function wrapRenderScorecard", "play flow no longer wraps renderScorecard");
assertNotContains(flow, "__gdPlayFlowWrapped", "legacy play-flow scorecard wrapper marker is gone");

assertNotContains(beta, "window.openScorecard=w", "beta shell no longer wraps openScorecard");
assertNotContains(pinLock, "window.playSelectedHole=wrapped", "course library no longer wraps playSelectedHole");
assertNotContains(pinLock, "window.saveHoleScore=wrapped", "course library no longer wraps saveHoleScore");
assertNotContains(multiNine, "function wrapRenderScorecard", "multi-nine no longer carries a render wrapper");
assertNotContains(multiNine, "window.renderScorecard = wrapped", "multi-nine no longer wraps renderScorecard");

console.log("gps-scorecard-owner tests passed");
