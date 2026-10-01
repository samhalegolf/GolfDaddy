/* Blank-layer demotion in the app shell's basemap: the live-map twin of the scan's
 * all-or-nothing coverage refusal.
 *
 * Why it exists: the live source walk trusts bboxes, and a bbox is a promise the service
 * never made. The ES and FR rectangles overlap along the Pyrenees — Barcelona must resolve
 * Spanish, so Spain is ordered first, and the price is that French border ground (Biarritz)
 * lands on PNOA, which has no pixels there and 404s every tile. Without demotion that is a
 * blank map with a working aerial source sitting one slot below it.
 *
 * These tests run the REAL app/js/basemap.js module with a stub Leaflet, so the policy is
 * exercised as code rather than matched as text: hard-blank demotes and re-picks, one loaded
 * tile vetoes, the dead mark is local to where it happened, and OSM is never watched. */

const assert = require("assert");
const path = require("path");

/* Minimal Leaflet: enough for the module to load and for buildLayer to return something
   whose tile events the test can fire by hand. */
function makeLayer(url, options) {
  return {
    url: url, options: options, handlers: {},
    on: function (evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); return this; },
    fire: function (evt) { (this.handlers[evt] || []).forEach(fn => fn()); },
    addTo: function () { return this; }
  };
}
global.window = {};
global.L = {
  tileLayer: (url, options) => makeLayer(url, options),
  TileLayer: { extend: () => function StubBboxLayer(url, options) { return makeLayer(url, options); } }
};

require(path.join(__dirname, "..", "app", "js", "basemap.js"));
const basemap = global.window.ClarityApp.basemap;

/* Real places, same as map-source-coverage: the invariant is geographic. */
const BIARRITZ_FR = { lat: 43.47, lng: -1.56 };  // French ground inside Spain's rectangle
const MADRID_ES = { lat: 40.42, lng: -3.70 };
const CHANTILLY_FR = { lat: 49.19, lng: 2.48 };

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("the border sliver: Biarritz mounts PNOA by bbox, demotes to geopf when it proves blank", () => {
  basemap.configure({});  // keyless — the European nationals must not need one
  const first = basemap.baseFor(BIARRITZ_FR);
  assert.strictEqual(first.kind, "pnoa", "bbox order picks Spain first — the documented leak");
  let demoted = 0;
  basemap.watch(first, BIARRITZ_FR, () => { demoted++; });
  for (let i = 0; i < 4; i++) first.layer.fire("tileerror");
  assert.strictEqual(demoted, 1, "four errors and zero loads is a proven-blank layer");
  first.layer.fire("tileerror");
  assert.strictEqual(demoted, 1, "and the watch fires once, not per straggler");
  assert.strictEqual(basemap.baseFor(BIARRITZ_FR).kind, "geopf",
    "the re-pick lands on IGN France, which actually has Biarritz");
});

test("the dead mark is local: PNOA over Biarritz says nothing about PNOA over Madrid", () => {
  assert.strictEqual(basemap.baseFor(MADRID_ES).kind, "pnoa");
});

test("one loaded tile vetoes demotion — a mosaic-edge course keeps its half", () => {
  const base = basemap.baseFor(CHANTILLY_FR);
  assert.strictEqual(base.kind, "geopf");
  let demoted = 0;
  basemap.watch(base, CHANTILLY_FR, () => { demoted++; });
  base.layer.fire("tileload");
  for (let i = 0; i < 10; i++) base.layer.fire("tileerror");
  assert.strictEqual(demoted, 0, "errors alone must not demote once anything has drawn");
  assert.strictEqual(basemap.baseFor(CHANTILLY_FR).kind, "geopf", "and the source stays selectable");
});

test("a fully dead walk still ends on something that draws", () => {
  /* Kill geopf at Biarritz too (pnoa already dead there): with no Esri key the next covering
     source is OSM — the guide, not a blank. */
  const geopf = basemap.baseFor(BIARRITZ_FR);
  assert.strictEqual(geopf.kind, "geopf");
  basemap.watch(geopf, BIARRITZ_FR, () => {});
  for (let i = 0; i < 4; i++) geopf.layer.fire("tileerror");
  assert.strictEqual(basemap.baseFor(BIARRITZ_FR).kind, "osm", "keyless: guide, never blank");
  basemap.configure({ esriApiKey: "test-key" });
  assert.strictEqual(basemap.baseFor(BIARRITZ_FR).kind, "esri",
    "with the key, the global paid aerial catches what both nationals dropped");
});

