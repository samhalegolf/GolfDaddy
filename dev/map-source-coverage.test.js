/* Live map source selection: which layer a course actually plays over.
 *
 * This list is display-only - it never feeds a stored frame, which is the separate question
 * functions/lib/gd-imagery-sources.mjs answers. But "display only" is not "does not matter":
 * it is what every course sees while it has no baked frames, which today is every course
 * outside New Zealand and the United States.
 *
 * The bug this suite exists for: readiness asked only whether a source had its API KEY, never
 * whether it had PIXELS for the course. So configuring the LINZ key made LINZ selectable
 * everywhere on Earth, and a Queensland course mounted a New Zealand layer and drew nothing.
 * An empty map reads to a player exactly like a broken one.
 *
 * These assertions run the real table and the real predicate rather than matching source text,
 * because the invariant is geographic, not textual - a rename must be free and a wrong bbox
 * must not be. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const core = fs.readFileSync(path.join(root, "scripts", "gd-app-core.js"), "utf8");

/* Lift the table and the predicate out of a 14k-line browser file and run them. Extraction is
   deliberately anchored on declarations rather than on bodies, so the tests exercise whatever
   the file currently says. */
function extract(startMarker, endMarker, label) {
  const start = core.indexOf(startMarker);
  assert(start >= 0, `${label}: could not find ${startMarker}`);
  const end = core.indexOf(endMarker, start);
  assert(end > start, `${label}: could not find its end (${endMarker})`);
  return core.slice(start, end + endMarker.length);
}

const tableSrc = extract("const mapSources=[", "\n];", "mapSources table");
const coversSrc = extract("function mapSourceCovers(", "\n}", "mapSourceCovers");

const sandbox = {};
new Function(`${tableSrc}\n${coversSrc}\nthis.mapSources=mapSources;this.mapSourceCovers=mapSourceCovers;`).call(sandbox);
const { mapSources, mapSourceCovers } = sandbox;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* Real places, so the bbox tests are about golf rather than about numbers. */
const AUCKLAND_NZ = { lat: -36.78, lng: 174.76 };
const GOLD_COAST_AU = { lat: -28.01, lng: 153.41 };
const PEBBLE_US = { lat: 36.57, lng: -121.95 };
const ST_ANDREWS_UK = { lat: 56.34, lng: -2.80 };
const CHANTILLY_FR = { lat: 49.19, lng: 2.48 };
const AMSTERDAM_NL = { lat: 52.35, lng: 4.90 };
const BARCELONA_ES = { lat: 41.38, lng: 2.09 };   // inside FR's box too — ES order wins
const BIARRITZ_FR = { lat: 43.47, lng: -1.56 };   // the documented leak: inside ES's box
const NEUTRAL_BOOT = { lat: 0, lng: 0 };

function source(key) {
  const found = mapSources.find(s => s.key === key);
  assert(found, `the ${key} source must exist`);
  return found;
}

test("the source that broke it: LINZ does not cover Queensland", () => {
  assert.strictEqual(mapSourceCovers(source("linz"), GOLD_COAST_AU), false,
    "a configured key made this true everywhere, and a Gold Coast course drew an empty map");
  assert.strictEqual(mapSourceCovers(source("linz"), PEBBLE_US), false);
  assert.strictEqual(mapSourceCovers(source("linz"), ST_ANDREWS_UK), false);
  assert.strictEqual(mapSourceCovers(source("linz"), AUCKLAND_NZ), true, "and still covers New Zealand");
});

test("Queensland covers Queensland and nowhere else", () => {
  assert.strictEqual(mapSourceCovers(source("qld"), GOLD_COAST_AU), true);
  assert.strictEqual(mapSourceCovers(source("qld"), AUCKLAND_NZ), false);
  assert.strictEqual(mapSourceCovers(source("qld"), PEBBLE_US), false);
});

test("the global fallback is global, and is last", () => {
  const osm = source("osm");
  assert.ok(!osm.bbox, "a bbox on the fallback would leave some course with no map at all");
  [AUCKLAND_NZ, GOLD_COAST_AU, PEBBLE_US, ST_ANDREWS_UK, NEUTRAL_BOOT].forEach(place => {
    assert.strictEqual(mapSourceCovers(osm, place), true, "OSM must cover " + JSON.stringify(place));
  });
  assert.strictEqual(mapSources[mapSources.length - 1].key, "osm",
    "list order is preference order - the line guide is what you settle for, not what you reach for");
});

/* The selection walk in setMapSource steps through the list in order and takes the first
   ready-and-covering source. Modelled here so the OUTCOME is asserted, not the loop. */
/* `keys` names which requiresKey values have arrived, because there are now two keyed sources
   and "has a key" stopped being one question the day the second one landed. */
function pick(place, keys) {
  keys = keys || {};
  return (mapSources.find(s =>
    (!s.requiresKey || keys[s.requiresKey]) && mapSourceCovers(s, place)
  ) || {}).key || null;
}
const ALL_KEYS = { linzKey: true, esriKey: true };

