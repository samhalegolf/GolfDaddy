/* The Marshal's transition table, driven in node with no browser.

   This is the test that makes the design in PLAY_OWNER_CONCEPT.md an assertion
   rather than a paragraph. Every rule the concept states as load-bearing has a
   check here, named after the rule.

   Run: node dev/marshal.test.js */
const assert = require("assert");
const path = require("path");
const createMarshal = require(path.join(__dirname, "..", "app", "js", "marshal.js"));
const distanceLib = require(path.join(__dirname, "..", "app", "js", "distance.js"));

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
const GREEN_3 = offsetM(TEE, -900, 0);

const PKG = {
  status: "lite-geo-ready",
  holes: [
    { holeNumber: 1, par: 4, tee: TEE, green: GREEN, greenShape: [], route: [] },
    { holeNumber: 2, par: 5, tee: H2_TEE, green: H2_GREEN, greenShape: [], route: [] },
    { holeNumber: 3, par: 3, tee: offsetM(TEE, -700, 0), green: offsetM(TEE, -900, 0), greenShape: [], route: [] }
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
    maxAimM: opts.maxAimM,
    now: () => 1000
  });
  m.signal("ROUND_OPENED", {
    courseKey: "verify", pkg: opts.pkg || PKG,
    centre: opts.centre === undefined ? null : opts.centre,   // null = must derive
    hole: 1
  });
  return { m, effects };
}

/* Walk on to the course and press Play. Returns a marshal live on hole 1.
   Standing 35m short of the tee point: inside the arrival radius, outside
   the tee zone, so Play lands in Track — the resting state most checks start
   from. Pressing it FROM the tee zone locks the tee shot (its own checks). */
function playing(opts = {}) {
  const r = newRound(opts);
  r.m.signal("FIX_RECEIVED", { point: offsetM(TEE, 35, 0) });
  r.m.signal("PLAY_PRESSED");
  return r;
}

/* The only way the round moves on now: physically arrive at the next tee and
   press Play. Every test that used to walk the round with NEXT_HOLE does this
   instead, which is the point of the change. */
const TEES = { 1: TEE, 2: H2_TEE, 3: offsetM(TEE, -700, 0) };
function walkTo(m, hole) {
  m.signal("FIX_RECEIVED", { point: offsetM(TEES[hole], 35, 0) });
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

check("manual GPS supplies only the missing hole and mapped play resumes after it", () => {
  const partial = { status: "lite-geo-ready", expectedHoleCount: 3, holes: [PKG.holes[0], PKG.holes[2]] };
  const { m } = newRound({ pkg: partial });
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -5, 0) });
  m.signal("VIEW_HOLE_CHANGED", { hole: 2 });
  assert.strictEqual(m.scene().hole.rec, null);
  assert.deepStrictEqual(m.scene().picker.holes, [1, 2, 3]);
  assert.strictEqual(m.signal("MANUAL_HOLE_SET", { hole: 2, green: H2_GREEN }), true);
  assert.strictEqual(m.scene().flow, "live");
  assert.deepStrictEqual(m.scene().hole.rec.green, H2_GREEN);
  m.signal("VIEW_HOLE_CHANGED", { hole: 3 });
  assert.deepStrictEqual(m.scene().hole.rec.green, GREEN_3);
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

check("Play starts the nearest hole when no hole has been chosen", () => {
  const { m } = newRound();                                       // opened on hole 1, not chosen
  m.signal("FIX_RECEIVED", { point: offsetM(H2_TEE, -5, 0) });   // standing on 2
  assert.strictEqual(m.scene().playButton.hole, 2, "the button names the hole you are on");
  m.signal("PLAY_PRESSED");
  assert.strictEqual(m.scene().hole.number, 2);
  assert.strictEqual(m.scene().flow, "live");
});

/* The report: on the 1st green the nearest tee was the 9th, fine — but picking
   hole 2 in the chooser still offered "Play hole 9". A hole the player went
   and looked at is the hole they mean, as long as they are near it. */
check("a hole chosen before the round wins over the nearest one", () => {
  const { m } = newRound();
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 5, 0) });    // on the 1st green, by the 3rd tee... nearest is 2
  assert.strictEqual(m.scene().playButton.hole, 2, "nearest wins until a hole is chosen");
  m.signal("VIEW_HOLE_CHANGED", { hole: 3 });
  assert.strictEqual(m.scene().playButton.hole, 3, "the chosen hole is offered");
  m.signal("PLAY_PRESSED");
  assert.strictEqual(m.scene().hole.number, 3);
  assert.strictEqual(m.scene().flow, "live");
});

