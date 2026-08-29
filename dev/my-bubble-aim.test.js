/* My Bubble -> GPS aim, and the landscape chart's sign law.

   Three bugs found in the first end-to-end run, none of which had any test:

   1. app/js/bubble-engine.js's adapter returned { bag } only, so
      gdProfileCentralOffset never found a faceOffsetDeg and every GPS bubble
      aimed at the placeholder 1.4 deg right, whatever had been adopted and
      saved - and for left-handers too.
   2. The landscape frame drew a RIGHT offset ABOVE the centre line, directly
      contradicting its own axis labels (above "L", below "R"). Both the Course
      Data chart and the My Bubble lane at the top of Shot Data were mirrored.
   3. gdBubbleRenderCenter clamped the aim to 0.78 x the bubble's lateral
      radius, silently truncating any offset past roughly 4 deg.

   And the one that survived that fix: the aim was measured at the resolved bag
   row's CARRY rather than at the shot, so the gap between the aim line and the
   bubble stepped with the bag and stopped growing entirely past the longest
   club - 3 deg drew the same metres at 260m, 300m and 350m. It is measured at
   the shot now (gdGpsAimOffsetM), and the payload quotes what it draws.

   Runs headless: no browser, no network. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const eq = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);

/* ---------- 1. the saved bubble reaches the engine ---------- */
const PROFILE_KEY = "gd_player_profiles_v27";   // gd-app-core.js GD_PROFILE_STORE_KEY

function runMyBubble(store) {
  const calls = [];
  const sandbox = {
    console,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem() {}, removeItem() {} },
    document: { hidden: false, addEventListener() {} },
    GDBubbleEngine: { setBubble: (b) => calls.push(b) }
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(read("app/js/my-bubble.js"), sandbox, { filename: "my-bubble.js" });
  return { last: calls[calls.length - 1], api: sandbox.window.ClarityApp.myBubble };
}
const withProfile = (p) => ({ [PROFILE_KEY]: JSON.stringify({ activeId: p.id, profiles: [p] }) });

let r = runMyBubble(withProfile({
  id: "player47", handedness: "right", faceOffsetDeg: 2.3,
  practiceBubbleSource: { active: true, offsetDeg: 2.3 }
}));
eq(r.last, { offsetDeg: 2.3, handedness: "right" }, "the saved aim reaches the engine");

r = runMyBubble(withProfile({
  id: "player47", handedness: "left", faceOffsetDeg: -1.8,
  practiceBubbleSource: { active: true, offsetDeg: -1.8 }
}));
eq(r.last, { offsetDeg: -1.8, handedness: "left" }, "a left-hander keeps their own handedness");

/* Bubble Bible s2: ONLY AN ACTIVE SOURCE COUNTS. A shape left on the profile is
   not a My Bubble, and no bubble means an explicit 0.0 - never the placeholder. */
r = runMyBubble(withProfile({ id: "player47", faceOffsetDeg: 2.3, previewBubbleSet: { club: "7i" } }));
assert.strictEqual(r.api.current(), null, "an inactive source is not a My Bubble");
eq(r.last, { offsetDeg: 0, handedness: "right" }, "no saved bubble -> explicit 0.0, not 1.4 right");

/* Bubble Bible s8: Number(null) is 0 and passes a bare finite check. */
r = runMyBubble(withProfile({
  id: "player47", faceOffsetDeg: null, centralFaceOffsetDeg: null,
  practiceBubbleSource: { active: true }
}));
assert.strictEqual(r.api.current(), null, "a null offset must not become a saved 0.0");

eq(runMyBubble({}).last, { offsetDeg: 0, handedness: "right" }, "an empty store is safe");

/* ---------- 2. the aim moves the GPS bubble, measured at the shot ---------- */
const distanceLib = require(path.join(ROOT, "app/js/distance.js"));
const engineBox = {
  console,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: { body: { classList: { contains: () => false } } },
  L: { latLng: (lat, lng) => ({ lat, lng }), point: (x, y) => ({ x, y, distanceTo(o) { return Math.hypot(o.x - x, o.y - y); } }) }
};
engineBox.window = engineBox;
engineBox.window.ClarityApp = { distance: distanceLib };
vm.createContext(engineBox);
vm.runInContext(read("app/js/bubble-engine.js"), engineBox, { filename: "bubble-engine.js" });
const engine = engineBox.window.GDBubbleEngine;

const tee = { lat: -36.9138, lng: 174.7411 };
const M_PER_DEG_LAT = 111320;
/* Due south, so the player's right is west. */
const southOf = (metres) => ({ lat: tee.lat - metres / M_PER_DEG_LAT, lng: tee.lng });

/* One club, and a short one: the bag must not be what sizes the aim. */
engine.setBag([{ club: "7i", baseCarry: 155, totalM: 165 }]);

function aim(bubble, shotM) {
  const tgt = southOf(shotM);
  engine.setHoleContext({ hole: 1, tee, green: tgt, route: [tee, tgt] });
  engine.setBubble(bubble);
  engine.setShot(tee, tgt);
  const model = engine.renderModel();
  const east = (model.center.lng - tgt.lng) * M_PER_DEG_LAT * Math.cos(tee.lat * Math.PI / 180);
  return {
    drawnM: -east,                       // west is the player's right on a southward shot
    shotM: model.distanceM,              // the engine's own haversine, not the flat one above
    quotedM: model.payload.aimOffsetM,
    carryM: model.payload.baseCarry
  };
}
const idealM = (deg, shotM) => Math.tan((deg * Math.PI) / 180) * shotM;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) < tol, msg + " (got " + a.toFixed(2) + ", wanted " + b.toFixed(2) + ")");

