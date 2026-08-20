/* The Marshal's transition table, driven in node with no browser.

   This is the test that makes the design in PLAY_OWNER_CONCEPT.md an assertion
   rather than a paragraph. Every rule the concept states as load-bearing has a
   check here, named after the rule.

   Run: node dev/marshal.test.js */
const assert = require("assert");
const path = require("path");
const createMarshal = require(path.join(__dirname, "..", "app", "js", "marshal.js"));

/* Akarana-ish. Hole 1 runs 300m north→south; hole 2 sits beyond it. */
const TEE = { lat: -36.9174, lng: 174.7400 };
function offsetM(base, northM, eastM) {
  return {
    lat: base.lat + northM / 111320,
    lng: base.lng + eastM / (111320 * Math.cos(base.lat * Math.PI / 180))
  };
}
const GREEN = offsetM(TEE, -300, 0);
const H2_TEE = offsetM(TEE, -340, 60);
const H2_GREEN = offsetM(TEE, -640, 60);

const PKG = {
  status: "lite-geo-ready",
  holes: [
    { holeNumber: 1, tee: TEE, green: GREEN, greenShape: [], route: [] },
    { holeNumber: 2, tee: H2_TEE, green: H2_GREEN, greenShape: [], route: [] },
    { holeNumber: 3, tee: offsetM(TEE, -700, 0), green: offsetM(TEE, -900, 0), greenShape: [], route: [] }
  ]
};

let passed = 0;
function check(name, fn) {
  try { fn(); console.log("  PASS  " + name); passed += 1; }
  catch (e) { console.log("  FAIL  " + name + "\n        " + e.message); process.exitCode = 1; }
}

function newRound(opts = {}) {
  const effects = { completed: [], scores: [], shotChanges: [] };
  const m = createMarshal({
    effects: {
      shotCompleted: (shot, meta) => effects.completed.push({ shot, meta }),
      scoreSet: (hole, strokes) => effects.scores.push({ hole, strokes }),
      shotChanged: (start, target) => effects.shotChanges.push({ start, target })
    },
    now: () => 1000
  });
  m.signal("ROUND_OPENED", {
    courseKey: "verify", pkg: PKG,
    centre: opts.centre === undefined ? null : opts.centre,   // null = must derive
    hole: 1
  });
  return { m, effects };
}

/* Walk on to the course and press Play. Returns a marshal live on hole 1. */
function playing(opts = {}) {
  const r = newRound(opts);
  r.m.signal("FIX_RECEIVED", { point: offsetM(TEE, -5, 0) });
  r.m.signal("PLAY_PRESSED");
  return r;
}

/* The only way the round moves on now: physically arrive at the next tee and
   press Play. Every test that used to walk the round with NEXT_HOLE does this
   instead, which is the point of the change. */
const TEES = { 1: TEE, 2: H2_TEE, 3: offsetM(TEE, -700, 0) };
function walkTo(m, hole) {
  m.signal("FIX_RECEIVED", { point: offsetM(TEES[hole], -4, 0) });
  m.signal("VIEW_HOLE_CHANGED", { hole });
  assert.strictEqual(m.scene().playButton.show, true, `Play should be offered at hole ${hole}`);
  m.signal("PLAY_PRESSED");
  assert.strictEqual(m.scene().flow, "live");
  assert.strictEqual(m.scene().hole.number, hole);
}

console.log("\n— flow derivation —");

check("a round opens in Preview, because Play has not been pressed", () => {
  const { m } = newRound();
  assert.strictEqual(m.scene().flow, "preview");
  assert.strictEqual(m.scene().mode, "setup");
});

check("the course centre is derived from the package when none is handed off", () => {
  const { m } = newRound({ centre: null });
  // A fix at the course is trusted only if a centre was worked out.
  assert.strictEqual(m.signal("FIX_RECEIVED", { point: offsetM(TEE, -10, 0) }), true);
  assert.ok(m.scene().playButton.show, "Play should be offered once we know we are at the course");
});

check("a fix 15,000km away is not trusted (the null-island case)", () => {
  const { m } = newRound();
  assert.strictEqual(m.signal("FIX_RECEIVED", { point: { lat: 0, lng: 0 } }), false);
  assert.strictEqual(m.scene().playButton.show, false);
});

