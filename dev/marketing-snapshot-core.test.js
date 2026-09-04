/* scripts/gd-marketing-snapshot-core.js — the hole choosing the Studio page and the Playwright
   runner both depend on. Two callers reaching the same answer is the whole reason it is pure,
   so what is pinned here is the RULES, not the weights: a weight can be retuned, but a par 3
   winning the tee-shot frame, or a signature hole losing to a bunker count, is a bug.

   node dev/marketing-snapshot-core.test.js */
"use strict";

const assert = require("node:assert");
const core = require("../scripts/gd-marketing-snapshot-core.js");

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}

/* ---- fixture helpers ------------------------------------------------------ */

/* A hole laid out west-to-east so metres and degrees stay easy to reason about at this
   latitude. `offsetM` moves a point north(+)/east(+) from the tee. */
const BASE = { lat: -36.78, lng: 174.75 };
const M_PER_DEG_LAT = 111320;
function at(northM, eastM) {
  return {
    lat: BASE.lat + northM / M_PER_DEG_LAT,
    lng: BASE.lng + eastM / (M_PER_DEG_LAT * Math.cos(BASE.lat * Math.PI / 180))
  };
}

function ring(centre, radiusM) {
  return [0, 90, 180, 270].map((deg) => core.destination(centre, deg * Math.PI / 180, radiusM));
}

function hole(opts) {
  const green = opts.green || at(0, opts.lengthM || 380);
  return {
    holeNumber: opts.holeNumber,
    par: opts.par,
    geometry: {
      tee: opts.tee || at(0, 0),
      green,
      greenShape: opts.greenShape || [],
      route: opts.route || [],
      surfaces: opts.surfaces || null
    }
  };
}

function surfaces(opts) {
  const make = (points, radius) => (points || []).map((p) => ({ shape: ring(p, radius || 12), centre: p }));
  return {
    fairways: make(opts.fairways, 40),
    bunkers: make(opts.bunkers, 10),
    water: make(opts.water, 25)
  };
}

/* ---- eligibility ---------------------------------------------------------- */

test("the tee-shot frame never lands on a par 3, however photogenic it is", () => {
  const pkg = {
    holes: [
      hole({
        holeNumber: 7, par: 3, lengthM: 150,
        /* Deliberately the busiest hole on the course. */
        surfaces: surfaces({ bunkers: [at(20, 120), at(-20, 130), at(15, 145)], water: [at(-30, 90)], fairways: [at(0, 80)] })
      }),
      hole({ holeNumber: 8, par: 4, lengthM: 360, surfaces: surfaces({ fairways: [at(0, 180)] }) })
    ]
  };
  const picked = core.pickHoles(pkg);
  assert.strictEqual(picked.teeHole, 8, "picked the par 3 for the tee shot");
});

test("with no par anywhere, length stands in for it", () => {
  const pkg = {
    holes: [
      hole({ holeNumber: 1, par: null, lengthM: 140, surfaces: surfaces({ bunkers: [at(10, 120)], water: [at(-10, 110)] }) }),
      hole({ holeNumber: 2, par: null, lengthM: 400, surfaces: surfaces({ fairways: [at(0, 200)] }) })
    ]
  };
  const picked = core.pickHoles(pkg);
  assert.strictEqual(picked.teeHole, 2, "a 140m hole was treated as tee-shot material");
});

/* ---- terrain variance ----------------------------------------------------- */

test("a corridor with three kinds of terrain beats one with many of a single kind", () => {
  const many = core.scoreHole(core.holeRecords({ holes: [hole({
    holeNumber: 1, par: 4, lengthM: 380,
    surfaces: surfaces({ bunkers: [at(10, 100), at(-10, 140), at(12, 180), at(-8, 220), at(6, 260)] })
  })] })[0]);
  const varied = core.scoreHole(core.holeRecords({ holes: [hole({
    holeNumber: 2, par: 4, lengthM: 380,
    surfaces: surfaces({ bunkers: [at(10, 150)], water: [at(-20, 200)], fairways: [at(0, 190)] })
  })] })[0]);
  assert.ok(varied.teeShot > many.teeShot,
    `five bunkers (${many.teeShot}) outscored bunker+water+fairway (${varied.teeShot})`);
});

test("surfaces far off the corridor do not count toward the tee shot", () => {
  const near = core.scoreHole(core.holeRecords({ holes: [hole({
    holeNumber: 1, par: 4, lengthM: 380, surfaces: surfaces({ bunkers: [at(30, 200)] })
  })] })[0]);
  const far = core.scoreHole(core.holeRecords({ holes: [hole({
    holeNumber: 1, par: 4, lengthM: 380, surfaces: surfaces({ bunkers: [at(400, 200)] })
  })] })[0]);
  assert.strictEqual(near.counts.corridorBunkers, 1);
  assert.strictEqual(far.counts.corridorBunkers, 0, "a bunker 400m off the hole was counted");
});

