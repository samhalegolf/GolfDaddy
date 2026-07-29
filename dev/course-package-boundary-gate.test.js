/* gd-course-package-boundary-gate-v1.js: owns exactly the swap-timing decision described in
 * its header comment - no rendering, no hole tracking, no globals reached into. Loaded in a
 * bare VM sandbox with nothing but `window`, proving it has no hidden dependencies. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "scripts", "inline", "gd-course-package-boundary-gate-v1.js"), "utf8");

const window = {};
const context = { window };
vm.runInNewContext(source, context, { filename: "gd-course-package-boundary-gate-v1.js" });

assert.ok(window.GDCoursePackageBoundaryGate, "the gate is exposed on window and needs nothing else to load");
assert.strictEqual(typeof window.GDCoursePackageBoundaryGate.shouldActivateNow, "function");
assert.strictEqual(typeof window.GDCoursePackageBoundaryGate.createWatch, "function");

const gate = window.GDCoursePackageBoundaryGate;

assert.strictEqual(gate.shouldActivateNow({ armedAtHole: 5, currentHole: 5 }), false, "still on the armed hole - hold the swap");
assert.strictEqual(gate.shouldActivateNow({ armedAtHole: 5, currentHole: 6 }), true, "hole advanced since arming - safe to swap");
assert.strictEqual(gate.shouldActivateNow({ armedAtHole: 5, currentHole: 4 }), true, "hole number went backward (replayed hole) - still a change, safe to swap");
assert.strictEqual(gate.shouldActivateNow({ armedAtHole: null, currentHole: 5 }), true, "nothing armed - default open, nothing to protect against");
assert.strictEqual(gate.shouldActivateNow({ armedAtHole: 5, currentHole: null }), true, "current hole unknown - fail open rather than holding a package forever");
assert.strictEqual(gate.shouldActivateNow({}), true, "no context at all - fail open");
assert.strictEqual(gate.shouldActivateNow({ armedAtHole: 0, currentHole: 0 }), true, "hole 0 is not a valid hole number on either side - treated as unknown");

const watch = gate.createWatch(3);
assert.strictEqual(watch.armedAtHole, 3);
assert.strictEqual(watch.check(3), false, "watch remembers what it armed against");
assert.strictEqual(watch.check(4), true, "watch reports safe once the hole moves");

console.log("course-package-boundary-gate passed");
