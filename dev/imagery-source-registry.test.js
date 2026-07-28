/* The licensing gate on every stored pixel.
 *
 * A snapshot does not display imagery, it stores a derivative of it and serves that derivative
 * to players. Most web imagery grants only display. The anonymous Esri World Imagery endpoints
 * this pipeline started on grant neither - they are not licensed for commercial use at all -
 * and they were hardcoded into the capture policies, which meant the licence question could
 * never be asked because there was nothing to ask it of.
 *
 * So the registry is not a lookup table with a licence column; it is the gate. The assertions
 * that matter here are the refusals: a display-only entry is never returned, an entry that
 * does not cover the course is never returned, an unconfigured entry is never returned, and
 * nothing is EVER substituted when the answer is no. A course with no licensed source runs
 * live-only, indefinitely, which is a correct outcome.
 *
 * Also covers the arcgis-export geometry, because a bbox computed wrong would silently store
 * the wrong ground. */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* Real course bounds, so the region tests are exercised against places rather than numbers.
   Pupuke is the course with existing published frames to compare against. */
const PUPUKE_NZ = { south: -36.784, west: 174.762, north: -36.775, east: 174.773 };
const PEBBLE_US = { south: 36.560, west: -121.955, north: 36.573, east: -121.936 };
const ST_ANDREWS_UK = { south: 56.340, west: -2.816, north: 56.352, east: -2.795 };

const NZ_ENV = { LINZ_BASEMAPS_API_KEY: "linz-test-key" };

let mod = null;

test("a licensed source covering the course is resolved with its key filled in", () => {
  const source = mod.resolveImagerySource(PUPUKE_NZ, { env: NZ_ENV });
  assert.ok(source, "NZ course must resolve to LINZ");
  assert.strictEqual(source.key, "linz-nz");
  assert.strictEqual(source.imagery.adapter, "xyz");
  assert.ok(source.imagery.urlTemplate.includes("api=linz-test-key"), "the key is substituted into the template");
  assert.ok(!/\{ *key *\}|\{ *layer *\}/.test(source.imagery.urlTemplate), "no placeholder survives resolution");
});

test("a course outside every region resolves to nothing at all", () => {
  const source = mod.resolveImagerySource(ST_ANDREWS_UK, { env: NZ_ENV });
  assert.strictEqual(source, null, "no licensed source must never fall through to an unlicensed one");
  assert.match(mod.unscannableReason(ST_ANDREWS_UK), /no licensed imagery source covers/);
});

test("a display-only source is refused even when it covers the course", () => {
  /* Exactly the shape of the Esri entry that used to be hardcoded in the capture policies:
     present, working, correctly attributed - and not licensed to be stored. */
  const displayOnly = [{
    key: "display-only",
    label: "Someone's World Imagery",
    region: { bbox: { south: -90, west: -180, north: 90, east: 180 } },
    license: { name: "Display only", storage: false, derivatives: false, redistribution: false },
    imagery: { adapter: "xyz", urlTemplate: "https://example.test/{z}/{x}/{y}.jpg", maxUsefulZoom: 21 },
    attribution: { text: "Credit given" }
  }];
  assert.strictEqual(mod.resolveImagerySource(PUPUKE_NZ, { sources: displayOnly, env: {} }), null,
    "attribution is a condition some licences attach, never a right they grant");
  assert.match(mod.unscannableReason(PUPUKE_NZ, { sources: displayOnly }), /display-only|may not be stored/);
});

test("partial rights are not rights - all three must be granted", () => {
  const base = {
    key: "partial", label: "Partial", region: { bbox: { south: -90, west: -180, north: 90, east: 180 } },
    imagery: { adapter: "xyz", urlTemplate: "https://example.test/{z}/{x}/{y}.jpg" }, attribution: {}
  };
  const combos = [
    { storage: true, derivatives: true, redistribution: false },
    { storage: true, derivatives: false, redistribution: true },
    { storage: false, derivatives: true, redistribution: true }
  ];
  combos.forEach(license => {
    const sources = [Object.assign({}, base, { license: Object.assign({ name: "Partial" }, license) })];
    assert.strictEqual(mod.resolveImagerySource(PUPUKE_NZ, { sources, env: {} }), null,
      "refused for " + JSON.stringify(license));
  });
});

/* ShareAlike is the interesting refusal, because it is the one that passes every other check.
   A CC BY-SA source grants storage, derivatives and redistribution - so before this gate it
   resolved, and the first anyone would have known about the copyleft obligation is when the
   baked course packages were already shipped. */
