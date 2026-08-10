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

/* ---------- 2. the aim moves the GPS bubble, unclamped ---------- */
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
const tgt = { lat: -36.9165, lng: 174.7411 };   // due south, so the player's right is west
engine.setBag([{ club: "7i", baseCarry: 155, totalM: 165 }]);
engine.setHoleContext({ hole: 1, tee, green: tgt, route: [tee, tgt] });

function aimMetres(bubble) {
  engine.setBubble(bubble);
  engine.setShot(tee, tgt);
  const centre = engine.renderModel().center;
  const east = (centre.lng - tgt.lng) * 111320 * Math.cos(tee.lat * Math.PI / 180);
  return -east;   // west is the player's right on a southward shot
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) < tol, msg + " (got " + a.toFixed(2) + ", wanted " + b.toFixed(2) + ")");

near(aimMetres({ offsetDeg: 0 }), 0, .2, "0.0 aims at the target");
near(aimMetres({ offsetDeg: 2 }), Math.tan(2 * Math.PI / 180) * 155, .3, "2R aims tan(2)x155 right");
near(aimMetres({ offsetDeg: -2 }), -Math.tan(2 * Math.PI / 180) * 155, .3, "2L mirrors it");
/* The clamp that used to bite: 0.78 x lateralRadius was about 9m here. */
near(aimMetres({ offsetDeg: 6 }), Math.tan(6 * Math.PI / 180) * 155, .5, "6R is not truncated by the bubble's own size");
near(aimMetres(null), Math.tan(1.4 * Math.PI / 180) * 155, .3, "clearing the bubble falls back to the engine placeholder");

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

console.log("my-bubble aim passed: saved aim reaches GPS, unclamped to 6 deg, landscape labels agree with the data ("
  + labels.length + " gridlines)");
