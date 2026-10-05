/* Demo approach: a hole played from the couch, handed to a Watch.

   Pins the contract both wrists build on: the Scene says `demo` with the
   planted position, the wrist's DEMO_APPROACH starts the hole AND hands it
   over in one command, a wrist's GPS-stamped LOCK is played from the demo
   point, and DEMO_END puts everything back to Preview. */
const assert = require("assert");
const distance = require("../app/js/distance.js");
const createMarshal = require("../app/js/marshal.js");
const createWatchBridge = require("../app/js/caddy-watch.js");

global.window = { ClarityApp: { distance: distance, createMarshal: createMarshal } };
require("../app/js/demo-approach.js");
const app = global.window.ClarityApp;

/* A dog-leg: tee, one route point, green. ~520m of play line. */
const TEE = { lat: -36.9100, lng: 174.7400 };
const BEND = { lat: -36.9130, lng: 174.7420 };
const GREEN = { lat: -36.9140, lng: 174.7460 };
const SHORT_TEE = { lat: -36.9150, lng: 174.7470 };
const SHORT_GREEN = { lat: -36.9157, lng: 174.7470 }; // ~78m par 3
const PKG = { holes: [
  { holeNumber: 1, par: 5, tee: TEE, route: [BEND], green: GREEN },
  { holeNumber: 2, par: 3, tee: SHORT_TEE, green: SHORT_GREEN }
] };
const HOME = { lat: -41.29, lng: 174.78 }; // a couch 500km away

let passed = 0;
function check(name, fn) { try { fn(); console.log("  PASS  " + name); passed++; } catch (e) { console.log("  FAIL  " + name + "\n        " + e.message); process.exitCode = 1; } }

function setup() {
  app.demoApproach.reset();
  const m = createMarshal({ now: () => Date.now() });
  app.marshal = m;
  m.signal("ROUND_OPENED", { courseKey: "demo-test", roundId: "round-d", pkg: PKG, hole: 1 });
  m.signal("FIX_RECEIVED", { point: HOME }); // refused: not at the course
  const w = createWatchBridge({ marshal: m, demo: app.demoApproach });
  w.setWatchState({ paired: true, appInstalled: true, reachable: true, vendor: "apple" });
  app.caddyWatch = w;
  return { m, w };
}
function cmd(w, type, payload, id) {
  return w.receiveCommand({ commandId: id || type + "-" + Math.random(), roundId: w.scene().roundId, baseRevision: w.scene().revision, type: type, payload: payload || {} });
}

console.log("\n— Demo approach —");

check("off the course the Scene offers the demo, not Play", () => {
  const { w } = setup();
  const s = w.scene();
  assert.equal(s.controls.canPlay, false);
  assert.equal(s.controls.canDemo, true);
  assert.equal(s.demo, null);
  assert.equal(w.handToWatch(), false, "a real handover still cannot start from the couch");
});

check("the planted point sits 100-130m short of the green, on the play line", () => {
  for (let i = 0; i < 25; i++) {
    const { m } = setup();
    assert.ok(app.demoApproach.start(1));
    const at = m.lastFix();
    const toGreen = distance.haversineMeters(at, GREEN);
    assert.ok(toGreen >= 99.5 && toGreen <= 130.5, "got " + toGreen.toFixed(1) + "m");
    /* On the bend->green leg: the two legs to it add up to the leg itself. */
    const leg = distance.haversineMeters(BEND, GREEN);
    const via = distance.haversineMeters(BEND, at) + toGreen;
    assert.ok(Math.abs(via - leg) < 0.5, "off the line by " + (via - leg).toFixed(2) + "m");
  }
});

check("a hole shorter than the walk starts at its tee", () => {
  const { m } = setup();
  assert.ok(app.demoApproach.start(2));
  assert.ok(distance.haversineMeters(m.lastFix(), SHORT_TEE) < 0.5);
});

check("wrist DEMO_APPROACH makes the hole live, in Track, and hands it to the wrist", () => {
  const { m, w } = setup();
  const r = cmd(w, "DEMO_APPROACH", { hole: 1 });
  assert.equal(r.accepted, true, JSON.stringify(r));
  assert.equal(m.round().liveHole, 1);
  const s = w.scene();
  assert.equal(s.flow, "live");
  assert.equal(s.mode, "standard");
  assert.equal(s.surface.active, "watch");
  assert.equal(s.surface.handover.state, "confirmed");
  assert.equal(s.demo.active, true);
  assert.equal(s.demo.hole, 1);
  assert.ok(s.demo.position && Number.isFinite(s.demo.position.lat));
  assert.ok(s.distance.centre >= 99 && s.distance.centre <= 131, "distances measure from the demo point, got " + s.distance.centre);
  assert.equal(s.controls.canLock, true);
});