check("a chosen hole you are nowhere near falls back to the nearest", () => {
  const far = { status: "lite-geo-ready", holes: PKG.holes.concat([
    { holeNumber: 4, par: 4, tee: offsetM(TEE, -5000, 0), green: offsetM(TEE, -5300, 0), greenShape: [], route: [] }]) };
  const { m } = newRound({ pkg: far, centre: TEE });
  m.signal("FIX_RECEIVED", { point: offsetM(H2_TEE, -5, 0) });
  m.signal("VIEW_HOLE_CHANGED", { hole: 4 });
  assert.strictEqual(m.scene().playButton.hole, 2, "5km away is not a credible choice");
});

check("Play pressed from the tee box locks the tee shot straight away", () => {
  const { m } = newRound();
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -5, 0) });      // on the tee
  m.signal("PLAY_PRESSED");
  const s = m.scene();
  assert.strictEqual(s.flow, "live");
  assert.strictEqual(s.mode, "aim", "locked in, nothing to press");
  assert.strictEqual(s.bubble.show, true);
  assert.ok(m.openShot(1), "the tee shot is open from the tee");
});

check("Play pressed from the fairway lands in Track, not locked", () => {
  const { m } = newRound();
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -120, 0) });    // down the 1st, 120m off the tee
  m.signal("PLAY_PRESSED");
  assert.strictEqual(m.scene().flow, "live");
  assert.strictEqual(m.scene().mode, "track", "no guess at where the shot is from");
  assert.strictEqual(m.openShot(1), null);
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

check("resume restores the canonical live hole, not merely the viewed hole", () => {
  const { m } = newRound();
  m.signal("VIEW_HOLE_CHANGED", { hole: 1 });
  assert.strictEqual(m.state().live.hole, null, "ordinary viewing remains Preview");
  assert.strictEqual(m.signal("RESUME_HOLE", { hole: 2 }), true);
  assert.strictEqual(m.state().live.hole, 2);
  assert.strictEqual(m.scene().hole.number, 2);
  assert.strictEqual(m.scene().flow, "live");
  m.signal("FIX_RECEIVED", { point: TEE });
  assert.strictEqual(m.state().live.hole, 2, "a later suggestion/fix cannot replace the resumed hole");
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

check("scroll ahead offers an explicit override for a selected hole within about 1km", () => {
  const { m } = playing();
  m.signal("NEXT_HOLE");
  assert.strictEqual(m.scene().playButton.show, true, "hole 2 is reasonably close to the course position");
  assert.strictEqual(m.state().live.hole, 1, "the offer alone does not move the live round");
  m.signal("NEXT_HOLE");
  assert.strictEqual(m.scene().playButton.show, true, "hole 3 is still inside the explicit override radius");
  m.signal("FIX_RECEIVED", { point: offsetM(H2_TEE, -8, 0) });   // walk to the 2nd
  assert.strictEqual(m.scene().playButton.show, true, "the selected hole remains the proposed override");
  m.signal("VIEW_HOLE_CHANGED", { hole: 2 });
  assert.strictEqual(m.scene().playButton.show, true, "there it is");
  assert.strictEqual(m.scene().playButton.hole, 2, "and it plays the hole on screen");
  m.signal("PLAY_PRESSED");
  assert.strictEqual(m.scene().flow, "live");
  assert.strictEqual(m.scene().hole.number, 2);
});

check("Play is inert on a selected hole beyond the override radius", () => {
  const farPkg = { status: "lite-geo-ready", holes: PKG.holes.concat([
    { holeNumber: 9, par: 4, tee: offsetM(TEE, -1400, 0), green: offsetM(TEE, -1650, 0), greenShape: [], route: [] }
  ]) };
  const { m } = playing({ pkg: farPkg, centre: TEE });
  m.signal("VIEW_HOLE_CHANGED", { hole: 9 });
  assert.strictEqual(m.signal("PLAY_PRESSED"), false);
  assert.strictEqual(m.scene().hole.number, 9);
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

check("a course package update preserves live, preview and shot state", () => {
  const { m } = playing();
  m.signal("LOCK");
  m.signal("VIEW_HOLE_CHANGED", { hole: 2 });
  const before = m.state();
  const updated = JSON.parse(JSON.stringify(PKG));
  updated.packageVersion = 9;
  updated.holes[1].green = offsetM(H2_GREEN, 2, 0);
  assert.strictEqual(m.signal("PACKAGE_UPDATED", { pkg: updated }), true);
  const after = m.state();
  assert.strictEqual(after.live.hole, before.live.hole, "the canonical live hole survives");
  assert.strictEqual(after.viewHole, before.viewHole, "the previewed hole survives");
  assert.deepStrictEqual(after.shots, before.shots, "the in-progress shot survives");
  assert.strictEqual(m.scene().flow, "preview", "the player stays in the same play/preview mode");
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
  m.signal("LOCK");                                            // locked 35m short of the tee point
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, 20, 0) });    // 15m — still there
  assert.strictEqual(m.scene().mode, "aim");
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -20, 0) });   // away, 1 of 2
  assert.strictEqual(m.scene().mode, "aim");
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -50, 0) });   // away, 2 of 2
  assert.strictEqual(m.scene().mode, "track", "you hit and walked");
  assert.ok(m.openShot(1), "releasing the view never ends the shot");
});

