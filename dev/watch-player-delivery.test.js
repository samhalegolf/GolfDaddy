#!/usr/bin/env node
"use strict";

/* The phone half of the bag/profile transport: what gets built into a
   snapshot, when it is sent, and when it deliberately is not.

   The fingerprint cases come from dev/fixtures/bubble-engine-parity.json — the
   same file ios/WatchBubbleEngine's tests read — because the wrist RECOMPUTES
   the fingerprint from the contents it receives and refuses a snapshot whose
   own fingerprint does not match. A quiet disagreement between the two
   implementations would not be cosmetic: it would make the wrist reject every
   bag the phone ever sends. */

const assert = require("assert");
const path = require("path");
const fs = require("fs");

const delivery = require(path.join(__dirname, "..", "app", "js", "watch-player-delivery.js"));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "bubble-engine-parity.json"), "utf8"));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error }); }
}

const ACCOUNT_BAG = [
  { club: "Driver", baseCarry: 205, totalM: 228 },
  { club: "5i", baseCarry: 155, totalM: 167 },
  { club: "PW", baseCarry: 103, totalM: 108 }
];

function environment(options) {
  options = options || {};
  const calls = [];
  const plugin = {
    publishWatchPlayer: snapshot => {
      if (options.publishThrows) throw new Error("no session");
      calls.push(snapshot.player);
    }
  };
  const state = {
    bag: options.bag === undefined ? ACCOUNT_BAG : options.bag,
    saved: options.saved === undefined ? { offsetDeg: 3.2 } : options.saved,
    handedness: options.handedness || "right"
  };
  const instance = delivery.createDelivery({
    plugin: () => (options.noPlugin ? null : plugin),
    bag: () => state.bag,
    bubble: () => ({ saved: state.saved, handedness: state.handedness })
  });
  return { instance, calls, state };
}

// --- the fingerprint, against the shared fixture ---------------------------------------------

fixture.playerFingerprints.cases.forEach(entry => {
  check("fingerprint · " + entry.name, () => {
    const snapshot = delivery.__test.snapshotFrom(entry.input.bag, entry.input.bubble, entry.input.handedness);
    assert.ok(snapshot, "the case must produce a snapshot");
    assert.strictEqual(snapshot.fingerprint, entry.expect.fingerprint, entry.why);
    assert.deepStrictEqual(snapshot.bag.clubs, entry.expect.clubs);
    assert.strictEqual(snapshot.bag.isGhost, entry.expect.isGhost);
    assert.deepStrictEqual(snapshot.bubble, entry.expect.bubble);
  });
});

check("an absent aim and a saved zero are different snapshots", () => {
  /* The single most important distinction in this payload. Number(null) is 0
     and passes a bare finite check, which is exactly how a fabricated 0.0 deg
     aim got applied to everyone once before. */
  const absent = delivery.__test.snapshotFrom([{ club: "Driver", baseCarry: 205 }], null, "right");
  const zero = delivery.__test.snapshotFrom([{ club: "Driver", baseCarry: 205 }], { offsetDeg: 0 }, "right");
  assert.notStrictEqual(absent.fingerprint, zero.fingerprint);
  assert.ok(!("offsetDeg" in absent.bubble), "no My Bubble must OMIT the offset, never send zero");
  assert.strictEqual(zero.bubble.offsetDeg, 0, "a saved zero-degree aim is a real value and must survive");
});

check("an empty-string or null offset is an absent aim, not a zero", () => {
  ["", null, undefined, NaN].forEach(value => {
    const snapshot = delivery.__test.snapshotFrom([{ club: "Driver", baseCarry: 205 }], { offsetDeg: value }, "right");
    assert.ok(!("offsetDeg" in snapshot.bubble), "offsetDeg " + JSON.stringify(value) + " must be treated as absent");
  });
});

// --- building a snapshot ----------------------------------------------------------------------