check("Play is not offered until a trusted fix says you are at the course", () => {
  const { m } = newRound();
  assert.strictEqual(m.scene().playButton.show, false);
  assert.strictEqual(m.signal("PLAY_PRESSED"), false, "Play must be inert with no fix");
  assert.strictEqual(m.scene().flow, "preview");
});

check("Play starts the hole you are standing on, not the one on screen", () => {
  const { m } = newRound();
  m.signal("VIEW_HOLE_CHANGED", { hole: 3 });
  m.signal("FIX_RECEIVED", { point: offsetM(H2_TEE, -5, 0) });   // standing on 2
  m.signal("PLAY_PRESSED");
  assert.strictEqual(m.scene().hole.number, 2);
  assert.strictEqual(m.scene().flow, "live");
});

check("looking at another hole is Preview; the live hole is untouched", () => {
  const { m } = playing();
  m.signal("LOCK");
  assert.strictEqual(m.scene().mode, "aim");
  m.signal("VIEW_HOLE_CHANGED", { hole: 3 });
  assert.strictEqual(m.scene().flow, "preview");
  assert.strictEqual(m.scene().mode, "setup");
  m.signal("VIEW_HOLE_CHANGED", { hole: 1 });
  assert.strictEqual(m.scene().flow, "live");
  assert.strictEqual(m.scene().mode, "aim", "the live hole comes back exactly as it was");
});

console.log("\n— the round moves when you say so —");

/* The arrows used to walk the round while Live: skip ahead to read the next
   hole and the app quietly decided you were playing it, with the dot and the
   green numbers reporting a hole you were nowhere near. They browse now. */
check("the arrows never move the live hole", () => {
  const { m } = playing();
  m.signal("NEXT_HOLE");
  assert.strictEqual(m.scene().hole.number, 2, "the view moved");
  assert.strictEqual(m.scene().flow, "preview", "but you are not playing it");
  m.signal("NEXT_HOLE");
  assert.strictEqual(m.scene().hole.number, 3);
  m.signal("VIEW_HOLE_CHANGED", { hole: 1 });
  assert.strictEqual(m.scene().flow, "live", "hole 1 was the live hole the whole time");
  assert.strictEqual(m.scene().mode, "track");
});

check("scroll ahead and Play appears only on the hole you have reached", () => {
  const { m } = playing();
  m.signal("NEXT_HOLE");
  assert.strictEqual(m.scene().playButton.show, false, "you are still on the 1st tee");
  m.signal("NEXT_HOLE");
  assert.strictEqual(m.scene().playButton.show, false);
  m.signal("FIX_RECEIVED", { point: offsetM(H2_TEE, -8, 0) });   // walk to the 2nd
  assert.strictEqual(m.scene().playButton.show, false, "looking at 3, standing at 2");
  m.signal("VIEW_HOLE_CHANGED", { hole: 2 });
  assert.strictEqual(m.scene().playButton.show, true, "there it is");
  assert.strictEqual(m.scene().playButton.hole, 2, "and it plays the hole on screen");
  m.signal("PLAY_PRESSED");
  assert.strictEqual(m.scene().flow, "live");
  assert.strictEqual(m.scene().hole.number, 2);
});

check("Play is inert on a hole you are only looking at", () => {
  const { m } = playing();
  m.signal("VIEW_HOLE_CHANGED", { hole: 3 });
  assert.strictEqual(m.signal("PLAY_PRESSED"), false);
  assert.strictEqual(m.scene().hole.number, 3);
  assert.strictEqual(m.scene().flow, "preview", "still just looking");
});

check("before the round Play still starts the nearest hole, from anywhere", () => {
  const { m } = newRound();
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, 250, 0) });   // car park, 250m off the 1st
  assert.strictEqual(m.scene().playButton.show, true, "or you could never get going");
  assert.strictEqual(m.scene().playButton.hole, 1);
});

console.log("\n— Live is sticky —");

check("losing GPS does not end the round", () => {
  const { m } = playing();
  m.signal("FIX_LOST");
  assert.strictEqual(m.scene().flow, "live", "still live");
  assert.strictEqual(m.scene().hole.number, 1);
  assert.strictEqual(m.state().live.hole, 1);
});

