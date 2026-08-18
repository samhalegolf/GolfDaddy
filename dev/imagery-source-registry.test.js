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

test("the LINZ key is honoured under either env name it is published as", () => {
  /* The live map reads LINZ_BASEMAPS_PUBLIC_KEY or LINZ_BASEMAPS_API_KEY; the scanner used to
     require only the second. Rotating the key under the first name would have left the map
     working while every NZ capture failed as unconfigured - a split failure that looks fine
     from the app, which is the worst kind. Either name must work, for imagery AND elevation. */
  const underPublic = mod.resolveImagerySource(PUPUKE_NZ, { env: { LINZ_BASEMAPS_PUBLIC_KEY: "public-name-key" } });
  assert.ok(underPublic, "PUBLIC_KEY alone must configure the scanner");
  assert.strictEqual(underPublic.key, "linz-nz");
  assert.ok(underPublic.imagery.urlTemplate.includes("api=public-name-key"),
    "the key from PUBLIC_KEY is substituted into the imagery template");

  const dem = mod.resolveElevationSource(PUPUKE_NZ, { env: { LINZ_BASEMAPS_PUBLIC_KEY: "public-name-key" } });
  assert.ok(dem && dem.dem && dem.dem.urlTemplate.includes("api=public-name-key"),
    "elevation is keyed from PUBLIC_KEY too - a DEM left unconfigured ships no plays-like");

  /* API_KEY stays the preferred name, so a deployment carrying both is unchanged. */
  const both = mod.resolveImagerySource(PUPUKE_NZ, {
    env: { LINZ_BASEMAPS_API_KEY: "api-name-key", LINZ_BASEMAPS_PUBLIC_KEY: "public-name-key" }
  });
  assert.ok(both.imagery.urlTemplate.includes("api=api-name-key"), "API_KEY wins when both are set");

  /* And neither still refuses, naming both names so the fix is obvious from the message. */
  assert.strictEqual(mod.resolveImagerySource(PUPUKE_NZ, { env: {} }), null,
    "no key under any name must still refuse rather than fetch unkeyed");
  assert.match(mod.unscannableReason(PUPUKE_NZ, { env: {} }),
    /LINZ_BASEMAPS_API_KEY or LINZ_BASEMAPS_PUBLIC_KEY/);
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

test("the US entry resolves to the export adapter", () => {
  const source = mod.resolveImagerySource(PEBBLE_US, { env: {} });
  assert.ok(source, "NAIP needs no key");
  assert.strictEqual(source.key, "naip-us");
  assert.strictEqual(source.imagery.adapter, "arcgis-export");
  assert.ok(!/NAIPPlus/i.test(source.imagery.endpoint), "Plus blends contributed orthos whose terms are unconfirmed");
  /* exportImage refuses anything over 4000 outright, and a block that large is 48MB decoded. */
  assert.ok(source.imagery.blockPx <= 4000, "the service refuses requests above 4000px a side");
});

/* The zoom ceilings are the numbers the SERVICES publish about themselves, not estimates from
   what NAIP and 3DEP are usually quoted at. Both were previously a zoom too low, which is not a
   saving - it is every stored US frame composited from upscaled pixels. Read off
   .../ImageServer?f=json on 2026-07-28: NAIP pixelSizeX 0.3m, 3DEP pixelSize 1.0m. */
test("the US ceilings match what the services actually resolve", () => {
  const source = mod.resolveImagerySource(PEBBLE_US, { env: {} });
  /* Ground resolution of a zoom at Pebble's latitude. z19 is 0.24m/px against a 0.3m mosaic -
     the first zoom at or finer than native. z20 measurably returns a smooth upscale. */
  const mPerPx = (z) => (156543.03392804097 / Math.pow(2, z)) * Math.cos(36.566 * Math.PI / 180);
  assert.ok(mPerPx(source.imagery.maxUsefulZoom) <= 0.3,
    "NAIP is served at 0.3m - a ceiling coarser than that discards imagery we are paying to fetch");
  assert.ok(mPerPx(source.imagery.maxUsefulZoom + 1) < 0.3 / 1.5,
    "and one zoom higher must be a genuine upscale, or the ceiling is set too low");
  assert.ok(mPerPx(source.dem.maxUsefulZoom) <= 1.0, "3DEP is served at 1m");
});

/* Relief for the US rides the same DEM: 3DEP is public domain and float32-decodable, so the
   planner must be offered a terrain spec, tagged so the capture path transcodes floats to
   terrain-RGB instead of compositing them as an image. Before the float32 decode existed this
   came back null by design - see reliefSpec. */
test("the US elevation is offered as a relief source, tagged for the float32 transcode", () => {
  const source = mod.resolveImagerySource(PEBBLE_US, { env: {} });
  assert.ok(source.terrain, "3DEP is licensed and decodable - US courses must plan relief");
  assert.strictEqual(source.terrain.adapter, "arcgis-export");
  assert.strictEqual(source.terrain.encoding, "float32");
  assert.strictEqual(source.terrain.computed, "hillshade-from-dem");
});

/* NAIP is 4-band and publishes false-colour and NDVI renderings beside the natural one. The
   default happens to be natural colour today; these pixels are stored for years. */
test("the US imagery pins its rendering and the US elevation does not", () => {
  const source = mod.resolveImagerySource(PEBBLE_US, { env: {} });
  const imagery = new URL(mod.exportImageUrl(source.imagery, { left: 0, top: 0, width: 256, height: 256 }, 19));
  assert.strictEqual(JSON.parse(imagery.searchParams.get("renderingRule")).rasterFunction, "NaturalColor",
    "a stored derivative must not depend on a remote default");
  const dem = new URL(mod.exportImageUrl(source.dem, { left: 0, top: 0, width: 256, height: 256 }, 17));
  assert.strictEqual(dem.searchParams.get("renderingRule"), null,
    "3DEP's own functions are all hillshades and slope maps - raw is what elevation means");
});

/* This bbox IS the containment gate, so claiming ground the service has no rasters for turns a
   clean refusal into a course full of empty blocks. */
test("the US region claims no more ground than the service holds", () => {
  const entry = mod.IMAGERY_SOURCES.find(e => e.key === "naip-us");
  const box = entry.region.bbox;
  /* USGSNAIPImagery ImageServer extent, 2026-07-28, converted from EPSG:3857. */
  const served = { west: -124.8314, east: -66.8516, south: 24.4859, north: 49.5713 };
  assert.ok(box.west >= served.west, "west edge must not run past the last NAIP raster");
  assert.ok(box.east <= served.east, "east edge must not run past the last NAIP raster");
  assert.ok(box.south >= served.south && box.north <= served.north, "and neither may the latitudes");
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

/* Per-spec licences. The point is not tidiness - it is that an entry blocked on imagery can
   still ship elevation, because plays-like is arithmetic over a DEM and does not care whether
   a pixel was ever stored. */
test("a ShareAlike imagery source does not infect a CC BY elevation source", () => {
  const split = [{
    key: "split-licence", label: "Copyleft imagery, open elevation",
    region: { bbox: { south: -90, west: -180, north: 90, east: 180 } },
    license: { name: "CC BY-SA", storage: true, derivatives: true, redistribution: true, shareAlike: true },
    imagery: { adapter: "xyz", urlTemplate: "https://example.test/{z}/{x}/{y}.jpg" },
    dem: {
      adapter: "arcgis-export", endpoint: "https://example.test/dem/exportImage", apiKeyEnv: "",
      license: { name: "CC BY 4.0", storage: true, derivatives: true, redistribution: true }
    },
    attribution: {}
  }];
  assert.strictEqual(mod.resolveImagerySource(PUPUKE_NZ, { sources: split, env: {} }), null,
    "the imagery is still refused - the split does not launder ShareAlike");

  const elevation = mod.resolveElevationSource(PUPUKE_NZ, { sources: split, env: {} });
  assert.ok(elevation, "and the elevation, on its own licence, is still available");
  assert.strictEqual(elevation.license.name, "CC BY 4.0", "reported under ITS licence, not the imagery's");
});

test("an unlicensed DEM is dropped without taking licensed imagery down", () => {
  const badDem = [{
    key: "bad-dem", label: "Open imagery, display-only elevation",
    region: { bbox: { south: -90, west: -180, north: 90, east: 180 } },
    license: { name: "CC BY 4.0", storage: true, derivatives: true, redistribution: true },
    imagery: { adapter: "xyz", urlTemplate: "https://example.test/{z}/{x}/{y}.jpg" },
    dem: {
      adapter: "xyz", urlTemplate: "https://example.test/dem/{z}/{x}/{y}.png",
      license: { name: "Display only", storage: false, derivatives: false, redistribution: false }
    },
    attribution: {}
  }];
  const source = mod.resolveImagerySource(PUPUKE_NZ, { sources: badDem, env: {} });
  assert.ok(source, "the course still scans");
  assert.strictEqual(source.dem, null, "and simply ships no elevation grid");
  assert.strictEqual(mod.resolveElevationSource(PUPUKE_NZ, { sources: badDem, env: {} }), null);
});

/* NSW: the source that is only safe one named layer at a time. Without the pin the service
   returns its mixed mosaic, so absence of a layer must be refusal, not a default. */
test("a layer-pinned source is refused when the layer is not named", () => {
  const nsw = mod.IMAGERY_SOURCES.find(entry => entry.key === "nsw-au");
  assert.ok(nsw, "NSW is in the table as research");
  assert.strictEqual(nsw.draft, true);
  assert.strictEqual(nsw.imagery.layerRequired, true);
  assert.ok(!("defaultLayer" in nsw.imagery), "a default layer here would be the unsafe blend");

  const pinned = [Object.assign({}, nsw, { draft: false })];
  const SYDNEY_AU = { south: -33.92, west: 151.20, north: -33.90, east: 151.23 };
  assert.strictEqual(mod.resolveImagerySource(SYDNEY_AU, { sources: pinned, env: {} }), null,
    "no pin means no source - never the mosaic");
  assert.match(mod.unscannableReason(SYDNEY_AU, { sources: pinned, env: {} }), /NSW_IMAGERY_LAYER/,
    "the status endpoint must name what is missing, as it does for a key");

  const withLayer = mod.resolveImagerySource(SYDNEY_AU, { sources: pinned, env: { NSW_IMAGERY_LAYER: "3" } });
  assert.ok(withLayer, "a pinned series resolves");
  assert.strictEqual(withLayer.imagery.layer, "3");
});

test("the MapServer adapter pins the layer and never draws the stack", () => {
  const spec = {
    adapter: "arcgis-map-export", endpoint: "https://example.test/MapServer/export",
    layer: "3", layerEnv: "NSW_IMAGERY_LAYER"
  };
  const url = new URL(mod.exportImageUrl(spec, { left: 0, top: 0, width: 512, height: 512 }, 18));
  assert.strictEqual(url.searchParams.get("layers"), "show:3", "drawing every layer would store the blend");
  assert.strictEqual(url.searchParams.get("interpolation"), null, "MapServer export takes no interpolation hint");
  assert.strictEqual(url.searchParams.get("bboxSR"), "3857", "same geometry as the ImageServer adapter");

  /* Refusing to build the URL is the last line of defence if the pin is ever lost downstream. */
  assert.throws(() => mod.exportImageUrl(Object.assign({}, spec, { layer: "" }), { left: 0, top: 0, width: 512, height: 512 }, 18),
    /requires a pinned layer/);
});

test("per-survey credit belongs to the source, not to whoever was first", () => {
  /* This was LINZ's sentence hardcoded in attributionFor. A second perSurvey source would have
     been credited to the LINZ Data Service - a false statement about who licensed the imagery. */
  const nsw = mod.IMAGERY_SOURCES.find(entry => entry.key === "nsw-au");
  const credit = mod.attributionFor({ key: "nsw-au", attribution: nsw.attribution, license: nsw.license },
    { licensor: "AAM" });
  assert.ok(!/LINZ/.test(credit.text), "NSW imagery is not sourced from the LINZ Data Service");
  assert.ok(credit.text.includes("AAM"), "the capturing licensor is still named");

  /* A perSurvey source with no wording of its own falls back rather than borrowing. */
  const bare = mod.attributionFor({ key: "bare", attribution: { text: "© Someone", perSurvey: true } }, { licensor: "X" });
  assert.strictEqual(bare.text, "© Someone");
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