check("clubs are emitted longest-total-first whatever order they arrive in", () => {
  const forwards = delivery.__test.snapshotFrom(ACCOUNT_BAG, { offsetDeg: 3.2 }, "right");
  const shuffled = delivery.__test.snapshotFrom(ACCOUNT_BAG.slice().reverse(), { offsetDeg: 3.2 }, "right");
  assert.deepStrictEqual(forwards.bag.clubs.map(c => c.club), ["Driver", "5i", "PW"]);
  assert.strictEqual(forwards.fingerprint, shuffled.fingerprint,
    "a shuffled bag is the same bag - otherwise a re-render re-sends it");
});

check("an unnamed or zero-carry row is dropped, not sent as a club", () => {
  const snapshot = delivery.__test.snapshotFrom(
    [{ club: "Driver", baseCarry: 205 }, { club: "", baseCarry: 150 }, { club: "Ghost", baseCarry: 0 }],
    { offsetDeg: 1 }, "right");
  assert.deepStrictEqual(snapshot.bag.clubs.map(c => c.club), ["Driver"]);
});

check("a bag with nothing playable produces no snapshot at all", () => {
  assert.strictEqual(delivery.__test.snapshotFrom([], { offsetDeg: 1 }, "right"), null);
  assert.strictEqual(delivery.__test.snapshotFrom(null, null, "right"), null);
});

check("the engine version travels with the bag", () => {
  const snapshot = delivery.__test.snapshotFrom(ACCOUNT_BAG, { offsetDeg: 3.2 }, "right");
  assert.strictEqual(snapshot.engineVersion, delivery.ENGINE_VERSION);
  assert.strictEqual(snapshot.version, delivery.SCHEMA_VERSION);
  assert.ok(snapshot.fingerprint.endsWith("|e:" + delivery.ENGINE_VERSION),
    "the engine version is IN the fingerprint, so upgrading the engine re-sends the bag");
});

// --- when it sends ------------------------------------------------------------------------------

check("a fresh wrist gets the snapshot once, not on every Scene", () => {
  const { instance, calls } = environment();
  const first = instance.deliver();
  assert.strictEqual(first.delivered, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].bag.clubs.length, 3);
  const second = instance.deliver();
  assert.strictEqual(second.delivered, false);
  assert.strictEqual(second.reason, "already-sent");
  assert.strictEqual(calls.length, 1, "an unchanged bag must not be re-sent on the next Scene");
});

check("a bag the wrist already reports holding is never sent", () => {
  const { instance, calls } = environment();
  const snapshot = delivery.__test.snapshotFrom(ACCOUNT_BAG, { offsetDeg: 3.2 }, "right");
  instance.noteInventory({ fingerprint: snapshot.fingerprint });
  const result = instance.deliver();
  assert.strictEqual(result.delivered, false);
  assert.strictEqual(result.reason, "wrist-has-it");
  assert.strictEqual(calls.length, 0, "a wrist that already has this bag costs nothing");
});

check("a wrist reporting a different bag is sent the current one", () => {
  const { instance, calls } = environment();
  instance.noteInventory({ fingerprint: "v1|g0|Something:1:1|b:-:right|e:bubble-engine-v1" });
  assert.strictEqual(instance.deliver().delivered, true);
  assert.strictEqual(calls.length, 1);
});

check("a wrist reporting nothing is sent the bag", () => {
  /* An empty fingerprint is a real answer - a fresh install, or a cleared
     cache - and it is exactly the case that must produce a send. */
  const { instance, calls } = environment();
  instance.deliver();
  instance.noteInventory({ fingerprint: "" });
  assert.strictEqual(instance.deliver().delivered, true);
  assert.strictEqual(calls.length, 2, "a wrist that has lost its bag must be given it again");
});

check("editing the bag mid-round re-sends it", () => {
  const { instance, calls, state } = environment();
  instance.deliver();
  state.bag = ACCOUNT_BAG.concat([{ club: "SW", baseCarry: 78, totalM: 82 }]);
  const result = instance.deliver();
  assert.strictEqual(result.delivered, true);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].bag.clubs.length, 4);
});