let a = aim({ offsetDeg: 0 }, 155);
near(a.drawnM, 0, .2, "0.0 aims at the target");

a = aim({ offsetDeg: 2 }, 155);
near(a.drawnM, idealM(2, a.shotM), .3, "2R aims tan(2) x the shot right");

a = aim({ offsetDeg: -2 }, 155);
near(a.drawnM, -idealM(2, a.shotM), .3, "2L mirrors it");

/* The clamp that used to bite: 0.78 x lateralRadius was about 9m here. */
a = aim({ offsetDeg: 6 }, 155);
near(a.drawnM, idealM(6, a.shotM), .5, "6R is not truncated by the bubble's own size");

/* The clamp that replaced it: the bag. Every shot below resolves to the same
   and only 155m club, so a carry-based aim drew the same metres at all four. */
[90, 155, 210, 300].forEach((shot) => {
  const r = aim({ offsetDeg: 3 }, shot);
  near(r.drawnM, idealM(3, r.shotM), .35,
    shot + "m: 3R is measured at the shot, not at the " + r.carryM + "m carry");
  near(r.quotedM, r.drawnM, .35, shot + "m: the payload quotes the offset it draws");
});
const near120 = aim({ offsetDeg: 3 }, 120), far300 = aim({ offsetDeg: 3 }, 300);
assert.ok(far300.drawnM > near120.drawnM * 2,
  "the same setting keeps growing past the longest club (120m drew " + near120.drawnM.toFixed(2)
  + "m, 300m drew " + far300.drawnM.toFixed(2) + "m)");

/* The one bound left is geometric sanity: a quarter of the shot, 14.04 deg. */
const wild = aim({ offsetDeg: 30 }, 155);
near(wild.drawnM, wild.shotM * .25, .3, "30R is held at a quarter of the shot");
near(wild.quotedM, wild.drawnM, .3, "and the payload quotes that, not the unbounded tangent");

a = aim(null, 155);
near(a.drawnM, idealM(1.4, a.shotM), .3, "clearing the bubble falls back to the engine placeholder");

/* ---------- 3. the landscape sign law ---------- */
const core = read("scripts/gd-app-core.js");
const audit = read("scripts/gd-route-audit.js");
function grab(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start !== -1, "source not found: " + signature);
  let depth = 0, i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (!depth) break; }
  }
  return src.slice(start, i + 1);
}
const chart = {};
vm.createContext(chart);
vm.runInContext("function gdShotChartClamp(v,a,b){return Math.max(a,Math.min(b,Number(v)||0))}", chart);
vm.runInContext("function gdShotBubbleClamp(v,a,b){return Math.max(a,Math.min(b,v))}", chart);
vm.runInContext(grab(core, "function gdShotChartYForLateral"), chart);
vm.runInContext(grab(core, "function gdShotChartOfflineGridSvg"), chart);
vm.runInContext(grab(audit, "function gdShotBubbleModelEndpoint"), chart);

const plot = { plotTop: 0, plotBottom: 100, plotMidY: 50, plotLeft: 0, plotRight: 300, labelX: 2, lateralMax: 20, lateralStep: 10 };
assert.ok(chart.gdShotChartYForLateral(plot, 10) > plot.plotMidY, "a RIGHT lateral draws below the centre line");
assert.ok(chart.gdShotChartYForLateral(plot, -10) < plot.plotMidY, "a LEFT lateral draws above it");

/* The axis must agree with the data drawn against it. */
const labels = [...chart.gdShotChartOfflineGridSvg(plot).matchAll(/<text x="[\d.]+" y="([\d.]+)"[^>]*>([LR]) \d+m<\/text>/g)]
  .map((m) => ({ y: Number(m[1]), side: m[2] }));
assert.ok(labels.length >= 2, "the grid produced L/R labels");
labels.forEach((label) => {
  const below = label.y > plot.plotMidY;
  assert.strictEqual(label.side, below ? "R" : "L",
    "gridline at y=" + label.y + " is labelled " + label.side + " but sits " + (below ? "below" : "above") + " the line");
});

const frame = { startXModel: 30, zeroXModel: 230, yModel: 60, modelH: 120, modelW: 480 };
assert.ok(chart.gdShotBubbleModelEndpoint(3, frame).y > frame.yModel, "My Bubble lane: a RIGHT offset draws below the line");
assert.ok(chart.gdShotBubbleModelEndpoint(-3, frame).y < frame.yModel, "My Bubble lane: a LEFT offset draws above it");
assert.strictEqual(chart.gdShotBubbleModelEndpoint(0, frame).y, frame.yModel, "0.0 sits on the line");

console.log("my-bubble aim passed: saved aim reaches GPS, measured at the shot rather than the bag carry, "
  + "bounded only at 14 deg, landscape labels agree with the data (" + labels.length + " gridlines)");