test("OSM is never watched — there is nothing below it to demote to", () => {
  basemap.configure({});
  const osm = basemap.baseFor({ lat: 0, lng: 0 });
  assert.strictEqual(osm.kind, "osm");
  basemap.watch(osm, { lat: 0, lng: 0 }, () => { throw new Error("the fallback must not demote"); });
  assert.deepStrictEqual(Object.keys(osm.layer.handlers), [], "no handlers were attached at all");
  for (let i = 0; i < 10; i++) osm.layer.fire("tileerror");
});

/* Operator source override (Esri vs Mapbox comparison). Uses a fresh centre so the
   dead cells marked above cannot interfere. */
const ST_ANDREWS = { lat: 56.34, lng: -2.80 };
function asOperator(yes) { global.window.ClarityApp.account = { isAdmin: () => yes }; }

test("auto never picks Mapbox, even with a token", () => {
  asOperator(true);
  basemap.setOverride("auto");
  basemap.configure({ esriApiKey: "e", mapboxPublicToken: "pk.test" });
  assert.strictEqual(basemap.baseFor(ST_ANDREWS).kind, "esri");
});

test("the operator can force Mapbox and Esri, and back to auto", () => {
  asOperator(true);
  basemap.configure({ esriApiKey: "e", mapboxPublicToken: "pk.test" });
  let flips = 0;
  basemap.onOverrideChange(() => { flips++; });
  basemap.setOverride("mapbox");
  const mb = basemap.baseFor(ST_ANDREWS);
  assert.strictEqual(mb.kind, "mapbox");
  assert.ok(mb.layer.url.includes("access_token=pk.test"), "the token lands in the tile URL");
  /* Forced beats a regional open source too - the point is a like-for-like comparison. */
  assert.strictEqual(basemap.baseFor(MADRID_ES).kind, "mapbox");
  basemap.setOverride("esri");
  assert.strictEqual(basemap.baseFor(MADRID_ES).kind, "esri");
  basemap.setOverride("auto");
  assert.strictEqual(basemap.baseFor(MADRID_ES).kind, "pnoa");
  assert.strictEqual(flips, 3, "every flip tells the painter");
});

test("the override does nothing for any other account", () => {
  asOperator(true);
  basemap.configure({ esriApiKey: "e", mapboxPublicToken: "pk.test" });
  basemap.setOverride("mapbox");
  asOperator(false);
  assert.strictEqual(basemap.baseFor(ST_ANDREWS).kind, "esri");
  asOperator(true);
  basemap.setOverride("auto");
});

test("a forced source with no key falls back to auto", () => {
  asOperator(true);
  basemap.configure({ esriApiKey: "e" });
  basemap.setOverride("mapbox");
  assert.strictEqual(basemap.baseFor(ST_ANDREWS).kind, "esri");
  basemap.setOverride("auto");
});

test("the retired \"mesh\" override is refused - Clarity 3D Mesh is what auto means now", () => {
  asOperator(true);
  basemap.configure({ esriApiKey: "e", mapboxPublicToken: "pk.test" });
  basemap.setOverride("mesh");
  assert.strictEqual(basemap.override(), "auto");
  assert.deepStrictEqual(basemap.overrides(), ["auto", "esri", "mapbox"]);
  basemap.setOverride("esri");
  asOperator(false);
  assert.strictEqual(basemap.activeOverride(), "auto", "a player never inherits the operator's choice");
  asOperator(true);
  basemap.setOverride("auto");
});

test("tileUrlFor builds the compositor's 256px tiles, Esri y before x, and nothing without a key", () => {
  basemap.configure({ esriApiKey: "e-key", mapboxPublicToken: "pk.test" });
  assert.strictEqual(basemap.tileUrlFor("esri", 18, 258000, 160000),
    "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/18/160000/258000?token=e-key");
  assert.strictEqual(basemap.tileUrlFor("mapbox", 18, 258000, 160000),
    "https://api.mapbox.com/v4/mapbox.satellite/18/258000/160000.jpg90?access_token=pk.test");
  basemap.configure({ esriApiKey: "e-key" });
  assert.strictEqual(basemap.tileUrlFor("mapbox", 18, 1, 2), null);
  assert.strictEqual(basemap.tileUrlFor("nope", 18, 1, 2), null);
});

(function run() {
  let failures = 0;
  for (const item of tests) {
    try {
      item.fn();
      console.log("  ok  " + item.name);
    } catch (error) {
      failures += 1;
      console.error("  FAIL  " + item.name + "\n        " + (error && error.message || error));
    }
  }
  if (failures) {
    console.error("app-basemap-fallback FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("app-basemap-fallback passed: " + tests.length + " checks");
})();