test("every course lands on the best layer that can actually draw", () => {
  assert.strictEqual(pick(AUCKLAND_NZ, ALL_KEYS), "linz", "NZ with a key gets LINZ - the open regional aerial outranks paid Esri");
  assert.strictEqual(pick(AUCKLAND_NZ, {}), "osm", "NZ without any key degrades, it does not blank");
  assert.strictEqual(pick(AUCKLAND_NZ, { esriKey: true }), "esri", "NZ missing only the LINZ key still gets an aerial, just the paid one");
  assert.strictEqual(pick(GOLD_COAST_AU, ALL_KEYS), "qld", "Queensland gets Queensland aerial, not empty LINZ");
  assert.strictEqual(pick(PEBBLE_US, ALL_KEYS), "naip", "the US has a live aerial source now - the same NAIP the scan stores");
  assert.strictEqual(pick(ST_ANDREWS_UK, ALL_KEYS), "esri", "the UK has no open program, and now gets paid aerial rather than the line guide");
  assert.strictEqual(pick(ST_ANDREWS_UK, { linzKey: true }), "osm", "without the Esri key the UK degrades to the guide, it does not blank");
});

test("the European open programmes answer before paid Esri, and need no key at all", () => {
  assert.strictEqual(pick(CHANTILLY_FR, ALL_KEYS), "geopf", "France gets IGN, not paid Esri");
  assert.strictEqual(pick(AMSTERDAM_NL, ALL_KEYS), "pdok", "the Netherlands gets PDOK");
  assert.strictEqual(pick(CHANTILLY_FR, {}), "geopf", "keyless: the free national layers must not depend on any key arriving");
  assert.strictEqual(pick(AMSTERDAM_NL, {}), "pdok");
  /* The Pyrenees overlap. Spain-first is the registry's documented ordering: Barcelona sits
     inside BOTH boxes and must resolve Spanish. The price is Biarritz — French ground inside
     Spain's rectangle, where PNOA has no pixels. The bbox walk cannot know that; the
     blank-layer demotion (asserted below) is what turns that from a blank map into geopf. */
  assert.strictEqual(pick(BARCELONA_ES, ALL_KEYS), "pnoa", "Barcelona is in both boxes and must be Spanish");
  assert.strictEqual(pick(BIARRITZ_FR, ALL_KEYS), "pnoa", "Biarritz lands on PNOA by bbox — the known leak the demotion exists for");
});

test("live European bboxes are the scan registry's numbers, verbatim", () => {
  /* Same invariant as NAIP: the live view and the stored frames must cover identical ground,
     or one silently promises what the other refuses. If a registry box moves, move both. */
  const registry = fs.readFileSync(path.join(root, "functions", "lib", "gd-imagery-sources.mjs"), "utf8");
  [["pdok", "pdok-nl"], ["pnoa", "pnoa-es"], ["geopf", "geopf-fr"]].forEach(([liveKey, scanKey]) => {
    const scanBox = new RegExp(
      'key: "' + scanKey + '",[\\s\\S]*?bbox: \\{ south: ([\\d.-]+), west: ([\\d.-]+), north: ([\\d.-]+), east: ([\\d.-]+) \\}'
    ).exec(registry);
    assert.ok(scanBox, scanKey + " must still declare a bbox in the scan registry");
    const live = source(liveKey).bbox;
    assert.deepStrictEqual(
      [live.south, live.west, live.north, live.east],
      scanBox.slice(1, 5).map(Number),
      "live " + liveKey + " and scan " + scanKey + " must cover identical ground");
  });
});

test("a source that cannot draw is demoted, not stared at", () => {
  /* The demotion is wired into the live layer path, so it is asserted structurally: the
     health watch exists, counts errors against loads, and is attached at every mount. The
     behavioural twin (dead-cell re-pick) runs as real code in app-basemap-fallback.test.js
     against the app shell's implementation of the same policy. */
  assert.ok(core.includes("function gdWatchBaseLayerHealth("), "the health watch must exist");
  assert.ok(/gdWatchBaseLayerHealth\(baseLayer,resolved\)/.test(core), "and be attached where the base layer is mounted");
  assert.ok(core.includes('"tileerror"') && core.includes('"tileload"'),
    "demotion must weigh errors AGAINST loads — errors alone would demote a half-covered mosaic edge");
  assert.ok(core.includes('"coverage-fallback"'), "the demoted remount names its reason");
});

test("the paid global aerial is global, keyed, and sits between the open programs and the guide", () => {
  const esri = source("esri");
  assert.ok(!esri.bbox, "a bbox on the one source that exists FOR the uncovered regions would recreate the gap");
  assert.strictEqual(esri.requiresKey, "esriKey", "unkeyed ibasemaps-api answers 403s, which paint as a broken map");
  assert.ok(/ibasemaps-api\.arcgis\.com/.test(esri.tileUrl),
    "the anonymous services.arcgisonline.com endpoint grants no commercial licence - never again");
  assert.ok(/\{ *esriKey *\}/.test(esri.tileUrl), "the template must carry the key placeholder");
  assert.strictEqual(mapSources.findIndex(s => s.key === "esri"), mapSources.length - 2,
    "preference order: every open regional aerial first, paid Esri next, the line guide last");
  /* Display-only, like Queensland: the licence the key buys is display, so the scan registry
     must never grow an Esri imagery entry. Asserted against the registry source because that
     is exactly where the mistake would be made. */
  const registry = fs.readFileSync(path.join(root, "functions", "lib", "gd-imagery-sources.mjs"), "utf8");
  assert.ok(!/ibasemaps-api|World_Imagery/.test(registry),
    "Esri World Imagery in the SCAN registry would store pixels the licence only lets us display");
});