check("one wild fix does not release Aim", () => {
  const { m } = playing();
  m.signal("LOCK");
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -50, 0) });   // away, 1 of 2
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, 32, 0) });    // back on the spot
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -50, 0) });   // away, 1 of 2 again
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

/* Placing yourself on the green means green focus, the same picture a fix
   arriving there gives you: a draggable ball and Shot End. Anything else would
   be a shot view whose start and target are the same point. */
/* Green focus is the logging popup now, and Preview has nothing to log — so
   a tap on the green is inert rather than a bubble aiming at itself or a
   popup with a dead button. */
check("placing yourself on the green is inert in Preview", () => {
  const { m } = newRound();
  assert.strictEqual(m.signal("PLACED", { point: offsetM(GREEN, 8, 4) }), false);
  const s = m.scene();
  assert.strictEqual(s.mode, "setup");
  assert.strictEqual(s.finish.show, false, "no ball, no popup");
  assert.strictEqual(s.bubble.show, false, "no bubble aiming at itself");
  assert.strictEqual(s.startPill.show, true, "the pill is still up");
});

/* Preview opens no shots, so nothing it does can close one — and it must not
   reach across and close a shot on a hole you are not standing on either.
   That is the picker's badge. */
check("Preview cannot log, whatever you tap", () => {
  const { m, effects } = playing();
  m.signal("LOCK");                        // hole 1 has an open shot
  m.signal("VIEW_HOLE_CHANGED", { hole: 3 });
  assert.strictEqual(m.signal("PLACED", { point: offsetM(GREEN_3, 6, 0) }), false);
  assert.strictEqual(m.signal("BALL_MOVED", { point: offsetM(GREEN_3, 2, 2) }), false);
  assert.strictEqual(m.signal("FINISH_LOGGED"), false);
  assert.deepStrictEqual(m.shots(3), [], "nothing recorded on the hole you looked at");
  assert.strictEqual(m.openShot(1) !== null, true, "and nothing closed on the hole you left");
  assert.strictEqual(effects.completed.length, 0);
  assert.strictEqual(m.scene().mode, "setup");
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

console.log("\n— the bag's roof on a dragged aim —");

check("a live drag past the bag's reach stops at the roof, on the drag line", () => {
  const { m } = playing({ maxAimM: () => 250 });
  m.signal("LOCK");
  const start = offsetM(TEE, 35, 0);            // the fix playing() locked from
  m.signal("AIM_DRAGGED", { point: offsetM(start, -400, 0) });
  const target = m.openShot(1).target;
  assert.ok(Math.abs(distanceLib.haversineMeters(start, target) - 250) < 0.5,
    "the target sits at the roof, not where the finger went");
  assert.ok(Math.abs(target.lng - start.lng) < 1e-9, "and stays on the drag bearing");
});

check("a drag within the bag's reach is untouched", () => {
  const { m } = playing({ maxAimM: () => 250 });
  m.signal("LOCK");
  const asked = offsetM(offsetM(TEE, 35, 0), -180, 20);
  m.signal("AIM_DRAGGED", { point: asked });
  assert.deepStrictEqual(m.openShot(1).target, asked);
});

check("a Preview drag clamps from the placement, not the tee", () => {
  const { m, effects } = newRound({ maxAimM: () => 250 });
  const placement = offsetM(TEE, -100, 0);
  m.signal("PLACED", { point: placement });
  m.signal("AIM_DRAGGED", { point: offsetM(placement, -600, 0) });
  const target = effects.shotChanges[effects.shotChanges.length - 1].target;
  assert.ok(Math.abs(distanceLib.haversineMeters(placement, target) - 250) < 0.5);
});

check("no roof rule (no engine) leaves the drag free", () => {
  const { m } = playing();
  m.signal("LOCK");
  const asked = offsetM(offsetM(TEE, -5, 0), -400, 0);
  m.signal("AIM_DRAGGED", { point: asked });
  assert.deepStrictEqual(m.openShot(1).target, asked);
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

check("Log shot is offered only with an open shot, at rest, near the green", () => {
  const { m } = playing();
  assert.strictEqual(m.scene().finishControl.show, false, "nothing outstanding");
  m.signal("LOCK");
  assert.strictEqual(m.scene().mode, "aim");
  assert.strictEqual(m.scene().finishControl.show, false, "not while aiming - the next Lock is the shot end");
  m.signal("UNLOCK");
  assert.strictEqual(m.scene().finishControl.show, false, "at rest but 335m from the green: nothing to log by hand yet");
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 60, 0) });
  assert.strictEqual(m.scene().finishControl.show, true, "near the green, with a shot outstanding");
  m.signal("FINISH_OPENED", { hole: 1 });
  m.signal("BALL_MOVED", { point: GREEN });
  m.signal("FINISH_LOGGED");
  m.signal("BACK");
  assert.strictEqual(m.scene().finishControl.show, false, "logged, so nothing to offer");
});

check("the next Lock closes the previous shot - no Shot End needed mid-hole", () => {
  const { m, effects } = playing();
  m.signal("LOCK");
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -120, 0) });
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -150, 0) });     // aim released
  assert.strictEqual(m.scene().mode, "track");
  m.signal("LOCK");
  assert.strictEqual(effects.completed.length, 1, "locking again ended the tee shot where you now stand");
  assert.strictEqual(effects.completed[0].meta.captureMethod, "lock");
  assert.strictEqual(m.shots(1).length, 2, "and opened the next");
});