check("losing GPS marks the player stale but keeps the last honest position", () => {
  const { m } = playing();
  const before = m.scene().player;
  m.signal("FIX_LOST");
  const after = m.scene().player;
  assert.strictEqual(after.lat, before.lat);
  assert.strictEqual(after.stale, true);
});

check("only End Round clears the live hole", () => {
  const { m } = playing();
  ["FIX_LOST", "UNLOCK", "BACK", "VIEW_HOLE_CHANGED", "SHOT_END", "FINISH_LOGGED"].forEach((s) => {
    m.signal(s, { hole: 1 });
    assert.strictEqual(m.state().live.hole, 1, s + " must not clear the live hole");
  });
  m.signal("END_ROUND");
  assert.strictEqual(m.state().live.hole, null);
  assert.strictEqual(m.scene().flow, "preview");
});

console.log("\n— no bubble unless you asked —");

check("Track shows no bubble, however many fixes land", () => {
  const { m } = playing();
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -40, 0) });
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -80, 0) });
  assert.strictEqual(m.scene().mode, "track");
  assert.strictEqual(m.scene().bubble.show, false);
});

check("Lock is what shows the bubble", () => {
  const { m } = playing();
  assert.strictEqual(m.scene().bubble.show, false);
  m.signal("LOCK");
  assert.strictEqual(m.scene().bubble.show, true);
  assert.ok(m.scene().bubble.target, "and it has a default aim");
});

check("Unlock hides it, and the next fix does not bring it back", () => {
  const { m } = playing();
  m.signal("LOCK");
  m.signal("UNLOCK");
  assert.strictEqual(m.scene().mode, "track");
  assert.strictEqual(m.scene().bubble.show, false);
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -60, 0) });
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -90, 0) });
  assert.strictEqual(m.scene().bubble.show, false, "the stale-bubble regression");
});

check("Unlock keeps the shot in flight for Course Data", () => {
  const { m } = playing();
  m.signal("LOCK");
  m.signal("UNLOCK");
  assert.ok(m.openShot(1), "the shot is still open; the next Lock closes it");
});

check("Aim releases itself two fixes after you walk off the lock point", () => {
  const { m } = playing();
  m.signal("LOCK");
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -20, 0) });   // 15m — still there
  assert.strictEqual(m.scene().mode, "aim");
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -60, 0) });   // away, 1 of 2
  assert.strictEqual(m.scene().mode, "aim");
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -90, 0) });   // away, 2 of 2
  assert.strictEqual(m.scene().mode, "track", "you hit and walked");
  assert.ok(m.openShot(1), "releasing the view never ends the shot");
});

check("one wild fix does not release Aim", () => {
  const { m } = playing();
  m.signal("LOCK");
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -90, 0) });   // away, 1 of 2
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -8, 0) });    // back on the spot
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -90, 0) });   // away, 1 of 2 again
  assert.strictEqual(m.scene().mode, "aim");
});

console.log("\n— Preview —");

check("placing yourself IS the plan: the bubble appears with nothing pressed", () => {
  const { m } = newRound();
  assert.strictEqual(m.scene().startPill.show, true);
  m.signal("PLACED", { point: TEE });
  assert.strictEqual(m.scene().mode, "aim");
  assert.strictEqual(m.scene().bubble.show, true);
  assert.strictEqual(m.scene().startPill.show, false);
});

check("Unlock in Preview returns the pill, not a GPS dot", () => {
  const { m } = newRound();
  m.signal("PLACED", { point: TEE });
  m.signal("UNLOCK");
  assert.strictEqual(m.scene().mode, "setup");
  assert.strictEqual(m.scene().startPill.show, true);
  assert.strictEqual(m.scene().player, null, "the placement is un-given");
});

check("Preview aiming offers Unlock, or Head To the Tee is a one-way door", () => {
  const { m } = newRound();
  m.signal("PLACED", { point: TEE });
  const dock = m.scene().dock;
  assert.strictEqual(dock.show, true, "there must be a way back to the pill");
  assert.strictEqual(dock.face, "unlock");
  assert.strictEqual(dock.canShotEnd, false, "Preview records nothing, so no Shot End");
  m.signal("UNLOCK");
  assert.strictEqual(m.scene().startPill.show, true);
  assert.strictEqual(m.scene().dock.show, false, "back at the pill, nothing to unlock");
});

