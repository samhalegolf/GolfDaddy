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
function pick(place, hasLinzKey) {
  return (mapSources.find(s =>
    (s.requiresKey !== "linzKey" || hasLinzKey) && mapSourceCovers(s, place)
  ) || {}).key || null;
}

test("every course lands on the best layer that can actually draw", () => {
  assert.strictEqual(pick(AUCKLAND_NZ, true), "linz", "NZ with a key gets aerial");
  assert.strictEqual(pick(AUCKLAND_NZ, false), "osm", "NZ without a key degrades, it does not blank");
  assert.strictEqual(pick(GOLD_COAST_AU, true), "qld", "Queensland gets Queensland aerial, not empty LINZ");
  assert.strictEqual(pick(PEBBLE_US, true), "osm", "no live aerial source covers the US yet - the guide, not a blank");
  assert.strictEqual(pick(ST_ANDREWS_UK, true), "osm");
});

test("a cold boot at the neutral centre picks the fallback, then upgrades", () => {
  /* GD_NEUTRAL_MAP_CENTER is [0,0]. No regional source contains it, which is what makes
     "boots on OSM and upgrades once we know where we are" fall out of the coverage test
     rather than needing to be special-cased. */
  assert.strictEqual(pick(NEUTRAL_BOOT, true), "osm");
  assert.ok(core.includes("GD_NEUTRAL_MAP_CENTER=[0,0]"),
    "if the neutral centre moves into a covered region, cold boot stops degrading gracefully");
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
