const assert = require("assert");
const createMarshal = require("../app/js/marshal.js");
const createWatchBridge = require("../app/js/caddy-watch.js");

const TEE = { lat: -36.9174, lng: 174.74 };
const GREEN = { lat: -36.9201, lng: 174.74 };
const PKG = { holes: [{ holeNumber: 1, par: 4, tee: TEE, green: GREEN, greenShape: [
  { lat: -36.9200, lng: 174.7399 }, { lat: -36.9202, lng: 174.7398 }, { lat: -36.9202, lng: 174.7402 }
] }] };
let passed = 0;
function check(name, fn) { try { fn(); console.log("  PASS  " + name); passed++; } catch (e) { console.log("  FAIL  " + name + "\n        " + e.message); process.exitCode = 1; } }
function ready() {
  const m = createMarshal({ now: () => 1000 });
  m.signal("ROUND_OPENED", { courseKey: "watch-test", roundId: "round-1", pkg: PKG, hole: 1 });
  m.signal("FIX_RECEIVED", { point: TEE });
  m.signal("PLAY_PRESSED");
  return { m, w: createWatchBridge({ marshal: m, now: () => 1000, bubbleModel: () => ({ payload: { club: "8i", baseCarry: 135, totalM: 146, clusterWidthM: 18, clusterDepthM: 24, clusterTiltDeg: 4 } }) }) };
}
console.log("\n— Caddy Watch compatibility —");
check("projects Marshal state into a platform-neutral Standard scene", () => {
  const { w } = ready(), s = w.scene();
  assert.equal(s.schemaVersion, 1); assert.equal(s.roundId, "round-1"); assert.equal(s.mode, "standard"); assert.equal(s.hole.par, 4);
  assert.equal(s.controls.canLock, true); assert.ok(Array.isArray(s.geometry.greenPolygon));
});
check("Lock maps to Marshal and projects Bubble geometry without a second engine", () => {
  const { m, w } = ready();
  const result = w.receiveCommand({ commandId: "lock-1", roundId: "round-1", baseRevision: w.scene().revision, type: "LOCK", payload: {} });
  assert.equal(result.accepted, true); assert.equal(m.scene().mode, "aim"); assert.equal(w.scene().mode, "bubble"); assert.equal(w.scene().bubble.club, "8i");
  /* Which engine drew this Bubble travels with it, so the wrist can decide
     whether it may compute one of its own. It is the module's own constant -
     the same one the bag snapshot carries - not a second literal. */
  assert.equal(w.scene().bubble.engineVersion, createWatchBridge.BUBBLE_ENGINE_VERSION,
    "the Scene's Bubble must declare the engine that produced it");
  assert.ok(createWatchBridge.BUBBLE_ENGINE_VERSION, "the contract module owns the engine version");
});
check("duplicate command IDs apply only once", () => {
  const { m, w } = ready();
  const c = { commandId: "lock-1", roundId: "round-1", baseRevision: w.scene().revision, type: "LOCK", payload: {} };
  assert.equal(w.receiveCommand(c).accepted, true); assert.equal(w.receiveCommand(c).duplicate, true); assert.equal(m.shots(1).length, 1);
});
check("a rejected command ID stays retryable until Marshal accepts it", () => {
  const { m, w } = ready();
  const unlock = { commandId: "retry-unlock", roundId: "round-1", type: "UNLOCK", payload: {} };
  assert.equal(w.receiveCommand(unlock).accepted, false, "Unlock is rejected before a shot is locked");
  w.receiveCommand({ commandId: "lock-before-retry", roundId: "round-1", type: "LOCK", payload: {} });
  assert.equal(w.receiveCommand(unlock).accepted, true, "the same ID can perform the later accepted Unlock");
});
check("unknown and invalid-location commands are not marked processed", () => {
  const { w } = ready();
  const unknown = { commandId: "unknown", roundId: "round-1", type: "NOPE", payload: {} };
  assert.equal(w.receiveCommand(unknown).accepted, false); assert.equal(w.receiveCommand(unknown).duplicate, undefined);
  const invalid = { commandId: "bad-location", roundId: "round-1", type: "LOCK_AT", payload: { location: {} } };
  assert.equal(w.receiveCommand(invalid).accepted, false); assert.equal(w.receiveCommand(invalid).duplicate, undefined);
});
check("tap-to-aim maps a Watch command to the authoritative target", () => {
  const { m, w } = ready(); w.receiveCommand({ commandId: "lock-1", roundId: "round-1", type: "LOCK", payload: {} });
  const target = { lat: -36.9200, lng: 174.7401 };
  assert.equal(w.receiveCommand({ commandId: "aim-1", roundId: "round-1", type: "AIM_AT", payload: { point: target } }).accepted, true);
  assert.deepEqual(m.scene().bubble.target, target);
});
check("malformed or stale Watch location cannot mutate the round", () => {
  const { m, w } = ready();
  const r = w.receiveCommand({ commandId: "watch-lock", roundId: "round-1", type: "LOCK_AT", payload: { location: { coordinate: TEE, source: "apple-watch", horizontalAccuracy: 5, timestamp: -999999 } } });
  assert.equal(r.accepted, false); assert.equal(m.shots(1).length, 0);
});
check("a fresh Apple Watch observation keeps its provenance without replacing phone GPS", () => {
  const { m, w } = ready();
  const r = w.receiveCommand({ commandId: "watch-lock", roundId: "round-1", type: "LOCK_AT", payload: { location: { coordinate: GREEN, source: "apple-watch", horizontalAccuracy: 5, timestamp: 1000 } } });
  assert.equal(r.accepted, true); assert.deepEqual(m.lastFix(), TEE);
  assert.equal(m.shots(1)[0].location.source, "apple-watch");
});
check("browsing a hole stays a view-only action", () => {
  const { m, w } = ready();
  assert.equal(w.receiveCommand({ commandId: "next", roundId: "round-1", type: "VIEW_NEXT_HOLE", payload: {} }).accepted, false, "one-hole package cannot advance");
  assert.equal(m.round().liveHole, 1);
});
console.log("\n— Phone <-> Watch handover —");
check("the phone drives by default and the Watch's presence rides the scene", () => {
  const { w } = ready(), s = w.scene();
  assert.equal(s.surface.active, "phone"); assert.equal(s.surface.handover, null);
  assert.deepEqual(s.surface.watch, { paired: false, appInstalled: false, reachable: false, maps: { total: 0, have: 0 } });
  assert.equal(w.setWatchState({ paired: true, appInstalled: true, reachable: true }), true);
  assert.deepEqual(w.scene().surface.watch, { paired: true, appInstalled: true, reachable: true, maps: { total: 0, have: 0 } });
  assert.equal(w.setWatchState({ paired: true, appInstalled: true, reachable: true }), false, "an unchanged report does not republish");
});
check("a phone-initiated handover is only OFFERED until the wrist answers TAKE_OVER", () => {
  const { w } = ready();
  const before = w.scene().revision;
  assert.equal(w.handToWatch(), true);
  let s = w.scene();
  assert.equal(s.surface.active, "watch"); assert.equal(s.surface.handover.state, "offered"); assert.equal(s.surface.handover.from, "phone");
  assert.ok(s.revision > before, "the offer is a new scene revision so the Watch receives it");
  const id = s.surface.handover.id;
  assert.equal(w.handToWatch(), true); assert.equal(w.scene().surface.handover.id, id, "re-tapping does not re-offer");
  const r = w.receiveCommand({ commandId: "take-1", roundId: "round-1", baseRevision: s.revision, type: "TAKE_OVER", payload: {} });
  assert.equal(r.accepted, true);
  s = w.scene();
  assert.equal(s.surface.handover.state, "confirmed"); assert.equal(s.surface.handover.id, id, "confirmation answers the same offer");
  assert.equal(s.surface.handover.from, "phone");
});
check("the wrist can take over on its own and hand back; the phone can take back", () => {
  const { m, w } = ready();
  assert.equal(w.receiveCommand({ commandId: "take-2", roundId: "round-1", type: "TAKE_OVER", payload: {} }).accepted, true);
  assert.equal(w.scene().surface.active, "watch"); assert.equal(w.scene().surface.handover.state, "confirmed"); assert.equal(w.scene().surface.handover.from, "watch");
  assert.equal(w.receiveCommand({ commandId: "back-1", roundId: "round-1", type: "HAND_BACK", payload: {} }).accepted, true);
  assert.equal(w.scene().surface.active, "phone"); assert.equal(w.scene().surface.handover, null);
  assert.equal(w.handToWatch(), true);
  assert.equal(w.takeBack(), true); assert.equal(w.scene().surface.active, "phone");
  assert.equal(m.shots(1).length, 0, "surface commands never touch the round");
});
check("surface commands still need the right round and are idempotent by ID", () => {
  const { w } = ready();
  assert.equal(w.receiveCommand({ commandId: "wrong", roundId: "someone-else", type: "TAKE_OVER", payload: {} }).accepted, false);
  assert.equal(w.scene().surface.active, "phone");
  const take = { commandId: "take-3", roundId: "round-1", type: "TAKE_OVER", payload: {} };
  assert.equal(w.receiveCommand(take).accepted, true);
  assert.equal(w.receiveCommand(take).duplicate, true);
});
check("a handover belongs to one live round and lapses with it", () => {
  const { m, w } = ready();
  assert.equal(w.handToWatch(), true);
  m.signal("END_ROUND");
  assert.equal(w.scene().flow, "preview");
  assert.equal(w.scene().surface.active, "phone", "live play over, nothing left on the Watch");
  assert.equal(w.handToWatch(), false, "nothing to hand over without a live hole");
  m.signal("ROUND_OPENED", { courseKey: "watch-test", roundId: "round-2", pkg: PKG, hole: 1 });
  assert.equal(w.scene().surface.active, "phone");
  assert.equal(w.handToWatch(), false, "preview at a new course still has no live hole to drive");
  const early = w.receiveCommand({ commandId: "early", roundId: "round-2", type: "TAKE_OVER", payload: {} });
  assert.equal(early.accepted, false); assert.equal(early.reason, "no-live-round", "Play here before Play on the phone is told why");
  assert.equal(w.scene().surface.active, "phone");
});
check("the scene carries what the Ready faces need: course name, hole length, map count", () => {
  const { w } = ready(), s = w.scene();
  assert.equal(s.course.key, "watch-test");
  assert.ok(s.hole.teeToGreenM > 290 && s.hole.teeToGreenM < 310, "tee to green is the hole's own length: " + s.hole.teeToGreenM);
  assert.deepEqual(s.surface.watch.maps, { total: 0, have: 0 });
  assert.equal(w.setWatchMaps({ total: 18, have: 7 }), true);
  assert.deepEqual(w.scene().surface.watch.maps, { total: 18, have: 7 });
  assert.equal(w.setWatchMaps({ total: 18, have: 7 }), false, "unchanged count does not republish");
  assert.equal(w.setWatchMaps({ total: 18, have: 40 }), true);
  assert.equal(w.scene().surface.watch.maps.have, 18, "cannot hold more than the package has");
  assert.equal(w.setWatchMaps({ known: false }), true);
  assert.deepEqual(w.scene().surface.watch.maps, { total: 0, have: 0 });
});
check("Lock still works from the wrist whichever surface is driving", () => {
  const { m, w } = ready();
  w.receiveCommand({ commandId: "take-4", roundId: "round-1", type: "TAKE_OVER", payload: {} });
  assert.equal(w.receiveCommand({ commandId: "lock-driving", roundId: "round-1", type: "LOCK", payload: {} }).accepted, true);
  assert.equal(m.scene().mode, "aim"); assert.equal(w.scene().surface.active, "watch", "a round transition does not reset the driver");
});
console.log("\n" + passed + " Caddy Watch compatibility checks passed.");