check("a tap while aiming does NOT move the origin", () => {
  const { m } = newRound();
  m.signal("PLACED", { point: TEE });
  const origin = JSON.stringify(m.scene().bubble.start);
  /* The tap that ends a bubble drag, a stray thumb, a second look at the
     green — none of them may re-place you once the bubble is up. */
  assert.strictEqual(m.signal("PLACED", { point: offsetM(TEE, -20, 30) }), false);
  assert.strictEqual(JSON.stringify(m.scene().bubble.start), origin);
});

check("Unlock is how you change your mind about where you are playing from", () => {
  const { m } = newRound();
  m.signal("PLACED", { point: TEE });
  m.signal("UNLOCK");
  assert.strictEqual(m.scene().mode, "setup");
  const moved = offsetM(TEE, -20, 30);
  assert.strictEqual(m.signal("PLACED", { point: moved }), true);
  assert.strictEqual(m.scene().bubble.start.lat.toFixed(5), moved.lat.toFixed(5));
});

/* Preview has exactly two modes. It used to grow a third when a tap landed
   near a green, which meant the mode you were in depended on where your finger
   went rather than on anything you chose — and it dragged the finish state into
   a flow that records nothing. */
check("standing on the green in Preview is still just Preview", () => {
  const { m } = newRound();
  m.signal("PLACED", { point: offsetM(GREEN, 8, 4) });
  const s = m.scene();
  assert.strictEqual(s.mode, "aim", "placing yourself always means the shot view");
  assert.strictEqual(s.finish.show, false, "no ball, no Shot End, nothing to log");
  assert.strictEqual(s.dock.face, "unlock");
});

check("Preview has no way into green focus at all", () => {
  const { m } = playing();
  m.signal("LOCK");                       // hole 1 now has an open shot
  m.signal("VIEW_HOLE_CHANGED", { hole: 3 });
  assert.strictEqual(m.scene().flow, "preview");
  assert.strictEqual(m.signal("FINISH_OPENED", { hole: 1 }), false, "not from Preview");
  assert.strictEqual(m.signal("FINISH_OPENED", { hole: 3 }), false, "and not on this hole either");
  assert.strictEqual(m.scene().mode, "setup");
  assert.strictEqual(m.scene().finishControl.show, false, "the control is Live-only now");
});

check("placing off the green still gives the shot view", () => {
  const { m } = newRound();
  m.signal("PLACED", { point: offsetM(GREEN, 120, 0) });
  assert.strictEqual(m.scene().mode, "aim");
  assert.strictEqual(m.scene().camera.stage, "shot");
  assert.strictEqual(m.scene().bubble.show, true);
});


check("Preview cannot open a shot", () => {
  const { m } = newRound();
  m.signal("PLACED", { point: TEE });
  assert.strictEqual(m.signal("LOCK"), false, "there is no Lock in Preview");
  assert.strictEqual(m.signal("SHOT_END"), false);
  assert.deepStrictEqual(m.shots(1), [], "nothing recorded");
});

check("previewing a hole records nothing on it", () => {
  const { m, effects } = playing();
  m.signal("VIEW_HOLE_CHANGED", { hole: 3 });
  m.signal("PLACED", { point: offsetM(TEE, -700, 0) });
  m.signal("AIM_DRAGGED", { point: offsetM(TEE, -850, 0) });
  m.signal("UNLOCK");
  assert.deepStrictEqual(m.shots(3), []);
  assert.strictEqual(effects.completed.length, 0);
});

console.log("\n— shots, open shots and Finish —");

check("Lock closes the previous shot and opens the next", () => {
  const { m, effects } = playing();
  m.signal("LOCK");
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -150, 0) });
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -160, 0) });   // releases aim
  m.signal("LOCK");
  assert.strictEqual(effects.completed.length, 1, "one shot closed");
  assert.strictEqual(effects.completed[0].meta.captureMethod, "lock");
  assert.strictEqual(m.shots(1).length, 2, "and the next is open");
  assert.ok(m.openShot(1));
});