check("the coin stops inviting near the green", () => {
  const { m } = playing();
  assert.strictEqual(m.scene().dock.invite, true, "still, in Track, on the fairway");
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 50, 0) });
  assert.strictEqual(m.scene().dock.invite, false, "inside the log band it stays quiet");
});

/* Green focus is a VIEW and opens on position alone. It used to need an open
   shot, so a hole played without locking anything never gave you the green at
   all — and the ball you are meant to drag was the only thing that could have
   put a score on the card. */
/* The popup exists to place an outcome. A hole played without a lock has no
   outcome to place, so arriving on its green stays in Track — and Hole done
   is offered on position instead, since that is the one thing left to say. */
check("arriving at the green with nothing outstanding stays in Track and offers Hole done", () => {
  const { m } = playing();
  assert.strictEqual(m.scene().holeCompleteControl.show, false, "not from the tee");
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 10, 0) });
  const s = m.scene();
  assert.strictEqual(s.mode, "track", "nothing to log, so no popup");
  assert.strictEqual(s.finish.show, false);
  assert.strictEqual(s.holeCompleteControl.show, true, "but the hole can be called done");
  assert.strictEqual(m.signal("HOLE_COMPLETED", { hole: 1 }), true);
  assert.strictEqual(m.scene().mode, "complete");
});

check("arriving at the green with a shot open opens the popup with the ball where you stand", () => {
  const { m } = playing();
  m.signal("LOCK");
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 60, 0) });
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 50, 0) });     // aim released
  assert.strictEqual(m.scene().mode, "track");
  const here = offsetM(GREEN, 10, 0);
  m.signal("FIX_RECEIVED", { point: here });
  const s = m.scene();
  assert.strictEqual(s.mode, "finish", "the popup opens");
  assert.strictEqual(s.finish.canLog, true);
  assert.strictEqual(s.finish.ball.lat.toFixed(6), here.lat.toFixed(6), "the ball starts on your fix");
  assert.strictEqual(s.camera.stage, "hole", "the camera is left alone; the green is in the popup");
});

/* The whole of the guest rule: no account, no popup — not a popup whose one
   button is refused. Lock and Unlock stay, because they are the rangefinder. */
check("a rangefinder-only session never reaches green focus", () => {
  const effects = { completed: [] };
  const m = createMarshal({ canLogShots: () => false, now: () => 1000,
    effects: { shotCompleted: (shot, meta) => effects.completed.push({ shot, meta }) } });
  m.signal("ROUND_OPENED", { courseKey: "guest", pkg: PKG, centre: null, hole: 1 });
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -5, 0) });
  m.signal("PLAY_PRESSED");
  assert.strictEqual(m.scene().mode, "aim", "the tee shot still locks");
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 60, 0) });
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 50, 0) });
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 10, 0) });
  assert.strictEqual(m.scene().mode, "track", "walking onto the green opens nothing");
  assert.strictEqual(m.signal("FINISH_OPENED", { hole: 1 }), false, "Log shot is refused");
  assert.strictEqual(m.signal("BALL_MOVED", { point: GREEN }), false, "a wearable ball placement opens nothing");
  assert.strictEqual(m.signal("LOG_OPENED", { hole: 1 }), false, "and so is the picker's catch-up");
  assert.strictEqual(m.scene().finish.show, false);
  assert.strictEqual(effects.completed.length, 0);
});

