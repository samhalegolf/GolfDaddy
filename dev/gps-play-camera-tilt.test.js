const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "scripts", "inline", "gd-gps-play-camera-tilt-v1.js"), "utf8");
const css = fs.readFileSync(path.join(root, "styles", "inline", "gd-gps-play-camera-tilt-v1.css"), "utf8");

function assertContains(source, needle, message) {
  assert(source.includes(needle), message || `contains ${needle}`);
}

function assertNotContains(source, needle, message) {
  assert(!source.includes(needle), message || `does not contain ${needle}`);
}

new Function(script);

assertContains(html, "gd-gps-play-camera-tilt-v1.css?v=tilt02", "tilt CSS cache-bust is updated");
assertContains(html, "gd-gps-play-camera-tilt-v1.js?v=tilt02", "tilt script cache-bust is updated");
assertContains(script, "AUTO_LOCK_TILT_DEG=32", "GPS Play camera tilt locks to the chosen 32 degree presentation");
assertContains(script, "window.gdSyncGpsPlayCameraTilt", "automatic tilt sync hook remains available to lock/unlock owners");
assertContains(script, "removeTiltControls", "tilt module cleans up older injected controls");
assertContains(script, '"gdGpsPlayCameraTiltBtn","gdGpsCameraTiltRow"', "old tilt controls are removed if a cached page injected them");
assertNotContains(script, 'document.createElement("button")', "tilt module no longer injects a user-facing button");
assertNotContains(script, 'button.id="gdGpsPlayCameraTiltBtn"', "floating camera tilt button is not created");
assertNotContains(script, 'row.id="gdGpsCameraTiltRow"', "settings camera tilt row is not created");
assertNotContains(script, "gdGpsCameraTiltToggle", "settings camera tilt toggle is not created");
assertNotContains(css, "gdGpsPlayCameraTiltBtn", "floating camera tilt button CSS is removed");
assertNotContains(css, "gdGpsCameraTiltToggle", "settings camera tilt toggle CSS is removed");

console.log("gps-play-camera-tilt tests passed");