check("Finish is offered exactly when the hole has an open shot", () => {
  const { m } = playing();
  assert.strictEqual(m.scene().finishControl.show, false, "nothing outstanding");
  m.signal("LOCK");
  assert.strictEqual(m.scene().mode, "aim");
  assert.strictEqual(m.scene().finishControl.show, false, "Shot End is the action while aiming");
  m.signal("UNLOCK");
  assert.strictEqual(m.scene().finishControl.show, true, "back at rest, with a shot outstanding");
  m.signal("FINISH_OPENED", { hole: 1 });
  m.signal("BALL_MOVED", { point: GREEN });
  m.signal("FINISH_LOGGED");
  m.signal("BACK");
  assert.strictEqual(m.scene().finishControl.show, false, "logged, so nothing to offer");
});

check("arriving at the green opens Finish only if there is something to log", () => {
  const { m } = playing();
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 10, 0) });
  assert.strictEqual(m.scene().mode, "track", "nothing open, so nothing happens");
  m.signal("LOCK");
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 60, 0) });   // away, releases aim
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 55, 0) });
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 8, 0) });    // arrive
  assert.strictEqual(m.scene().mode, "finish");
  assert.strictEqual(m.scene().finish.show, true);
});

console.log("\n— the picker's marks —");

check("an origin with no outcome is an open mark; logging it makes it done", () => {
  const { m } = playing();
  m.signal("LOCK");
  assert.deepStrictEqual(m.scene().picker.marks[1], { done: 0, open: 1 }, "0");
  m.signal("SHOT_END");
  assert.deepStrictEqual(m.scene().picker.marks[1], { done: 1, open: 0 }, "0-0");
});

check("a par 5 taking three locks counts three, which is what x3 is for", () => {
  const { m } = playing();
  for (let i = 0; i < 3; i++) {
    m.signal("FIX_RECEIVED", { point: offsetM(TEE, -60 * i, 0) });
    m.signal("FIX_RECEIVED", { point: offsetM(TEE, -60 * i - 2, 0) });   // release aim
    m.signal("LOCK");
  }
  const marks = m.scene().picker.marks[1];
  assert.strictEqual(marks.done, 2, "each Lock closed the one before it");
  assert.strictEqual(marks.open, 1, "and left the last one open");
});

check("holes with nothing on them carry no mark at all", () => {
  const { m } = playing();
  m.signal("LOCK");
  assert.deepStrictEqual(Object.keys(m.scene().picker.marks), ["1"]);
});

console.log("\n— Logging: catching up from the picker —");

check("the open mark is the only way in, and it needs something to close", () => {
  const { m } = playing();
  assert.strictEqual(m.signal("LOG_OPENED", { hole: 2 }), false, "nothing outstanding on 2");
  m.signal("LOCK");
  assert.strictEqual(m.signal("LOG_OPENED", { hole: 1 }), true);
  assert.strictEqual(m.scene().flow, "logging", "its own flow, not Preview wearing a finish");
  assert.strictEqual(m.scene().mode, "finish");
  assert.strictEqual(m.scene().camera.stage, "green");
  assert.ok(m.scene().finish.origin, "the origin is shown so you can reconstruct the shot");
});

check("logging records the outcome and puts you straight back", () => {
  const { m, effects } = playing();
  m.signal("LOCK");                          // hole 1 open
  walkTo(m, 2);                              // you are now live on hole 2
  m.signal("LOG_OPENED", { hole: 1 });
  assert.strictEqual(m.scene().hole.number, 1, "it takes you to the hole being logged");
  m.signal("BALL_MOVED", { point: offsetM(GREEN, 3, 2) });
  m.signal("FINISH_LOGGED");
  assert.strictEqual(effects.completed.length, 1, "the shot Live opened was closed");
  assert.strictEqual(effects.completed[0].meta.captureMethod, "ball-placed");
  assert.strictEqual(m.scene().hole.number, 2, "and it puts you back where you were");
  assert.strictEqual(m.scene().flow, "live", "in the flow you were in");
  assert.strictEqual(m.scene().mode, "track", "with no Logged screen in the way");
  assert.strictEqual(m.scene().picker.marks[1].open, 0, "the mark is closed");
});

