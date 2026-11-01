/* app/js/round-usage.js: one anonymous outcome per opened round, worked out from the holes
 * the phone moved through and whether GPS ever put the player on the course. The cases are
 * the two real rounds read out of the course-package request logs on 2 Nov 2026 - Penrith
 * (set up near the first tee, a few holes, quiet after 14 minutes) and Royal County Down
 * (about an hour on the course, five or six holes) - plus a full round, a look from home,
 * a watch-driven round and a round left behind by a killed app. */

const assert = require("assert");
const path = require("path");

const createRoundUsage = require(path.join(__dirname, "..", "app", "js", "round-usage.js"));
const distance = require(path.join(__dirname, "..", "app", "js", "distance.js"));

const MIN = 60 * 1000;
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error }); }
}

/* A hole whose tee is at the origin and green 400 m north. */
function holeAt(lat, lng) {
  return { tee: { lat, lng }, green: { green: { lat: lat + 0.0036, lng }, greenShape: [] } };
}
const TEE = { lat: -33.7911, lng: 150.6982 };
const ON = { lat: TEE.lat + 0.001, lng: TEE.lng, accuracy: 8 };         // ~110 m up the hole
const HOME = { lat: TEE.lat + 0.2, lng: TEE.lng, accuracy: 8 };         // ~22 km away
const VAGUE = { lat: TEE.lat, lng: TEE.lng, accuracy: 900 };            // on top of the tee, but unusable

function memoryStorage() {
  const data = {};
  return {
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
    data
  };
}

function setup(start) {
  const clock = { t: start || Date.parse("2026-11-01T21:30:00Z") };
  const reported = [];
  const storage = memoryStorage();
  const make = () => createRoundUsage({ storage, now: () => clock.t, report: e => reported.push(e), distance });
  return { clock, reported, storage, make, usage: make() };
}

const COURSE = { courseId: "penrith", courseName: "Penrith Golf Club", mapType: "object", version: "v0.1" };

/* Penrith: on the course from 21:31, holes 1-3, last sign of life at 21:44. */
(() => {
  const { clock, reported, usage } = setup();
  usage.start(COURSE);
  usage.hole(1, holeAt(TEE.lat, TEE.lng));
  clock.t += MIN; usage.fix(ON);
  clock.t += 5 * MIN; usage.hole(2, holeAt(TEE.lat, TEE.lng));
  clock.t += 7 * MIN; usage.hole(3, holeAt(TEE.lat, TEE.lng)); usage.fix(ON);
  usage.end();
  check("on the course, three holes, quiet inside the hour: stopped early", () => {
    assert.strictEqual(reported.length, 1);
    assert.deepStrictEqual(reported[0], { courseId: "penrith", courseName: "Penrith Golf Club", event: "round", outcome: "stopped-early", mapType: "object", version: "v0.1" });
  });
})();

/* Royal County Down: on the course at 09:13, six holes, last at 10:20. */
(() => {
  const { clock, reported, usage } = setup(Date.parse("2026-10-28T09:12:00Z"));
  usage.start(COURSE);
  usage.hole(1, holeAt(TEE.lat, TEE.lng));
  clock.t += MIN; usage.fix(ON);
  for (let h = 2; h <= 6; h += 1) { clock.t += 13 * MIN; usage.hole(h, holeAt(TEE.lat, TEE.lng)); usage.fix(ON); }
  usage.end();
  check("an hour on the course over six holes: a part round", () => {
    assert.strictEqual(reported[0].outcome, "part-round");
  });
})();

(() => {
  const { clock, reported, usage } = setup();
  usage.start(COURSE);
  for (let h = 1; h <= 9; h += 1) { usage.hole(h, holeAt(TEE.lat, TEE.lng)); usage.fix(ON); clock.t += 12 * MIN; }
  usage.end();
  check("nine holes on the course: played", () => assert.strictEqual(reported[0].outcome, "played"));
})();

(() => {
  const { clock, reported, usage } = setup();
  usage.start(COURSE);
  for (let h = 1; h <= 18; h += 1) { usage.hole(h, holeAt(TEE.lat, TEE.lng)); usage.fix(HOME); usage.fix(VAGUE); clock.t += MIN; }
  usage.end();
  check("all eighteen holes looked at from home, or with a useless fix: off the course", () => {
    assert.strictEqual(reported[0].outcome, "off-course");
  });
})();

(() => {
  const { clock, reported, usage } = setup();
  usage.start(COURSE);
  usage.hole(1, holeAt(TEE.lat, TEE.lng)); usage.fix(ON);
  usage.watchDriving();
  clock.t += 10 * MIN;
  usage.end();
  check("a round a watch took over is not called stopped early", () => assert.strictEqual(reported[0].outcome, "on-watch"));
})();

(() => {
  const { clock, reported, usage, make } = setup();
  usage.start(COURSE);
  usage.hole(1, holeAt(TEE.lat, TEE.lng)); usage.fix(ON);
  clock.t += 20 * MIN; usage.hole(2, holeAt(TEE.lat, TEE.lng));
  /* The app is killed. Two hours later it is opened again: still too soon to call it. */
  clock.t += 2 * 60 * MIN;
  const early = make().flushStale();
  /* An hour after that, it is. */
  clock.t += 60 * MIN;
  const later = make().flushStale();
  check("a round left behind by a killed app is counted once it has been quiet for three hours", () => {
    assert.strictEqual(early, null);
    assert.strictEqual(later, "stopped-early");
    assert.strictEqual(reported.length, 1);
  });
})();

(() => {
  const { clock, reported, usage } = setup();
  usage.start(COURSE);
  usage.hole(1, holeAt(TEE.lat, TEE.lng)); usage.fix(ON);
  clock.t += 30 * MIN;
  usage.start(COURSE);                     // reopened mid-round
  for (let h = 2; h <= 9; h += 1) { usage.hole(h, holeAt(TEE.lat, TEE.lng)); clock.t += 10 * MIN; }
  usage.start({ courseId: "other", courseName: "Other" });
  check("reopening the same course carries on the round; a different course finishes it", () => {
    assert.strictEqual(reported.length, 1);
    assert.strictEqual(reported[0].outcome, "played");
    assert.strictEqual(reported[0].courseId, "penrith");
  });
})();

console.log("— Round usage —");
let failed = 0;
results.forEach(r => {
  if (r.ok) console.log("  PASS  " + r.name);
  else { failed += 1; console.log("  FAIL  " + r.name + "\n        " + (r.error && r.error.message)); }
});
if (failed) { console.log(failed + " check(s) failed."); process.exit(1); }
console.log(results.length + " round usage checks passed.");