/* The case this whole change is named after: chip on from inside the aim
   release radius. The lock never releases (that wants two fixes 30m away), so
   the old rule left you standing on the green with the approach bubble up. */
check("green focus takes the screen out of Aim, not only out of Track", () => {
  const { m } = playing();
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 25, 0) });   // just off the green
  m.signal("BACK");                                             // close it; I want to aim
  m.signal("LOCK");                                             // chip, locked from here
  assert.strictEqual(m.scene().mode, "aim");
  /* Standing over it. The bubble stays: nothing has been played yet, and a
     green that grabbed the screen back here would make the aim unusable. */
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 24, 0) });
  assert.strictEqual(m.scene().mode, "aim", "still deciding");
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 4, 0) });    // walked 20m on to the green
  const s = m.scene();
  assert.strictEqual(s.mode, "finish", "the green wins once the shot is played");
  assert.strictEqual(s.bubble.show, false, "and the bubble is put away");
  assert.ok(m.openShot(1), "the chip is still open, waiting for the ball");
});

/* The ordinary approach: locked from 120m, walked in. The aim release (two
   fixes 30m from the lock) has already fired by then, but the rule that
   matters is the same one — the ground has been covered. */
check("the long approach still lands you on the green", () => {
  const { m } = playing();
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 120, 0) });
  m.signal("LOCK");
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 30, 0) });
  const s = m.scene();
  assert.strictEqual(s.mode, "finish");
  assert.strictEqual(s.finish.canLog, true, "with the approach still open to close");
  assert.strictEqual(s.finish.origin.lat.toFixed(5), offsetM(GREEN, 120, 0).lat.toFixed(5),
    "and its origin drawn, so you can see the shot you are reconstructing");
});

/* Positional means it would reopen on the very next fix, so closing it has to
   be remembered — and forgotten again once you have walked away. */
check("a green focus closed by hand stays closed until you leave the green", () => {
  const { m } = playing();
  m.signal("LOCK");                                             // something to log
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 10, 0) });
  assert.strictEqual(m.scene().mode, "finish");
  m.signal("BACK");
  assert.strictEqual(m.scene().mode, "track");
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 12, 0) });
  assert.strictEqual(m.scene().mode, "track", "still standing there, still closed");
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 60, 0) });   // walked off
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 15, 0) });   // and back
  assert.strictEqual(m.scene().mode, "finish", "a new arrival is a new answer");
});

/* You are still playing on the green: the chip and the putt both want a
   number. The old rule blanked the card the moment focus opened. */
check("green focus keeps a distance to the middle", () => {
  const { m } = playing();
  m.signal("LOCK");
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 30, 0) });
  const s = m.scene();
  assert.strictEqual(s.distances.show, true, "there is still a number to read");
  assert.strictEqual(s.distances.single, true, "one number, not the full card");
  assert.strictEqual(s.distances.centre, 30);
  /* And it measures from the BALL once the ball has been moved, because that
     is where the player now is. */
  m.signal("BALL_MOVED", { point: offsetM(GREEN, 8, 0) });
  assert.strictEqual(m.scene().distances.centre, 8);
});

/* Shot End frames the actual landing area with the green, rather than always
   zooming back out to the full trigger band. */
check("green focus does not move the camera", () => {
  const { m } = playing();
  m.signal("LOCK");
  m.signal("FINISH_OPENED", { hole: 1 });
  const cam = m.scene().camera;
  assert.strictEqual(m.scene().mode, "finish");
  assert.strictEqual(cam.stage, "hole", "the popup carries its own picture of the green");
});

console.log("\n— moving and standing still —");