check("backing out of a catch-up writes nothing and leaves the mark", () => {
  const { m, effects } = playing();
  m.signal("LOCK");
  walkTo(m, 2);
  m.signal("LOG_OPENED", { hole: 1 });
  m.signal("BALL_MOVED", { point: GREEN });
  assert.strictEqual(m.signal("BACK"), true);
  assert.strictEqual(effects.completed.length, 0, "nothing written");
  assert.strictEqual(m.scene().hole.number, 2, "back where you were");
  assert.strictEqual(m.scene().flow, "live");
  assert.strictEqual(m.scene().picker.marks[1].open, 1, "still outstanding");
});

check("Logging can never open a shot, only close one", () => {
  const { m } = playing();
  m.signal("LOCK");
  m.signal("LOG_OPENED", { hole: 1 });
  assert.strictEqual(m.signal("LOCK"), false, "no Lock in Logging");
  assert.strictEqual(m.signal("PLACED", { point: GREEN }), false, "and no placing");
  assert.strictEqual(m.signal("SHOT_END"), false);
  assert.strictEqual(m.shots(1).length, 1, "still the one shot Live opened");
});

check("a catch-up does not disturb the live hole", () => {
  const { m } = playing();
  m.signal("LOCK");
  walkTo(m, 2);
  m.signal("LOCK");                          // aiming on hole 2
  m.signal("LOG_OPENED", { hole: 1 });
  m.signal("BALL_MOVED", { point: GREEN });
  m.signal("FINISH_LOGGED");
  assert.strictEqual(m.scene().flow, "live");
  assert.strictEqual(m.scene().hole.number, 2);
  assert.strictEqual(m.scene().mode, "aim", "hole 2 comes back exactly as it was");
  assert.ok(m.openShot(2), "and its shot is still open");
});

console.log("\n— the Logged screen —");

check("Shot End lands on Logged, offering the next hole", () => {
  const { m } = playing();
  m.signal("LOCK");
  m.signal("SHOT_END");
  const logged = m.scene().logged;
  assert.strictEqual(logged.show, true);
  assert.strictEqual(logged.next.label, "Hole 2");
  assert.strictEqual(logged.next.signal, "ADVANCE_TO_HOLE");
  assert.deepStrictEqual(logged.next.payload, { hole: 2 });
});

/* The asymmetry is deliberate. The arrows are browsing, so they always land in
   Preview and wait for Play. This button names a hole and you pressed it having
   just finished a shot, so if the fix agrees you are there it commits. */
check("the Logged button goes live when you have arrived, Preview when you have not", () => {
  const near = playing();
  near.m.signal("LOCK");
  near.m.signal("SHOT_END");
  near.m.signal("FIX_RECEIVED", { point: offsetM(H2_TEE, -6, 0) });   // walked to the 2nd
  near.m.signal("ADVANCE_TO_HOLE", { hole: 2 });
  assert.strictEqual(near.m.scene().flow, "live", "you are there, so play it");
  assert.strictEqual(near.m.scene().hole.number, 2);

  const far = playing();
  far.m.signal("LOCK");
  far.m.signal("SHOT_END");
  far.m.signal("ADVANCE_TO_HOLE", { hole: 2 });                        // still on the 1st green
  assert.strictEqual(far.m.scene().flow, "preview", "not there yet");
  assert.strictEqual(far.m.scene().hole.number, 2);
  assert.strictEqual(far.m.scene().playButton.show, false, "and Play waits until you arrive");
});

check("Logged does not advance the hole on its own", () => {
  const { m } = playing();
  m.signal("LOCK");
  m.signal("SHOT_END");
  assert.strictEqual(m.scene().hole.number, 1, "you still have to putt");
});

check("Back leaves Logged and returns to Track on the same hole", () => {
  const { m } = playing();
  m.signal("LOCK");
  m.signal("SHOT_END");
  m.signal("BACK");
  assert.strictEqual(m.scene().mode, "track");
  assert.strictEqual(m.scene().hole.number, 1);
});

/* Logged is about the hole you just played, and nothing else. An older hole
   left outstanding is the picker's business — surfacing it here would put a
   detour in the middle of the one flow that should never have one. */