check("saving a My Bubble mid-round re-sends it", () => {
  const { instance, calls, state } = environment({ saved: null });
  instance.deliver();
  assert.ok(!("offsetDeg" in calls[0].bubble));
  state.saved = { offsetDeg: 2.4 };
  assert.strictEqual(instance.deliver().delivered, true);
  assert.strictEqual(calls[1].bubble.offsetDeg, 2.4);
});

check("adopting a real bag with identical numbers still re-sends", () => {
  /* The ghost flag is content: the wrist has to stop calling the numbers a
     stand-in even when they have not changed. */
  const ghost = ACCOUNT_BAG.map(row => Object.assign({}, row, { ghostBag: true }));
  const { instance, calls, state } = environment({ bag: ghost });
  instance.deliver();
  assert.strictEqual(calls[0].bag.isGhost, true);
  state.bag = ACCOUNT_BAG;
  assert.strictEqual(instance.deliver().delivered, true);
  assert.strictEqual(calls[1].bag.isGhost, false);
});

check("invalidate forces the next Scene to re-publish", () => {
  const { instance, calls } = environment();
  instance.deliver();
  assert.strictEqual(instance.deliver().delivered, false);
  instance.invalidate();
  assert.strictEqual(instance.deliver().delivered, true);
  assert.strictEqual(calls.length, 2);
});

check("without a native bridge nothing is built or sent", () => {
  const { instance, calls } = environment({ noPlugin: true });
  const result = instance.deliver();
  assert.strictEqual(result.delivered, false);
  assert.strictEqual(result.reason, "no-native-bridge");
  assert.strictEqual(calls.length, 0);
});

check("a player with no bag at all is not reported as an empty bag", () => {
  /* Sending an empty bag would let the wrist compute against nothing. The
     engine's ghost bag covers the phone; the wrist simply is not told. */
  const { instance, calls } = environment({ bag: [] });
  const result = instance.deliver();
  assert.strictEqual(result.delivered, false);
  assert.strictEqual(result.reason, "no-playable-bag");
  assert.strictEqual(calls.length, 0);
});

check("a publish that throws is retried on the next Scene", () => {
  const failing = delivery.createDelivery({
    plugin: () => ({ publishWatchPlayer: () => { throw new Error("no session"); } }),
    bag: () => ACCOUNT_BAG,
    bubble: () => ({ saved: { offsetDeg: 3.2 }, handedness: "right" })
  });
  const result = failing.deliver();
  assert.strictEqual(result.delivered, false);
  assert.strictEqual(result.reason, "publish-failed");
  assert.strictEqual(failing.state().sent, null, "a failed publish must not be remembered as sent");
});

check("a malformed inventory report clears the record rather than being trusted", () => {
  const { instance } = environment();
  instance.noteInventory({ fingerprint: "abc" });
  assert.strictEqual(instance.state().wristHas, "abc");
  instance.noteInventory(null);
  assert.strictEqual(instance.state().wristHas, null);
  instance.noteInventory({ fingerprint: 42 });
  assert.strictEqual(instance.state().wristHas, null, "a non-string fingerprint is not a fingerprint");
  /* An empty string is NOT cleared: it is the wrist saying it holds nothing,
     which is a real answer and a different one from having not answered. */
  instance.noteInventory({ fingerprint: "" });
  assert.strictEqual(instance.state().wristHas, "", "an empty fingerprint is an answer, not a missing report");
});

report();

function report() {
  console.log("— Watch player (bag + My Bubble) delivery —");
  let failed = 0;
  results.forEach(result => {
    if (result.ok) console.log("  PASS  " + result.name);
    else { failed += 1; console.log("  FAIL  " + result.name + "\n        " + (result.error && result.error.message)); }
  });
  console.log("");
  if (failed) { console.log(failed + " check(s) failed."); process.exit(1); }
  console.log(results.length + " Watch player delivery checks passed.");
}
