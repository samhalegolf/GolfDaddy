/* The Bubble's frame, pinned.
 *
 * The bug this replaces: two surfaces took their tilt from the SAME function
 * and applied it to perpendicular reference axes. GPS Play measured tilt off
 * the target line; the graphs rotated an SVG ellipse from the screen x axis,
 * which is the lateral one. Both were internally consistent, so neither looked
 * wrong on its own screen, and the orientation appeared to flip at random
 * whenever a value moved between them.
 *
 * The defence against that coming back is not "be careful" - it is that there
 * is now one definition and these assertions describe it in terms a person can
 * check against a screen:
 *
 *   0 degrees is straight down the origin -> target line
 *   90 degrees is square right of it
 *   clockwise is positive
 *   the LONG axis is across (a shot pattern is wider than it is deep)
 *   an untilted bubble therefore lies square across the line, at 90
 */
const assert = require("assert");
const path = require("path");

const F = require(path.join(__dirname, "..", "scripts", "gd-bubble-frame-core.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function near(a, b, tol, msg) {
  assert.ok(Math.abs(a - b) <= (tol || 1e-9), (msg || "") + " expected ~" + b + ", got " + a);
}

test("the four cardinals are what the names say", () => {
  assert.strictEqual(F.LONG_DEG, 0, "0 is straight down the target line");
  assert.strictEqual(F.RIGHT_DEG, 90, "90 is square right");
  assert.strictEqual(F.SHORT_DEG, 180, "180 is straight back toward the origin");
  assert.strictEqual(F.LEFT_DEG, 270, "270 is square left");
});

test("clockwise is positive, and the frame wraps at 360", () => {
  assert.strictEqual(F.normaliseDeg(0), 0);
  assert.strictEqual(F.normaliseDeg(-90), 270, "a quarter turn anticlockwise is 270, not -90");
  assert.strictEqual(F.normaliseDeg(450), 90);
  assert.strictEqual(F.normaliseDeg(-450), 270);
});

test("an axis is a line, not a direction", () => {
  /* The thing that made the handedness mirror look broken: 173 and -7 describe
     the same axis, and comparing them raw says they are 180 apart. */
  assert.strictEqual(F.foldAxisDeg(173), -7);
  assert.strictEqual(F.foldAxisDeg(-7), -7);
  assert.strictEqual(F.foldAxisDeg(90), 90);
  assert.strictEqual(F.foldAxisDeg(270), 90, "270 and 90 are the same axis");
});

test("the frame says nothing about size or proportion", () => {
  /* Deliberately absent. The shapes are generated elsewhere and produced
     consistently; this file settles which way the object is laid down, not how
     big it is or what proportions it has. Anything that starts sizing bubbles
     from here has misunderstood what it is for - and GPS Play's scaling in
     particular is its own and stays that way. */
  ["shapeCheck", "conformShape", "MIN_ACROSS_OVER_ALONG", "MAX_ACROSS_OVER_ALONG"].forEach(name => {
    assert.strictEqual(F[name], undefined, name + " must not exist: the frame does not own shape");
  });
});

test("an untilted bubble lies square ACROSS the target line", () => {
  /* The single most checkable claim in the file: look at the screen, the long
     axis should be perpendicular to the shot. */
  const el = F.ellipse({ alongM: 10, acrossM: 14, tiltDeg: 0 });
  assert.strictEqual(F.majorAxisDeg(el), 90);
  assert.strictEqual(F.tiltFromSquareDeg(el), 0);
});

test("tilt moves the long axis off square, clockwise positive", () => {
  const el = F.ellipse({ alongM: 10, acrossM: 14, tiltDeg: 8 });
  assert.strictEqual(F.tiltFromSquareDeg(el), 8);
  const mirrored = F.ellipse({ alongM: 10, acrossM: 14, tiltDeg: -8 });
  assert.strictEqual(F.tiltFromSquareDeg(mirrored), -8);
});

test("RH and LH are exact mirrors about the target line", () => {
  [0, 3, 7, 10, 14].forEach(magnitude => {
    const rh = F.tiltFromSquareDeg(F.ellipse({ alongM: 10, acrossM: 14, tiltDeg: magnitude }));
    const lh = F.tiltFromSquareDeg(F.ellipse({ alongM: 10, acrossM: 14, tiltDeg: -magnitude }));
    /* === not strictEqual: at zero the two are 0 and -0, a different VALUE but
       the same ANGLE, and pinning the sign of zero would assert an artefact of
       the arithmetic rather than anything about handedness. */
    assert.ok(rh === -lh, "mirror broken at " + magnitude + " degrees: " + rh + " vs " + lh);
    assert.ok(Math.abs(rh) === Math.abs(lh), "and the magnitudes must match at " + magnitude);
  });
});

test("the ring starts down the line and turns clockwise", () => {
  const el = F.ellipse({ alongM: 10, acrossM: 14, tiltDeg: 0 });
  near(F.bearingOf(F.ringPoint(el, 0)), 0, 1e-9, "parameter 0 is straight down the line:");
  near(F.bearingOf(F.ringPoint(el, 90)), 90, 1e-9, "parameter 90 is square right:");
  near(F.bearingOf(F.ringPoint(el, 180)), 180, 1e-9, "parameter 180 is straight back:");
  near(F.bearingOf(F.ringPoint(el, 270)), 270, 1e-9, "parameter 270 is square left:");
});

test("the widest point of an untilted ring really is square across", () => {
  /* Measured off the built ring rather than read off tiltDeg, so this catches a
     shape that claims one orientation and draws another. */
  const el = F.ellipse({ alongM: 10, acrossM: 14, tiltDeg: 0 });
  let widest = null;
  F.ring(el, 720).forEach(point => {
    const r = Math.hypot(point.alongM, point.acrossM);
    if (!widest || r > widest.r) widest = { r, deg: F.bearingOf(point) };
  });
  assert.strictEqual(F.foldAxisDeg(widest.deg), 90, "the long axis of the drawn ring is across the line");
  near(widest.r, 14, 1e-6, "and it is the across radius:");
});

test("a tilted ring's widest point matches the declared tilt", () => {
  const el = F.ellipse({ alongM: 10, acrossM: 14, tiltDeg: 12 });
  let widest = null;
  F.ring(el, 3600).forEach(point => {
    const r = Math.hypot(point.alongM, point.acrossM);
    if (!widest || r > widest.r) widest = { r, deg: F.bearingOf(point) };
  });
  near(F.foldAxisDeg(widest.deg), F.foldAxisDeg(102), 0.2,
    "declared tilt and drawn tilt must agree:");
});

test("map conversion: frame 0 IS the shot bearing", () => {
  assert.strictEqual(F.toBearing(0, 137), 137, "straight down the line is the shot bearing itself");
  assert.strictEqual(F.toBearing(90, 137), 227, "square right is a quarter turn clockwise");
  assert.strictEqual(F.toBearing(270, 137), 47);
  assert.strictEqual(F.toBearing(0, 350), 350);
  assert.strictEqual(F.toBearing(90, 350), 80, "and it wraps");
});

test("map conversion round-trips", () => {
  [0, 45, 90, 180, 270, 359].forEach(frame => {
    [0, 137, 350].forEach(shot => {
      assert.strictEqual(F.toFrameDeg(F.toBearing(frame, shot), shot), frame,
        "round trip failed at frame " + frame + " shot " + shot);
    });
  });
});

test("map polar carries both the direction and the distance", () => {
  const point = { alongM: 0, acrossM: 14 };
  const polar = F.toMapPolar(point, 100);
  assert.strictEqual(polar.bearingDeg, 190, "square right of a bearing of 100");
  near(polar.distanceM, 14, 1e-9);
});

test("screen conversion puts LONG up the page", () => {
  /* Screen y grows downwards, so long must come out with a smaller y. This one
     minus sign is what the old yAxisDown boolean asked every caller to
     remember, and it is not a parameter any more. */
  const opts = { cx: 100, cy: 100, pxPerM: 2 };
  const long = F.toScreen({ alongM: 10, acrossM: 0 }, opts);
  assert.strictEqual(long.x, 100, "straight long does not move sideways");
  assert.strictEqual(long.y, 80, "and sits ABOVE the centre");
  const right = F.toScreen({ alongM: 0, acrossM: 10 }, opts);
  assert.strictEqual(right.x, 120, "square right is to the right of the centre");
  assert.strictEqual(right.y, 100);
  const short = F.toScreen({ alongM: -10, acrossM: 0 }, opts);
  assert.strictEqual(short.y, 120, "short sits BELOW the centre");
});

test("screen conversion round-trips", () => {
  const opts = { cx: 160, cy: 140, pxPerM: 3.5 };
  [{ alongM: 7, acrossM: -4 }, { alongM: -12, acrossM: 9 }, { alongM: 0, acrossM: 0 }].forEach(point => {
    const back = F.fromScreen(F.toScreen(point, opts), opts);
    near(back.alongM, point.alongM, 1e-9, "along:");
    near(back.acrossM, point.acrossM, 1e-9, "across:");
  });
});

test("SVG rotation is the SAME sign as the frame tilt", () => {
  /* Not the intuitive answer. toScreen maps (along, across) -> (across, -along),
     a matrix with determinant +1 - a pure rotation, so the sense of rotation
     survives and the y-flip does NOT invert the tilt. The end-to-end test below
     is what proves it; this pins the result. */
  assert.strictEqual(F.toSvgRotateDeg(F.ellipse({ alongM: 10, acrossM: 14, tiltDeg: 12 })), 12);
  assert.strictEqual(F.toSvgRotateDeg(F.ellipse({ alongM: 10, acrossM: 14, tiltDeg: -12 })), -12);
});

test("a drawn SVG ellipse agrees with the frame it came from", () => {
  /* The end-to-end check the two surfaces never had: take a frame point,
     convert it to screen, and confirm it lands where rotating the SVG ellipse
     by toSvgRotateDeg would put it. If these two ever disagree, the picture and
     the maths have separated again. */
  const el = F.ellipse({ alongM: 10, acrossM: 14, tiltDeg: 12 });
  const opts = { cx: 0, cy: 0, pxPerM: 1 };
  const svgRotate = (F.toSvgRotateDeg(el) * Math.PI) / 180;
  for (let t = 0; t < 360; t += 15) {
    const screen = F.toScreen(F.ringPoint(el, t), opts);
    /* The same point built the SVG way: unrotated ellipse with rx=across,
       ry=along on a y-down canvas, then rotated by the SVG angle. */
    const ux = Math.sin((t * Math.PI) / 180) * el.acrossM;
    const uy = -Math.cos((t * Math.PI) / 180) * el.alongM;
    const rx = ux * Math.cos(svgRotate) - uy * Math.sin(svgRotate);
    const ry = ux * Math.sin(svgRotate) + uy * Math.cos(svgRotate);
    near(screen.x, rx, 1e-6, "svg x at t=" + t + ":");
    near(screen.y, ry, 1e-6, "svg y at t=" + t + ":");
  }
});

test("regions sit on the same 360 the engine names them on", () => {
  assert.strictEqual(F.regionAngleDeg("long"), 0);
  assert.strictEqual(F.regionAngleDeg("right"), 90);
  assert.strictEqual(F.regionAngleDeg("short"), 180);
  assert.strictEqual(F.regionAngleDeg("left"), 270);
  assert.strictEqual(F.regionAt(0), "long");
  assert.strictEqual(F.regionAt(91), "right");
  assert.strictEqual(F.regionAt(359), "long", "and wraps back round");
  assert.strictEqual(F.regionAt(225), "shortLeft");
});

test("containment: on the boundary is 1.0, in both axes", () => {
  const el = F.ellipse({ alongM: 10, acrossM: 14, tiltDeg: 0 });
  near(F.normalisedRadius({ alongM: 10, acrossM: 0 }, el), 1, 1e-9, "long boundary:");
  near(F.normalisedRadius({ alongM: 0, acrossM: 14 }, el), 1, 1e-9, "across boundary:");
  near(F.normalisedRadius({ alongM: 5, acrossM: 0 }, el), 0.5, 1e-9, "half way out:");
});

test("containment respects the tilt", () => {
  const el = F.ellipse({ alongM: 10, acrossM: 20, tiltDeg: 90 });
  /* Tilted a quarter turn, the long axis now lies down the LINE, so a point 20m
     long is exactly on the boundary and one 20m right is well outside. */
  near(F.normalisedRadius({ alongM: 20, acrossM: 0 }, el), 1, 1e-9, "long, after a quarter turn:");
  assert.ok(F.normalisedRadius({ alongM: 0, acrossM: 20 }, el) > 1.9, "and across is now outside");
});

test("the picture and the score cannot disagree", () => {
  /* Every point ON the ring must read as exactly contained. This is the
     property that used to be re-implemented per surface. */
  const el = F.ellipse({ alongM: 9, acrossM: 13, tiltDeg: 7 });
  F.ring(el, 360).forEach(point => {
    near(F.normalisedRadius(point, el), 1, 1e-9, "ring point not on its own boundary:");
    assert.strictEqual(F.contains(point, el, 100), true);
  });
});

test("unusable radii give null, never a repaired guess", () => {
  assert.strictEqual(F.ellipse({ alongM: 0, acrossM: 14 }), null);
  assert.strictEqual(F.ellipse({ alongM: 10, acrossM: -1 }), null);
  assert.strictEqual(F.ellipse(null), null);
  assert.strictEqual(F.majorAxisDeg(null), null, "and nothing downstream invents a shape from it");
});

test("a deeper-than-wide ellipse still orients correctly", () => {
  /* The frame must not assume a proportion. Handed an object whose long axis is
     the along one, majorAxisDeg answers 0 rather than insisting on 90 - it
     reports which way the object actually lies, it does not correct it. */
  const deep = F.ellipse({ alongM: 14, acrossM: 10, tiltDeg: 0 });
  assert.strictEqual(F.majorAxisDeg(deep), 0, "long down the line, and said so plainly");
  const tilted = F.ellipse({ alongM: 14, acrossM: 10, tiltDeg: 8 });
  assert.strictEqual(F.majorAxisDeg(tilted), 8);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("bubble-frame-core failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("bubble-frame-core passed: " + tests.length + " checks");
})();