test("the approach score reads the green surrounds, not the corridor", () => {
  const teeSideOnly = core.scoreHole(core.holeRecords({ holes: [hole({
    holeNumber: 1, par: 4, lengthM: 380, surfaces: surfaces({ bunkers: [at(0, 120), at(10, 150)] })
  })] })[0]);
  const greenside = core.scoreHole(core.holeRecords({ holes: [hole({
    holeNumber: 1, par: 4, lengthM: 380, surfaces: surfaces({ bunkers: [at(20, 370), at(-20, 375)] })
  })] })[0]);
  assert.ok(greenside.approach > teeSideOnly.approach,
    "greenside bunkers did not beat fairway bunkers on the approach score");
  assert.strictEqual(teeSideOnly.counts.greenBunkers, 0);
});

test("a dogleg registers and a straight hole does not", () => {
  const straight = core.scoreHole(core.holeRecords({ holes: [hole({ holeNumber: 1, par: 4, lengthM: 380 })] })[0]);
  const bent = core.scoreHole(core.holeRecords({ holes: [hole({
    holeNumber: 1, par: 4, lengthM: 380, route: [at(70, 190)]
  })] })[0]);
  assert.strictEqual(straight.counts.doglegPct, 0);
  assert.ok(bent.counts.doglegPct > 10, `a 70m bend read as ${bent.counts.doglegPct}%`);
});

/* ---- the two frames are different holes ----------------------------------- */

test("the approach hole is never the tee-shot hole when a second hole exists", () => {
  const busiest = hole({
    holeNumber: 3, par: 5, lengthM: 480,
    route: [at(60, 240)],
    surfaces: surfaces({ bunkers: [at(20, 200), at(30, 460)], water: [at(-25, 300)], fairways: [at(0, 220)] })
  });
  const pkg = { holes: [busiest, hole({ holeNumber: 4, par: 4, lengthM: 340, surfaces: surfaces({ bunkers: [at(15, 335)] }) })] };
  const picked = core.pickHoles(pkg);
  assert.strictEqual(picked.teeHole, 3);
  assert.strictEqual(picked.approachHole, 4, "both frames landed on the same hole");
});

test("a one-hole package says so rather than pretending", () => {
  const picked = core.pickHoles({ holes: [hole({ holeNumber: 1, par: 4, lengthM: 380 })] });
  assert.strictEqual(picked.teeHole, 1);
  assert.strictEqual(picked.approachHole, 1);
  assert.ok(picked.notes.some((n) => /only one hole/i.test(n)), "no note explained the repeat");
});

test("a package with no greens picks nothing and says why", () => {
  const picked = core.pickHoles({ holes: [{ holeNumber: 1, geometry: { tee: at(0, 0) } }] });
  assert.strictEqual(picked.teeHole, null);
  assert.strictEqual(picked.approachHole, null);
  assert.ok(picked.notes.length);
});

/* ---- signature-hole evidence outranks terrain ------------------------------ */

test("a confidently named signature hole beats the busiest hole on the course", () => {
  const pkg = {
    holes: [
      hole({
        holeNumber: 12, par: 5, lengthM: 500, route: [at(80, 250)],
        surfaces: surfaces({ bunkers: [at(20, 200), at(-20, 300), at(25, 400)], water: [at(-30, 350)], fairways: [at(0, 250)] })
      }),
      hole({ holeNumber: 16, par: 4, lengthM: 350 })   // geometrically dull
    ]
  };
  assert.strictEqual(core.pickHoles(pkg).teeHole, 12, "terrain baseline changed");
  const withIntel = core.pickHoles(pkg, { intel: [{ hole: 16, confidence: 0.9, source: "https://example.test" }] });
  assert.strictEqual(withIntel.teeHole, 16, "the named signature hole lost to a bunker count");
  assert.ok(withIntel.notes.some((n) => /signature/i.test(n)), "the note did not say why");
});

test("weak evidence only breaks ties, it does not overturn a clear terrain win", () => {
  const pkg = {
    holes: [
      hole({
        holeNumber: 12, par: 5, lengthM: 500, route: [at(80, 250)],
        surfaces: surfaces({ bunkers: [at(20, 200), at(-20, 300), at(25, 400)], water: [at(-30, 350)], fairways: [at(0, 250)] })
      }),
      hole({ holeNumber: 16, par: 4, lengthM: 350 })
    ]
  };
  const picked = core.pickHoles(pkg, { intel: [{ hole: 16, confidence: 0.08 }] });
  assert.strictEqual(picked.teeHole, 12, "a 0.08-confidence mention overturned the terrain pick");
});