check("a GPS-stamped LOCK from the wrist is played from the demo point", () => {
  const { m, w } = setup();
  cmd(w, "DEMO_APPROACH", { hole: 1 });
  const planted = m.lastFix();
  const r = cmd(w, "LOCK_AT", { location: { coordinate: HOME, source: "apple-watch", horizontalAccuracy: 5, timestamp: Date.now() } });
  assert.equal(r.accepted, true, JSON.stringify(r));
  const shot = m.openShot(1);
  assert.ok(shot, "a shot is open");
  assert.ok(distance.haversineMeters(shot.start, planted) < 0.5, "the shot starts at the demo point, not the couch");
  assert.equal(w.scene().mode, "bubble");
});

check("real GPS cannot move a demo player (boot.js gate) and the refresh re-plants it", () => {
  const { m } = setup();
  app.demoApproach.start(1);
  const planted = m.lastFix();
  assert.equal(app.demoApproach.active(), true, "boot.js drops real fixes while this is true");
  m.signal("FIX_RECEIVED", { point: { lat: planted.lat + 0.0003, lng: planted.lng } });
  m.signal("FIX_RECEIVED", { point: app.demoApproach.point(), speed: 0 });
  assert.ok(distance.haversineMeters(m.lastFix(), planted) < 0.5);
});

check("another hole's demo moves the live demo without losing the wrist", () => {
  const { m, w } = setup();
  cmd(w, "DEMO_APPROACH", { hole: 1 });
  assert.equal(w.scene().controls.canDemo, true, "a demo is still offered while one runs");
  const r = cmd(w, "DEMO_APPROACH", { hole: 2 });
  assert.equal(r.accepted, true);
  assert.equal(m.round().liveHole, 2);
  assert.equal(w.scene().surface.active, "watch");
  assert.equal(w.scene().demo.hole, 2);
});

check("DEMO_END returns to Preview, phone driving, nothing kept", () => {
  const { m, w } = setup();
  cmd(w, "DEMO_APPROACH", { hole: 1 });
  cmd(w, "LOCK");
  const r = cmd(w, "DEMO_END");
  assert.equal(r.accepted, true);
  assert.equal(app.demoApproach.active(), false);
  assert.equal(m.round().liveHole, null);
  assert.equal(m.lastFix(), null);
  assert.equal(m.shots(1).length, 0);
  const s = w.scene();
  assert.equal(s.flow, "preview");
  assert.equal(s.demo, null);
  assert.equal(s.surface.active, "phone");
  assert.equal(s.controls.canDemo, true);
});

check("the phone card's demo offers the handover like Play on Watch", () => {
  const { w } = setup();
  assert.equal(w.demoOnWatch(1), true);
  assert.equal(w.scene().surface.handover.state, "offered");
  assert.equal(w.scene().surface.handover.from, "phone");
  assert.equal(cmd(w, "TAKE_OVER").accepted, true);
  assert.equal(w.scene().surface.handover.state, "confirmed");
});

check("no demo while a real hole is live", () => {
  app.demoApproach.reset();
  const m = createMarshal({ now: () => Date.now() });
  app.marshal = m;
  m.signal("ROUND_OPENED", { courseKey: "demo-test", roundId: "round-r", pkg: PKG, hole: 1 });
  m.signal("FIX_RECEIVED", { point: TEE });
  m.signal("PLAY_PRESSED");
  const w = createWatchBridge({ marshal: m, demo: app.demoApproach });
  assert.equal(m.round().liveHole, 1);
  assert.equal(w.scene().controls.canDemo, false);
  assert.equal(cmd(w, "DEMO_APPROACH", { hole: 2 }).accepted, false);
  assert.equal(m.round().liveHole, 1);
});

check("a real fix at the course ends the demo; one from the couch does not", () => {
  const { m, w } = setup();
  cmd(w, "DEMO_APPROACH", { hole: 1 });
  assert.equal(app.demoApproach.endIfAtCourse(HOME), false, "500km away is still the couch");
  assert.equal(app.demoApproach.active(), true);
  assert.equal(app.demoApproach.endIfAtCourse(TEE), true, "standing on the course meets the real criteria");
  assert.equal(app.demoApproach.active(), false);
  assert.equal(m.round().liveHole, null, "back to Preview, ready for a real Play");
  assert.equal(w.scene().surface.active, "phone", "a driving wrist is handed back");
  m.signal("FIX_RECEIVED", { point: TEE });
  assert.equal(w.scene().controls.canPlay, true, "the real path: Play is offered");
  assert.equal(w.scene().controls.canDemo, false);
});

app.demoApproach.reset();
console.log("\n" + passed + " passed" + (process.exitCode ? ", with failures" : ""));