check("walking hides the club; standing still invites the lock", () => {
  const { m } = playing();
  assert.strictEqual(m.scene().motion.moving, false, "nothing measured yet reads as still");
  assert.strictEqual(m.scene().dock.invite, true, "Track, still, with a fix: the coin invites");
  assert.strictEqual(m.scene().suggestion.show, true, "and a club is suggested from here");
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -10, 0), speed: 1.4 });
  assert.strictEqual(m.scene().motion.moving, true, "a walking pace is moving");
  assert.strictEqual(m.scene().dock.invite, false);
  assert.strictEqual(m.scene().suggestion.show, false, "no club while walking");
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -12, 0), speed: 0.5 });
  assert.strictEqual(m.scene().motion.moving, true, "slowing is not yet stopped (hysteresis)");
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -12, 0), speed: 0 });
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, -12, 0), speed: 0 });
  assert.strictEqual(m.scene().motion.moving, false, "stopped");
  assert.strictEqual(m.scene().dock.invite, true);
});

check("moving is measured from displacement when the platform reports no speed", () => {
  let t = 1000;
  const m = createMarshal({ now: () => t });
  m.signal("ROUND_OPENED", { courseKey: "walk", pkg: PKG, centre: null, hole: 1 });
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, 35, 0) });
  m.signal("PLAY_PRESSED");
  t += 1000; m.signal("FIX_RECEIVED", { point: offsetM(TEE, 33.5, 0) });   // 1.5 m/s
  t += 1000; m.signal("FIX_RECEIVED", { point: offsetM(TEE, 32, 0) });
  assert.strictEqual(m.scene().motion.moving, true);
  t += 1000; m.signal("FIX_RECEIVED", { point: offsetM(TEE, 32, 0) });     // 0 m/s
  t += 1000; m.signal("FIX_RECEIVED", { point: offsetM(TEE, 32, 0) });
  t += 1000; m.signal("FIX_RECEIVED", { point: offsetM(TEE, 32, 0) });
  assert.strictEqual(m.scene().motion.moving, false);
});

check("aiming while walking keeps the shot but hides the club", () => {
  const { m } = playing();
  m.signal("LOCK");
  m.signal("FIX_RECEIVED", { point: offsetM(TEE, 30, 0), speed: 1.3 });
  const s = m.scene();
  assert.strictEqual(s.mode, "aim", "inside the release radius the shot stays");
  assert.strictEqual(s.bubble.show, true);
  assert.strictEqual(s.motion.moving, true, "the Painter reads this to hide the club chip");
  assert.strictEqual(s.dock.invite, false);
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
  assert.strictEqual(m.scene().camera.stage, "hole", "the popup carries the green; the camera stays");
  assert.ok(m.scene().finish.origin, "the origin is shown so you can reconstruct the shot");
  assert.strictEqual(m.scene().finish.ball.lat.toFixed(6), GREEN.lat.toFixed(6),
    "from the picker the ball starts on the green's centre, not on your fix");
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

/* Where the shot ENDED is the only thing that says whether it was the last one
   of the hole. On the green, the hole is done and the holding screen is next;
   anywhere else, what is next is the rest of the hole. */
check("Shot End on the green offers Hole complete; mid-hole it offers the rest of it", () => {
  const onGreen = playing();
  onGreen.m.signal("LOCK");
  onGreen.m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 6, 0) });   // green focus opens
  onGreen.m.signal("FINISH_LOGGED");
  const logged = onGreen.m.scene().logged;
  assert.strictEqual(logged.show, true);
  assert.strictEqual(logged.next.label, "Hole complete");
  assert.strictEqual(logged.next.signal, "HOLE_COMPLETED");

  const midHole = playing();
  midHole.m.signal("LOCK");
  midHole.m.signal("SHOT_END");                                        // still on the tee
  assert.strictEqual(midHole.m.scene().logged.next.label, "Keep playing");
  assert.strictEqual(midHole.m.scene().logged.next.signal, "BACK");
});

console.log("\n— the holding screen, and the hole after it —");

/* Untouched means par. The holding screen exists so that finishing a hole asks
   nothing of you, and a score you never look at is the common case. */
check("Hole complete writes par without being asked", () => {
  const { m, effects } = playing();
  m.signal("LOCK");
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 6, 0) });
  m.signal("FINISH_LOGGED");
  m.signal("HOLE_COMPLETED");
  const s = m.scene();
  assert.strictEqual(s.mode, "complete");
  assert.strictEqual(s.holeComplete.show, true);
  assert.strictEqual(s.holeComplete.par, 4);
  assert.strictEqual(s.holeComplete.score, 4, "par, untouched");
  assert.deepStrictEqual(effects.scores, [{ hole: 1, strokes: 4 }]);
  assert.strictEqual(s.holeComplete.next.signal, "ADVANCE_TO_HOLE");
  assert.deepStrictEqual(s.holeComplete.next.payload, { hole: 2 });
  assert.strictEqual(s.distances.show, false, "the hole is over; there is nothing to measure");
});