test("a ShareAlike source is refused even though it grants all three rights", () => {
  const shareAlike = [{
    key: "share-alike", label: "Openly licensed, with strings",
    region: { bbox: { south: -90, west: -180, north: 90, east: 180 } },
    license: { name: "CC BY-SA", storage: true, derivatives: true, redistribution: true, shareAlike: true },
    imagery: { adapter: "xyz", urlTemplate: "https://example.test/{z}/{x}/{y}.jpg" },
    attribution: {}
  }];
  assert.strictEqual(mod.resolveImagerySource(PUPUKE_NZ, { sources: shareAlike, env: {} }), null,
    "storing it would license our own course packages on the same terms - that is a decision, not a default");
  assert.strictEqual(mod.SHARE_ALIKE_ACCEPTED, false,
    "the decision has not been made; flipping this must be a deliberate, reviewable act");

  /* And the reason must say so. Reporting copyleft as display-only would hide a decision
     somebody can still make from the person best placed to make it. */
  const reason = mod.unscannableReason(PUPUKE_NZ, { sources: shareAlike });
  assert.match(reason, /ShareAlike/);
  assert.ok(!/display-only/.test(reason), "ShareAlike is not display-only - they are different answers");
});

test("a draft entry is refused however good its licence looks", () => {
  /* Plain CC BY, all three rights, no key needed - and unverified endpoints, which fail as a
     whole course of missing tiles hours into a scan rather than as an error. */
  const draft = [{
    key: "draft-entry", label: "Researched, not checked", draft: true,
    region: { bbox: { south: -90, west: -180, north: 90, east: 180 } },
    license: { name: "CC BY 4.0", storage: true, derivatives: true, redistribution: true },
    imagery: { adapter: "arcgis-export", endpoint: "https://example.test/ImageServer/exportImage", apiKeyEnv: "" },
    attribution: {}
  }];
  assert.strictEqual(mod.resolveImagerySource(PUPUKE_NZ, { sources: draft, env: {} }), null);
  assert.match(mod.unscannableReason(PUPUKE_NZ, { sources: draft }), /draft|unverified/);
});

/* The two gates are independent on purpose: answering the ShareAlike question must not
   promote an entry whose URLs nobody has opened. */
test("accepting ShareAlike would still not release a draft entry", () => {
  const both = [{
    key: "draft-and-share-alike", label: "Both problems", draft: true,
    region: { bbox: { south: -90, west: -180, north: 90, east: 180 } },
    license: { name: "CC BY-SA", storage: true, derivatives: true, redistribution: true, shareAlike: true },
    imagery: { adapter: "xyz", urlTemplate: "https://example.test/{z}/{x}/{y}.jpg" },
    attribution: {}
  }];
  assert.strictEqual(mod.resolveImagerySource(PUPUKE_NZ, { sources: both, env: {} }), null);
  assert.match(mod.unscannableReason(PUPUKE_NZ, { sources: both }), /draft|unverified/,
    "the draft gate is reported first because it is the one no product decision can clear");
});

/* Australia is in the table as research. It must stay inert until someone does the work
   listed in the entry, and these assertions are what "inert" means. */
test("the Queensland entry is present, documented and refused", () => {
  const qld = mod.IMAGERY_SOURCES.find(entry => entry.key === "qld-au");
  assert.ok(qld, "the research belongs where the next person will find it");
  assert.strictEqual(qld.draft, true, "endpoints are unverified");
  assert.strictEqual(qld.license.shareAlike, true, "Queensland releases state program imagery under CC BY-SA");

  /* A course on the Gold Coast - inside the Queensland bbox, and still not scannable. */
  const GOLD_COAST_AU = { south: -28.02, west: 153.40, north: -28.00, east: 153.43 };
  assert.strictEqual(mod.resolveImagerySource(GOLD_COAST_AU, { env: NZ_ENV }), null,
    "a drafted entry must never be reachable from the real table");
  assert.match(mod.unscannableReason(GOLD_COAST_AU), /draft|unverified/);

  /* The restricted sibling service carries newer imagery under subscription terms that grant
     none of this, and looks like the same service with fresher pixels. */
  assert.ok(!/SISP|Restricted/i.test(qld.imagery.endpoint), "the _AllUsers service is the openly licensed one");
});

test("a licensed source with no API key configured is unusable, not degraded", () => {
  assert.strictEqual(mod.resolveImagerySource(PUPUKE_NZ, { env: {} }), null);
  assert.match(mod.unscannableReason(PUPUKE_NZ, { env: {} }), /not configured|unavailable/);
});

test("region containment is containment, not overlap", () => {
  /* A course straddling a region edge would be shot half from a source that does not cover it,
     and the missing half comes back as another provider's fill or as tile failures. */
  const straddling = { south: -34.5, west: 178.5, north: -33.5, east: 179.5 };
  assert.strictEqual(mod.resolveImagerySource(straddling, { env: NZ_ENV }), null);
});

test("the US entry resolves to the export adapter with a low zoom ceiling", () => {
  const source = mod.resolveImagerySource(PEBBLE_US, { env: {} });
  assert.ok(source, "NAIP needs no key");
  assert.strictEqual(source.key, "naip-us");
  assert.strictEqual(source.imagery.adapter, "arcgis-export");
  assert.ok(source.imagery.maxUsefulZoom <= 18, "base NAIP is 0.6m - asking for z19 buys upscaled mush");
  assert.ok(!/NAIPPlus/i.test(source.imagery.endpoint), "Plus blends contributed orthos whose terms are unconfirmed");
});

/* Both templates are verbatim from LINZ's own MapLibre example. They are asserted rather than
   trusted because a wrong one fails as a whole course of missing tiles, hours into a scan. */
