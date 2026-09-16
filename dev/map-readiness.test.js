const assert = require("assert");
const readiness = require("../app/js/map-readiness.js");

const green = n => ({ holeNumber: n, green: { lat: -36.8 - n / 1000, lng: 174.7 } });
const partial = {
  status: "lite-geo-ready", readiness: "partial", mappedHoleCount: 2,
  expectedHoleCount: 3, missingHoles: [2], holes: [green(1), green(3)]
};

assert.strictEqual(readiness.classify(partial, 1).state, "PARTIAL_READY", "a mapped hole in a partial package plays normally");
assert.strictEqual(readiness.classify(partial, 2).state, "CURRENT_HOLE_MISSING", "only the absent hole falls back");
assert.strictEqual(readiness.classify(partial, 3).state, "PARTIAL_READY", "mapped play resumes after the absent hole");
assert.strictEqual(readiness.classify({ status: "processing" }, 1).state, "PROCESSING");
assert.strictEqual(readiness.classify({ status: "manual-required" }, 1).state, "MANUAL_ACTION_REQUIRED");
assert.strictEqual(readiness.classify({ status: "failed" }, 1).state, "FAILED");
assert.strictEqual(readiness.classify({ status: "full-map-ready", holes: [] }, 1).state, "FAILED", "an unreadable ready package is a runtime failure");

const controller = readiness.createMapReadiness();
controller.observePackage(partial);
controller.enterHole(2);
assert.strictEqual(controller.current().state, "CURRENT_HOLE_MISSING");
controller.setManualHole(2);
assert.deepStrictEqual({ state: controller.current().state, manual: controller.current().manual }, { state: "READY", manual: true });
controller.enterHole(3);
assert.strictEqual(controller.current().state, "PARTIAL_READY", "manual fallback does not convert the next mapped hole");
controller.observePackage({ status: "full-map-ready", readiness: "complete", mappedHoleCount: 3, expectedHoleCount: 3, missingHoles: [], holes: [green(1), green(2), green(3)] });
assert.strictEqual(controller.current().state, "READY", "a repaired package recovers without recreating the controller");

console.log("map-readiness passed: 10 checks");