check("the + and - step from par and cannot go below one", () => {
  const { m, effects } = playing();
  m.signal("LOCK");
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 6, 0) });
  m.signal("FINISH_LOGGED");
  m.signal("HOLE_COMPLETED");
  m.signal("SCORE_STEP", { delta: 1 });
  assert.strictEqual(m.scene().holeComplete.score, 5);
  for (let i = 0; i < 8; i++) m.signal("SCORE_STEP", { delta: -1 });
  assert.strictEqual(m.scene().holeComplete.score, 1, "a hole takes at least one shot");
  assert.strictEqual(effects.scores[effects.scores.length - 1].strokes, 1);
});

/* The reason the holding screen is there at all: Next hole must not decide you
   are standing on the next hole. It used to, whenever the fix happened to be
   within 100m of the tee — which on a tight course is most greens. */
check("Next hole previews, and never goes live on the strength of where you stand", () => {
  const { m } = playing();
  m.signal("LOCK");
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 6, 0) });
  m.signal("FINISH_LOGGED");
  m.signal("HOLE_COMPLETED");
  /* Standing on the 1st green, which is 46m from the 2nd tee — inside the old
     arrival radius and well outside the tee zone. */
  m.signal("ADVANCE_TO_HOLE", { hole: 2 });
  const s = m.scene();
  assert.strictEqual(s.flow, "preview");
  assert.strictEqual(s.mode, "queued");
  assert.strictEqual(s.hole.number, 2);
  assert.strictEqual(s.queued.show, true);
  assert.strictEqual(s.queued.atTee, false);
  assert.strictEqual(s.camera.stage, "hole", "framed on the hole, not on you");
  assert.strictEqual(s.bubble.show, false);
  assert.strictEqual(s.distances.show, false, "no readout relative to where you are");
  /* And Play is there anyway: the override that says we could be wrong about
     the tee. */
  assert.strictEqual(s.playButton.show, true);
  assert.strictEqual(s.playButton.hole, 2);
});

check("walking into the tee zone presses Play for you", () => {
  const { m } = playing();
  m.signal("LOCK");
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 6, 0) });
  m.signal("FINISH_LOGGED");
  m.signal("HOLE_COMPLETED");
  m.signal("ADVANCE_TO_HOLE", { hole: 2 });
  m.signal("FIX_RECEIVED", { point: offsetM(H2_TEE, 40, 0) });   // walking over
  assert.strictEqual(m.scene().flow, "preview", "not yet");
  m.signal("FIX_RECEIVED", { point: offsetM(H2_TEE, -5, 0) });   // on the tee
  const s = m.scene();
  assert.strictEqual(s.flow, "live", "arriving IS the press");
  assert.strictEqual(s.mode, "track");
  assert.strictEqual(s.hole.number, 2);
});

/* The override, used. A tee the package put in the wrong place, or a scramble
   starting somewhere else, must not be able to trap you on the preview. */
check("Play this hole starts it from wherever you are", () => {
  const { m } = playing();
  m.signal("LOCK");
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 6, 0) });
  m.signal("FINISH_LOGGED");
  m.signal("HOLE_COMPLETED");
  m.signal("ADVANCE_TO_HOLE", { hole: 3 });                      // miles away
  assert.strictEqual(m.scene().playButton.show, true);
  assert.strictEqual(m.signal("PLAY_PRESSED"), true);
  assert.strictEqual(m.scene().flow, "live");
  assert.strictEqual(m.scene().hole.number, 3);
});

/* A fix may only ever start the hole ALREADY ON SCREEN, put there by a
   deliberate press. Walking past the 2nd tee while browsing hole 3 must do
   nothing at all. */
check("the tee zone cannot start a hole you did not queue", () => {
  const { m } = playing();
  m.signal("VIEW_HOLE_CHANGED", { hole: 3 });
  assert.strictEqual(m.scene().mode, "setup", "browsing, not queued");
  m.signal("FIX_RECEIVED", { point: offsetM(H2_TEE, -2, 0) });   // standing on the 2nd tee
  assert.strictEqual(m.scene().flow, "preview");
  assert.strictEqual(m.scene().hole.number, 3, "and still looking at 3");
});

