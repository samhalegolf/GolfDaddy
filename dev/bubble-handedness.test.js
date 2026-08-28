/* The handedness convention, pinned.
 *
 * The Bubble's long axis is TILTED, and the sign of that tilt is what puts its
 * near end on one side and its far/downrange end on the other. Right-handed and
 * left-handed players get mirrored tilts, so the two look like each other's
 * reflection - which is correct, and which is also exactly what an accidental
 * mirror somewhere in the render chain would look like.
 *
 * That ambiguity is the reason for this file. Without it, the next person to
 * look at a left-handed bubble and think "that's backwards" has no way to tell
 * a deliberate convention from a bug, and the tempting fix is a sign flip in
 * whichever view they happened to be looking at - GPS Play, My Bubble, Studio -
 * which silently puts that one view out of step with the other two.
 *
 * So the convention is asserted HERE, at the shared derivation in
 * gd-app-core.js, and nowhere else:
 *
 *   right-handed  -> positive tilt
 *   left-handed   -> negative tilt, equal magnitude
 *
 * If the physical orientation is ever judged wrong, this is the file to change,
 * and changing it moves every view together. A view-local inversion is always
 * the wrong fix and these tests are here to make that obvious.
 *
 * The generated player engine (app/js/bubble-engine.js) is NOT tested here -
 * it is a byte-for-byte copy of these same functions, asserted identical by
 * dev/fresh-app-boot.test.js, and testing the copy would pin the generator
 * rather than the rule. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CORE = path.join(ROOT, "scripts", "gd-app-core.js");
const src = fs.readFileSync(CORE, "utf8");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* Lift the handedness functions out of gd-app-core.js and run them in
   isolation. The file is a browser bundle with no exports and a great deal it
   would want at load time, so the alternative is booting the whole shell to
   ask one arithmetic question. */
function load() {
  const names = [
    "gdHandednessSign",
    "gdBubbleTiltSignedForHandedness",
    "gdDeriveDistanceTendency",
    "calculateVisualBubbleRender"
  ];
  /* Brace-counted rather than line-matched: these three are written in three
     different styles (one-liner, multi-line, nested arrow bodies) and any
     line-based rule gets one of them wrong. */
  const sources = names.map(name => {
    const start = src.indexOf("function " + name + "(");
    assert.notStrictEqual(start, -1, "could not find " + name + " in gd-app-core.js");
    const open = src.indexOf("{", src.indexOf(")", start));
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    throw new Error("unbalanced braces reading " + name);
  });
  const shims = `
    function gdRound(v, d) { var f = Math.pow(10, d || 0); return Math.round(v * f) / f; }
    function gdClamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
    function gdGetClubGroup(club) { return /driver/i.test(club) ? "driver" : /pw|gw|sw|lw|wedge/i.test(club) ? "wedge" : "iron"; }
  `;
  // eslint-disable-next-line no-new-func
  return new Function(shims + sources.join("\n") + "\nreturn {" + names.join(",") + "};")();
}

const api = load();

test("the sign IS the convention: right is +1, left is -1", () => {
  assert.strictEqual(api.gdHandednessSign("right"), 1);
  assert.strictEqual(api.gdHandednessSign("left"), -1);
});

test("anything that is not 'left' is right-handed", () => {
  /* Right is the default everywhere in the app, and an unset or malformed
     handedness must land there rather than producing a third behaviour. */
  [undefined, null, "", "RIGHT", "righty", "unknown", 0].forEach(value => {
    assert.strictEqual(api.gdHandednessSign(value), 1, "unexpected sign for " + JSON.stringify(value));
  });
  assert.strictEqual(api.gdHandednessSign("left"), -1, "only the exact string 'left' is left-handed");
});

test("RH -> near end one side, far end the other (positive tilt)", () => {
  const tilt = api.gdBubbleTiltSignedForHandedness(10, "right");
  assert.strictEqual(tilt, 10, "a right-handed bubble tilts positive");
  assert.ok(tilt > 0);
});

test("LH -> the mirror of RH, same magnitude", () => {
  const tilt = api.gdBubbleTiltSignedForHandedness(10, "left");
  assert.strictEqual(tilt, -10, "a left-handed bubble tilts negative");
});

test("the two are exact mirrors - never merely 'different'", () => {
  /* The property that matters. A left-handed bubble that tilted by a different
     AMOUNT would be a bug hiding behind a correct-looking sign. */
  [0, 3.5, 7, 10, 12, 14, 21.75].forEach(magnitude => {
    const rh = api.gdBubbleTiltSignedForHandedness(magnitude, "right");
    const lh = api.gdBubbleTiltSignedForHandedness(magnitude, "left");
    assert.strictEqual(rh, -lh, "RH and LH must be exact mirrors at " + magnitude + " degrees");
    assert.strictEqual(Math.abs(rh), Math.abs(lh), "and equal in magnitude");
  });
});

test("magnitude is taken as a magnitude - a negative input cannot flip a hand", () => {
  /* Callers pass a size from a lookup table. If one ever arrives negative it
     must not silently turn a right-handed player left-handed. */
  assert.strictEqual(api.gdBubbleTiltSignedForHandedness(-10, "right"), 10);
  assert.strictEqual(api.gdBubbleTiltSignedForHandedness(-10, "left"), -10);
});