/* NAIP is the one source here that is not a URL template. Its ImageServer has no tile cache at
   play zooms - /tile/{z}/{y}/{x} 404s, and the USGSImageryOnly cache stops at z16, which is
   1.9m/px - so it is addressed a bbox at a time. Worth asserting because a template-shaped
   assumption anywhere in the layer path silently produces a blank US map. */
test("the US source is bbox-addressed, and pinned to the same ground the scan stores", () => {
  const naip = source("naip");
  assert.ok(naip.bboxEndpoint && !naip.tileUrl, "a tileUrl here would request a cache that does not exist");
  assert.strictEqual(naip.renderingRule.rasterFunction, "NaturalColor",
    "NAIP is 4-band and also serves false-colour and NDVI; the render must not be the server's choice");
  assert.strictEqual(mapSourceCovers(naip, PEBBLE_US), true);
  [AUCKLAND_NZ, GOLD_COAST_AU, ST_ANDREWS_UK].forEach(place =>
    assert.strictEqual(mapSourceCovers(naip, place), false, "NAIP is CONUS only: " + JSON.stringify(place)));
  /* The live bbox and the scan bbox are the same numbers on purpose - the live view and the
     stored frames must cover the same courses, or one silently promises what the other refuses. */
  const registry = fs.readFileSync(path.join(root, "functions", "lib", "gd-imagery-sources.mjs"), "utf8");
  const scanBox = /key: "naip-us",[\s\S]*?bbox: \{ south: ([\d.-]+), west: ([\d.-]+), north: ([\d.-]+), east: ([\d.-]+) \}/.exec(registry);
  assert.ok(scanBox, "the naip-us registry entry must still declare a bbox");
  assert.deepStrictEqual(
    [naip.bbox.south, naip.bbox.west, naip.bbox.north, naip.bbox.east],
    scanBox.slice(1, 5).map(Number),
    "live NAIP and stored NAIP must cover identical ground");
});

test("a cold boot at the neutral centre never blanks", () => {
  /* GD_NEUTRAL_MAP_CENTER is [0,0], zoom 2 - a whole-world view. No REGIONAL source contains
     it, so a keyless boot still lands on OSM. The global Esri layer does contain it (it
     contains everywhere - that is its whole job), so a keyed boot mounts World Imagery
     instead, which at zoom 2 draws the entire earth. Either way the invariant this test
     protects holds: the boot view draws something, it does not 403 or paint empty ocean of a
     regional layer. */
  assert.strictEqual(pick(NEUTRAL_BOOT, {}), "osm", "keyless boot degrades to the guide");
  assert.strictEqual(pick(NEUTRAL_BOOT, ALL_KEYS), "esri", "a keyed boot mounts the global aerial - fine at a whole-world zoom");
  assert.ok(core.includes("GD_NEUTRAL_MAP_CENTER=[0,0]"),
    "if the neutral centre moves into a covered REGIONAL box, cold boot stops degrading gracefully");
});

test("no source is missing a credit", () => {
  /* CC BY-SA on the Queensland layer makes attribution a licence condition, not a courtesy,
     and the field was carried on every source and rendered nowhere until now. */
  mapSources.forEach(s => {
    assert.ok(s.attribution && s.attribution.trim(), s.key + " must carry an attribution string");
  });
  assert.ok(/© State of Queensland/.test(source("qld").attribution), "CC BY-SA names the licensor");
  assert.ok(core.includes("current.attribution?current.label"), "and the credit is actually rendered");
});

test("the Queensland live layer is the openly licensed service, and is display-only", () => {
  const qld = source("qld");
  assert.ok(!/SISP|Restricted/i.test(qld.tileUrl),
    "the restricted sibling carries newer imagery under subscription terms that grant none of this");
  /* Storage stays refused in the scan registry; this entry must not be mistaken for a scan
     source, which is exactly what the separate module is for. */
  const registry = fs.readFileSync(path.join(root, "functions", "lib", "gd-imagery-sources.mjs"), "utf8");
  assert.ok(/shareAlike: true/.test(registry), "qld-au is still ShareAlike-gated for storage");
  assert.ok(/SHARE_ALIKE_ACCEPTED = false/.test(registry), "and the decision is still no");
});

(async function run() {
  let failures = 0;
  for (const item of tests) {
    try {
      await item.fn();
      console.log("  ok  " + item.name);
    } catch (error) {
      failures += 1;
      console.error("  FAIL  " + item.name + "\n        " + (error && error.message || error));
    }
  }
  if (failures) {
    console.error("map-source-coverage FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("map-source-coverage passed: " + tests.length + " checks");
})();