test("intel for a hole that is not in the package is ignored", () => {
  const pkg = { holes: [hole({ holeNumber: 1, par: 4, lengthM: 380 }), hole({ holeNumber: 2, par: 4, lengthM: 360 })] };
  const picked = core.pickHoles(pkg, { intel: [{ hole: 17, confidence: 1 }] });
  assert.ok(picked.teeHole === 1 || picked.teeHole === 2);
});

/* ---- the 130m standing point ---------------------------------------------- */

test("the standing point is the asked-for distance from the green", () => {
  const rec = core.holeRecords({ holes: [hole({ holeNumber: 1, par: 4, lengthM: 380 })] })[0];
  const stand = core.standingPoint(rec, 130);
  const d = core.metresBetween(stand, rec.green);
  assert.ok(Math.abs(d - 130) < 1, `stood ${d.toFixed(1)}m from the green`);
});

test("on a dogleg it comes back along the line the hole plays, not the tee-green line", () => {
  /* The tee sits due west of the green, so the straight tee-green line is the north=0 axis and
     "did the dogleg matter" is just "how far north did the standing point land". */
  const rec = core.holeRecords({ holes: [hole({
    holeNumber: 1, par: 5, lengthM: 480, route: [at(120, 240)]
  })] })[0];
  const stand = core.standingPoint(rec, 130);
  const straight = core.standingPoint(
    core.holeRecords({ holes: [hole({ holeNumber: 1, par: 5, lengthM: 480 })] })[0], 130);
  const offset = core.metresBetween(stand, straight);
  assert.ok(offset > 40, `the dogleg moved the standing point only ${offset.toFixed(1)}m off the straight line`);
  assert.ok(Math.abs(core.metresBetween(stand, rec.green) - 130) < 1, "the dogleg version is no longer 130m out");
});

test("a hole with neither route nor tee has no standing point rather than an invented one", () => {
  const rec = core.holeRecords({ holes: [{ holeNumber: 1, geometry: { green: at(0, 300) } }] })[0];
  assert.strictEqual(core.standingPoint(rec, 130), null);
});

/* ---- units ---------------------------------------------------------------- */

test("yards where golf is sold in yards, metres elsewhere", () => {
  const cases = [
    [{ lat: 33.5, lng: -117.7 }, "yd", "California"],
    [{ lat: 21.3, lng: -157.8 }, "yd", "Hawaii"],
    [{ lat: 56.34, lng: -2.80 }, "yd", "St Andrews"],
    [{ lat: 35.7, lng: 139.7 }, "yd", "Tokyo"],
    [{ lat: 43.7, lng: -79.4 }, "yd", "Toronto"],
    [{ lat: -36.9, lng: 174.7 }, "m", "Auckland"],
    [{ lat: -33.9, lng: 151.2 }, "m", "Sydney"],
    [{ lat: 48.85, lng: 2.35 }, "m", "Paris"]
  ];
  cases.forEach(([point, expected, where]) => {
    const got = core.unitsForPoint(point);
    assert.strictEqual(got.units, expected, `${where} resolved to ${got.units}`);
    assert.ok(got.reason, `${where} gave no reason`);
  });
});

test("no centre is metres with a reason, never a crash", () => {
  const got = core.unitsForPoint(null);
  assert.strictEqual(got.units, "m");
  assert.ok(/metres/i.test(got.reason));
});

/* ---- package shapes -------------------------------------------------------- */

test("both package shapes read the same — lite is flat, full nests under geometry", () => {
  const green = at(0, 380);
  const full = core.holeRecords({ holes: [{ holeNumber: 4, par: 4, geometry: { tee: at(0, 0), green } }] });
  const lite = core.holeRecords({ holes: [{ holeNumber: 4, par: 4, tee: at(0, 0), green }] });
  assert.strictEqual(full.length, 1);
  assert.strictEqual(lite.length, 1);
  assert.strictEqual(full[0].par, lite[0].par);
  assert.ok(Math.abs(core.metresBetween(full[0].green, lite[0].green)) < 0.001);
});

test("holes without a green are dropped, not scored as empty ones", () => {
  const recs = core.holeRecords({ holes: [
    hole({ holeNumber: 1, par: 4, lengthM: 380 }),
    { holeNumber: 2, par: 4, geometry: { tee: at(0, 0) } }
  ] });
  assert.deepStrictEqual(recs.map((r) => r.holeNumber), [1]);
});

if (!process.exitCode) console.log(`marketing-snapshot-core: ${passed} checks passed`);
