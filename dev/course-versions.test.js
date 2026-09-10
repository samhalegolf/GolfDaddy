/* app/js/course-versions.js - the one rule for "is the downloaded copy out of
   date", and since 2026-09-11 WHICH part moved. boot.js takes a geometry-only
   update without asking and prompts for a newer published frame, so the two
   answers must stay distinct.

   Run: npm run test:course-versions */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "app", "js", "course-versions.js"), "utf8"), { window });
const versions = window.ClarityApp.courseVersions;

const T1 = "2026-09-01T00:00:00.000+00:00";
const T2 = "2026-09-09T02:02:37.628+00:00";

function kind(local, remote) { return versions.updateKind(local, remote); }

/* Nothing to compare. */
assert.strictEqual(kind(null, { objectsVersion: T2, mapVersion: 1 }), "none");
assert.strictEqual(kind({ objectsVersion: T2, mapVersion: 1 }, null), "none");

/* Up to date. */
assert.strictEqual(kind({ objectsVersion: T2, mapVersion: 1 }, { objectsVersion: T2, mapVersion: 1 }), "none");
assert.strictEqual(kind({ objectsVersion: T2, mapVersion: 1 }, { objectsVersion: T1, mapVersion: 1 }), "none", "older server copy is not an update");

/* Objects moved, picture did not - the silent swap. */
assert.strictEqual(kind({ objectsVersion: T1, mapVersion: 1 }, { objectsVersion: T2, mapVersion: 1 }), "geometry");
assert.strictEqual(kind({ objectsVersion: T1, mapVersion: null }, { objectsVersion: T2, mapVersion: null }), "geometry", "object map with no frame at all");

/* Picture moved - the prompt. Wins even when the objects moved too. */
assert.strictEqual(kind({ objectsVersion: T2, mapVersion: 1 }, { objectsVersion: T2, mapVersion: 2 }), "frame");
assert.strictEqual(kind({ objectsVersion: T1, mapVersion: 1 }, { objectsVersion: T2, mapVersion: 2 }), "frame");
assert.strictEqual(kind({ objectsVersion: T2, mapVersion: null }, { objectsVersion: T2, mapVersion: 1 }), "frame", "first published frame over an object map");

/* Legacy records: objectsVersion held the mapper algorithm version, not a
   timestamp. savedAt decides, and a non-timestamp on the SERVER side decides
   nothing. */
const before = Date.parse(T2) - 60000, after = Date.parse(T2) + 60000;
assert.strictEqual(kind({ objectsVersion: "v1", mapVersion: 1, savedAt: before }, { objectsVersion: T2, mapVersion: 1 }), "geometry");
assert.strictEqual(kind({ objectsVersion: "v1", mapVersion: 1, savedAt: after }, { objectsVersion: T2, mapVersion: 1 }), "none");
assert.strictEqual(kind({ objectsVersion: null, mapVersion: 1 }, { objectsVersion: T2, mapVersion: 1 }), "none", "no version and no savedAt is not evidence");
assert.strictEqual(kind({ objectsVersion: T1, mapVersion: 1 }, { objectsVersion: "v1", mapVersion: 1 }), "none");

/* isStale is the same rule, collapsed. */
[[{ objectsVersion: T2, mapVersion: 1 }, { objectsVersion: T2, mapVersion: 1 }],
 [{ objectsVersion: T1, mapVersion: 1 }, { objectsVersion: T2, mapVersion: 1 }],
 [{ objectsVersion: T2, mapVersion: 1 }, { objectsVersion: T2, mapVersion: 2 }]].forEach(([local, remote]) => {
  assert.strictEqual(versions.isStale(local, remote), kind(local, remote) !== "none");
});

console.log("course-versions: ok");