test("a zero-magnitude bubble has no side at all", () => {
  /* Compared with ===, not strictEqual: 0 * -1 is -0, which is a different
     VALUE but the same ANGLE, and every consumer rotates by it. Asserting the
     sign of zero would be pinning an artefact of the arithmetic rather than
     anything about handedness. */
  assert.ok(api.gdBubbleTiltSignedForHandedness(0, "right") === 0, "a flat bubble is flat for a right-hander");
  assert.ok(api.gdBubbleTiltSignedForHandedness(0, "left") === 0, "and flat for a left-hander too");
});

test("distance tendency mirrors on the same sign, so shape and tendency agree", () => {
  /* Handedness enters the model in two places, and they have to use the same
     sign or a left-handed player gets a bubble tilted one way with its long/short
     bias leaning the other. */
  const rh = api.gdDeriveDistanceTendency({ faceDeltaFromPatternDeg: 2, handedness: "right", club: "7i" });
  const lh = api.gdDeriveDistanceTendency({ faceDeltaFromPatternDeg: 2, handedness: "left", club: "7i" });
  assert.strictEqual(rh, -lh, "the two handedness paths must share one sign convention");
});

test("the VISUAL tilt mirrors too - it is the one that reaches the screen", () => {
  /* gdBubbleLocalToLatLng prefers visual.visualTiltDeg over clusterTiltDeg, so
     a clean mirror in the derivation is worth nothing if the visual layer above
     it breaks the symmetry. It did: visualTiltDeg added `windowNorm * 1.2`,
     and windowNorm is faceWindowDeg/1.5 - an unsigned MAGNITUDE - so the same
     +0.56 degrees went onto both hands and a right-hander leaned 1.12 degrees
     further from square than a left-hander on every club. */
  const profile = { clusterTiltDeg: 5.13, clusterWidthM: 23, clusterDepthM: 30, faceAlignmentOffsetDeg: 1.4, faceWindowDeg: 0.7, carryWindowPct: 4.2 };
  const rh = api.calculateVisualBubbleRender(profile, { handedness: "right" });
  const lh = api.calculateVisualBubbleRender(Object.assign({}, profile, { clusterTiltDeg: -5.13 }), { handedness: "left" });
  assert.ok(rh.visualTiltDeg === -lh.visualTiltDeg,
    "visual tilt must mirror: RH " + rh.visualTiltDeg + " vs LH " + lh.visualTiltDeg);
  assert.ok(rh.visualSkewDeg === -lh.visualSkewDeg, "and so must the skew");
  assert.ok(rh.visualYBias === -lh.visualYBias, "and the y bias");
});

test("size does not depend on which hand you swing with", () => {
  /* Only the LEAN is handed. A left-hander's bubble must be the same size as a
     right-hander's - an asymmetry in the width or depth would be a different
     player model, not a mirror. */
  const profile = { clusterTiltDeg: 5.13, clusterWidthM: 23, clusterDepthM: 30, faceAlignmentOffsetDeg: 1.4, faceWindowDeg: 0.7, carryWindowPct: 4.2 };
  const rh = api.calculateVisualBubbleRender(profile, { handedness: "right" });
  const lh = api.calculateVisualBubbleRender(Object.assign({}, profile, { clusterTiltDeg: -5.13 }), { handedness: "left" });
  assert.strictEqual(rh.visualWidthM, lh.visualWidthM, "width must not depend on handedness");
  assert.strictEqual(rh.visualDepthM, lh.visualDepthM, "nor depth");
});

test("no unsigned term is added to a signed one", () => {
  /* The rule the 1.12 degree bug broke, checked on the source rather than on a
     sample: every term summed into visualTiltDeg must carry a sign. windowNorm
     and carryNorm are magnitudes and must be multiplied by `hand` before they
     can join a tilt. */
  const body = src.slice(src.indexOf("function calculateVisualBubbleRender("));
  const tilt = body.slice(body.indexOf("visualTiltDeg:"), body.indexOf("visualSkewDeg:"));
  assert.ok(!/\+\s*windowNorm\s*\*/.test(tilt),
    "windowNorm joins the tilt unsigned - that is the 1.12 degree asymmetry: " + tilt);
  assert.ok(/hand\s*\*\s*windowNorm/.test(tilt),
    "windowNorm must be signed by hand before it can lean a bubble: " + tilt);
});

test("the convention lives in ONE place", () => {
  /* Every handedness-dependent sign in the shared core must come from
     gdHandednessSign. A literal `handedness==="left"?-1:1` written inline
     somewhere else is a second copy of the rule, and second copies drift -
     which is how a view ends up mirrored against the others. */
  const inlineSigns = src.match(/handedness\s*===\s*["']left["']\s*\?\s*-1\s*:\s*1/g) || [];
  assert.strictEqual(inlineSigns.length, 1,
    "expected exactly one inline left/right sign (the body of gdHandednessSign), found " + inlineSigns.length);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("bubble-handedness failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("bubble-handedness passed: " + tests.length + " checks");
})();