check("an older outstanding hole does not hijack the Logged button", () => {
  const { m } = playing();
  m.signal("LOCK");                               // 1 left open
  walkTo(m, 2);
  m.signal("LOCK");
  m.signal("SHOT_END");                           // 2 logged, 1 still outstanding
  assert.strictEqual(m.scene().logged.next.label, "Hole 3");
  assert.strictEqual(m.scene().picker.marks[1].open, 1, "1 is still flagged on the card");
});

check("the score stepper writes through to the scorecard", () => {
  const { m, effects } = playing();
  m.signal("LOCK");
  m.signal("SHOT_END");
  m.signal("SCORE_SET", { hole: 1, strokes: 4 });
  assert.deepStrictEqual(effects.scores, [{ hole: 1, strokes: 4 }]);
  assert.strictEqual(m.scene().logged.score, 4);
});

console.log("\n— the camera never chases —");

check("the camera frames the hole, never the player", () => {
  const { m } = playing();
  m.signal("VIEW_HOLE_CHANGED", { hole: 3 });       // miles from the fix
  const cam = m.scene().camera;
  assert.strictEqual(cam.stage, "hole");
  assert.strictEqual(cam.hole.holeNumber, 3);
  assert.ok(!("player" in cam), "the player is not something the camera fits");
});

check("Aim frames the shot; Finish frames the green", () => {
  const { m } = playing();
  m.signal("LOCK");
  assert.strictEqual(m.scene().camera.stage, "shot");
  m.signal("FINISH_OPENED", { hole: 1 });
  assert.strictEqual(m.scene().camera.stage, "green");
});

console.log("\n— signals that do nothing say so —");

check("an unknown signal is refused, not thrown", () => {
  const { m } = playing();
  assert.strictEqual(m.signal("NONSENSE"), false);
});

check("an inert signal answers false so Trace can show it", () => {
  const { m } = playing();
  assert.strictEqual(m.signal("BACK"), false, "nothing to peel");
  assert.strictEqual(m.signal("UNLOCK"), false, "not aiming");
  assert.strictEqual(m.signal("SHOT_END"), false, "no shot to end");
  assert.strictEqual(m.signal("FINISH_OPENED", { hole: 1 }), false, "nothing open");
});

check("every signal the concept lists has a handler", () => {
  const { m } = playing();
  ["ROUND_OPENED", "FIX_RECEIVED", "FIX_LOST", "PLAY_PRESSED", "END_ROUND",
    "VIEW_HOLE_CHANGED", "PLACED", "LOCK", "UNLOCK", "AIM_DRAGGED", "SHOT_END",
    "FINISH_OPENED", "BALL_MOVED", "FINISH_LOGGED", "SCORE_SET", "BACK",
    "NEXT_HOLE", "PREV_HOLE", "ADVANCE_TO_HOLE", "LOG_OPENED",
    "PACKAGE_UPDATED"].forEach((name) => {
      // A handler exists if the signal is not reported as unknown. Unknown and
      // inert both answer false, so probe the scene subscription instead.
      let sawUnknown = false;
      const probe = createMarshal({ trace: { signal: (n, p, info) => { if (!info.known) sawUnknown = true; }, error: () => {} } });
      probe.signal("ROUND_OPENED", { courseKey: "x", pkg: PKG, hole: 1 });
      probe.signal(name, { hole: 1, point: TEE, strokes: 4 });
      assert.strictEqual(sawUnknown, false, name + " has no handler");
    });
});

console.log("\n— the Painter is told, once, per signal —");

check("a scene is published only when something actually changed", () => {
  const { m } = playing();
  let scenes = 0;
  m.onScene(() => { scenes += 1; });
  m.signal("LOCK");
  assert.strictEqual(scenes, 1, "one signal, one scene");
  m.signal("BACK");                     // inert
  assert.strictEqual(scenes, 1, "an inert signal repaints nothing");
});

check("a crash in the Painter is reported, not swallowed", () => {
  const errors = [];
  const m = createMarshal({ trace: { signal: () => {}, error: (n, e) => errors.push(n) } });
  m.signal("ROUND_OPENED", { courseKey: "x", pkg: PKG, hole: 1 });
  m.onScene(() => { throw new Error("painter blew up"); });
  m.signal("PLACED", { point: TEE });
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0].startsWith("PAINT:"), "named so you can see which signal did it");
});

console.log("\n" + passed + " checks passed" + (process.exitCode ? " (with failures above)" : ""));
