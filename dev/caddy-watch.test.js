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
console.log("\n" + passed + " Caddy Watch compatibility checks passed.");