test("the LINZ endpoints match LINZ's own published form", () => {
  const source = mod.resolveImagerySource(PUPUKE_NZ, { env: NZ_ENV });
  assert.strictEqual(source.imagery.urlTemplate,
    "https://basemaps.linz.govt.nz/v1/tiles/aerial/WebMercatorQuad/{z}/{x}/{y}.webp?api=linz-test-key");
  assert.ok(source.dem, "NZ ships an elevation source");
  assert.ok(source.dem.urlTemplate.includes("pipeline=terrain-rgb"),
    "without the pipeline parameter the tileset returns a picture of the terrain, not the terrain");
  assert.ok(source.dem.urlTemplate.includes("api=linz-test-key"), "the DEM shares the imagery key");
  assert.strictEqual(source.dem.encoding, "terrain-rgb");
});

test("every region carries a DEM and no region carries a hillshade raster", () => {
  mod.IMAGERY_SOURCES.forEach(entry => {
    assert.ok(entry.dem, entry.key + " must carry a DEM - it feeds both relief and plays-like");
    assert.ok(!("hillshade" in entry), entry.key + " must not fetch pre-shaded relief");
  });
});

test("an unconfigured DEM drops elevation without failing the course", () => {
  /* Imagery and DEM share the LINZ key here, so test the shape directly: a resolved entry may
     legitimately come back with dem null, and that must not take imagery down with it. */
  const entry = {
    key: "dem-less", label: "DEM-less",
    region: { bbox: { south: -90, west: -180, north: 90, east: 180 } },
    license: { name: "Open", storage: true, derivatives: true, redistribution: true },
    imagery: { adapter: "xyz", urlTemplate: "https://example.test/{z}/{x}/{y}.jpg" },
    dem: { adapter: "xyz", urlTemplate: "https://example.test/dem/{z}/{x}/{y}.png", apiKeyEnv: "MISSING_DEM_KEY" },
    attribution: {}
  };
  const source = mod.resolveImagerySource(PUPUKE_NZ, { sources: [entry], env: {} });
  assert.ok(source, "the course still scans");
  assert.strictEqual(source.dem, null, "and simply ships no elevation grid");
});

test("attribution reads back the licensor per survey where the licence demands it", () => {
  const source = mod.resolveImagerySource(PUPUKE_NZ, { env: NZ_ENV });
  const generic = mod.attributionFor(source, null);
  assert.ok(generic.text.includes("CC BY 4.0"));
  assert.strictEqual(generic.license, "CC BY 4.0");
  const perSurvey = mod.attributionFor(source, { licensor: "Auckland Council" });
  assert.ok(perSurvey.text.includes("licensed by Auckland Council"), "CC BY names the licensor, which varies per survey");
});

test("an export block asks for the exact ground its pixels cover", () => {
  const zoom = 17;
  const spec = { endpoint: "https://example.test/ImageServer/exportImage", adapter: "arcgis-export" };
  const url = new URL(mod.exportImageUrl(spec, { left: 128000, top: 79000, width: 2048, height: 1024 }, zoom));
  const [minX, minY, maxX, maxY] = url.searchParams.get("bbox").split(",").map(Number);
  assert.strictEqual(url.searchParams.get("size"), "2048,1024");
  assert.strictEqual(url.searchParams.get("bboxSR"), "3857");
  assert.ok(maxX > minX && maxY > minY, "bbox is ordered minx,miny,maxx,maxy");

  /* The requested ground must match the requested pixels, or stored frames land off-course.
     One pixel at z17 is a known number of mercator metres. */
  const mppAtZoom = (20037508.342789244 * 2) / (256 * Math.pow(2, zoom));
  assert.ok(Math.abs((maxX - minX) - 2048 * mppAtZoom) < 1e-6, "width in metres matches width in pixels");
  assert.ok(Math.abs((maxY - minY) - 1024 * mppAtZoom) < 1e-6, "height in metres matches height in pixels");

  /* Adjacent blocks must abut exactly - a gap or overlap is a seam in a stored frame. */
  const next = new URL(mod.exportImageUrl(spec, { left: 128000 + 2048, top: 79000, width: 2048, height: 1024 }, zoom));
  assert.strictEqual(Number(next.searchParams.get("bbox").split(",")[0]), maxX);
});

test("elevation is requested as measurements, imagery as a picture", () => {
  const imagery = new URL(mod.exportImageUrl({ endpoint: "https://example.test/e" }, { left: 0, top: 0, width: 256, height: 256 }, 17));
  assert.strictEqual(imagery.searchParams.get("format"), "jpg");
  const dem = new URL(mod.exportImageUrl({ endpoint: "https://example.test/e", format: "tiff" }, { left: 0, top: 0, width: 256, height: 256 }, 17));
  assert.strictEqual(dem.searchParams.get("format"), "tiff", "a JPEG of a DEM is not a DEM");
});

(async function run() {
  mod = await import(path.join(root, "functions", "lib", "gd-imagery-sources.mjs"));
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
    console.error("imagery-source-registry FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("imagery-source-registry passed: " + tests.length + " checks");
})();