check("Back off the holding screen returns to the green you just finished", () => {
  const { m } = playing();
  m.signal("LOCK");
  m.signal("FIX_RECEIVED", { point: offsetM(GREEN, 6, 0) });
  m.signal("FINISH_LOGGED");
  m.signal("HOLE_COMPLETED");
  assert.strictEqual(m.signal("BACK"), true);
  assert.strictEqual(m.scene().mode, "track");
  assert.strictEqual(m.scene().hole.number, 1);
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
  assert.strictEqual(m.scene().logged.next.label, "Keep playing", "hole 2 is not over");
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

check("Aim frames the shot; Finish leaves the hole frame under the popup", () => {
  const { m } = playing();
  m.signal("LOCK");
  assert.strictEqual(m.scene().camera.stage, "shot");
  m.signal("FINISH_OPENED", { hole: 1 });
  assert.strictEqual(m.scene().camera.stage, "hole");
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
    "RESUME_HOLE",
    "VIEW_HOLE_CHANGED", "PLACED", "LOCK", "UNLOCK", "AIM_DRAGGED", "SHOT_END",
    "FINISH_OPENED", "BALL_MOVED", "FINISH_LOGGED", "SCORE_SET", "SCORE_STEP", "BACK",
    "HOLE_COMPLETED", "NEXT_HOLE", "PREV_HOLE", "ADVANCE_TO_HOLE", "LOG_OPENED",
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

console.log("\n— OSM surfaces —");

/* A ring around a point, big enough to survive the >= 3 point rule. */
function ringAt(base, r) {
  return [offsetM(base, r, -r), offsetM(base, r, r), offsetM(base, -r, r), offsetM(base, -r, -r)];
}
const SURFACES = {
  fairways: [{ shape: ringAt(offsetM(TEE, -150, 0), 30), centre: offsetM(TEE, -150, 0) }],
  bunkers: [{ shape: ringAt(offsetM(TEE, -280, 15), 7), centre: offsetM(TEE, -280, 15) }],
  water: [
    { shape: ringAt(offsetM(TEE, -200, 40), 25), centre: offsetM(TEE, -200, 40), hazardClass: "penalty_area" },
    { shape: ringAt(offsetM(TEE, -120, 55), 20), centre: offsetM(TEE, -120, 55), hazardClass: "water" }
  ]
};

function withSurfaces(pkg) {
  return Object.assign({}, pkg, { holes: pkg.holes.map(h =>
    Number(h.holeNumber) === 1 ? Object.assign({}, h, { surfaces: SURFACES }) : h) });
}

check("a lite package's surfaces reach the hole record the Painter draws from", () => {
  const m = createMarshal({});
  m.signal("ROUND_OPENED", { courseKey: "surf", pkg: withSurfaces(PKG), hole: 1 });
  const s = m.scene().hole.rec.surfaces;
  assert.strictEqual(s.bunkers.length, 1);
  assert.strictEqual(s.fairways.length, 1);
  assert.strictEqual(s.water.length, 2);
  /* The distinction the mapper preserved has to survive to the thing that draws
     it, or the dashed "water, not asserted as a penalty area" edge is unreachable. */
  assert.deepStrictEqual(s.water.map(w => w.hazardClass).sort(), ["penalty_area", "water"]);
});

check("a full package carries surfaces under geometry, and reaches the same place", () => {
  const full = { status: "full-map-ready", holes: [{
    holeNumber: 1,
    geometry: { tee: TEE, green: GREEN, greenShape: [], route: [], surfaces: SURFACES },
    visual: null
  }] };
  const m = createMarshal({});
  m.signal("ROUND_OPENED", { courseKey: "surf", pkg: full, hole: 1 });
  assert.strictEqual(m.scene().hole.rec.surfaces.bunkers.length, 1);
});

check("a course OSM had no surfaces for reports null, not empty scaffolding", () => {
  const m = createMarshal({});
  m.signal("ROUND_OPENED", { courseKey: "bare", pkg: PKG, hole: 1 });
  assert.strictEqual(m.scene().hole.rec.surfaces, null);
  /* And the hole is otherwise completely normal - enrichment is enrichment. */
  assert.ok(m.scene().hole.rec.green && m.scene().hole.rec.tee);
});

check("a malformed ring off the wire is dropped rather than reaching the Painter", () => {
  const broken = withSurfaces(PKG);
  broken.holes[0].surfaces = {
    fairways: [],
    bunkers: [{ shape: [TEE, GREEN] }, { shape: ringAt(offsetM(TEE, -280, 15), 7) }],
    water: [{ shape: "not an array" }]
  };
  const m = createMarshal({});
  m.signal("ROUND_OPENED", { courseKey: "surf", pkg: broken, hole: 1 });
  const s = m.scene().hole.rec.surfaces;
  assert.strictEqual(s.bunkers.length, 1, "the two-point bunker is not a polygon");
  assert.strictEqual(s.water.length, 0);
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
