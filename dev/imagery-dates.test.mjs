/* Imagery capture dates: each provider's reply shape read into one answer, without a network.
 *
 * Run: node dev/imagery-dates.test.mjs */

import assert from "node:assert/strict";

const lib = await import("../functions/lib/gd-imagery-dates.mjs");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* A fetch that answers by URL substring, and records what was asked. */
function fakeFetch(routes) {
  const asked = [];
  const fn = async (url) => {
    asked.push(url);
    const hit = routes.find(r => url.includes(r.match));
    if (!hit) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    if (hit.status && hit.status !== 200) return { ok: false, status: hit.status, json: async () => ({}), text: async () => "" };
    return { ok: true, status: 200, json: async () => { if (typeof hit.body === "string") throw new Error("not json"); return hit.body; }, text: async () => typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body) };
  };
  fn.asked = asked;
  return fn;
}

const NZ = { lat: -36.86, lng: 174.76, zoom: 18 };

test("dates are read at the precision each provider gives", () => {
  assert.deepEqual(lib.parseDateValue(1654041600000), { from: "2022-06-01", to: "2022-06-01" }, "epoch ms");
  assert.deepEqual(lib.parseDateValue(20220601), { from: "2022-06-01", to: "2022-06-01" }, "YYYYMMDD as a number");
  assert.deepEqual(lib.parseDateValue("20220601"), { from: "2022-06-01", to: "2022-06-01" });
  assert.deepEqual(lib.parseDateValue("2024-03-12T00:00:00Z"), { from: "2024-03-12", to: "2024-03-12" });
  assert.deepEqual(lib.parseDateValue("23/06/2021"), { from: "2021-06-23", to: "2021-06-23" }, "day first, like IGN");
  assert.deepEqual(lib.parseDateValue("2021"), { from: "2021", to: "2021" });
  assert.deepEqual(lib.parseDateValue(2021), { from: "2021", to: "2021" });
  assert.equal(lib.parseDateValue("hello"), null);
  assert.equal(lib.parseDateValue(12), null, "a small number is not a year");
  assert.equal(lib.describeDates("2024-03-12", "2024-03-12"), "12 Mar 2024");
  assert.equal(lib.describeDates("2024-03-12", "2024-04-04"), "12 Mar 2024 – 4 Apr 2024");
  assert.equal(lib.describeDates("2021", "2021"), "2021");
  assert.equal(lib.describeDates("2024-03", "2024-03"), "Mar 2024");
});

test("a NAIP raster name carries its flight day even with no date field", () => {
  const got = lib.datesInAttributes({ OBJECTID: 3, Name: "m_3712213_ne_10_060_20220601", Category: 1 });
  assert.deepEqual(got.map(d => d.from), ["2022-06-01"]);
  const esri = lib.datesInAttributes({ SRC_DATE: 20230510, SRC_DATE2: 1683676800000, NICE_DESC: "Maxar (Vivid)" });
  assert.equal(lib.latest(esri).from, "2023-05-10");
});

test("LINZ: the finest survey under the point at this zoom, with its flown interval", async () => {
  const feed = {
    collections: [
      { id: "rural", title: "Auckland 0.5m Rural Aerial Photos (2017)", summaries: { gsd: [0.5] }, extent: { spatial: { bbox: [[174.0, -37.5, 175.5, -36.0]] }, temporal: { interval: [["2017-01-05T00:00:00Z", "2017-03-20T00:00:00Z"]] } } },
      { id: "urban", title: "Auckland 0.075m Urban Aerial Photos (2024)", summaries: { gsd: [0.075] }, extent: { spatial: { bbox: [[174.5, -37.1, 175.0, -36.6]] }, temporal: { interval: [["2024-02-01T00:00:00Z", "2024-04-11T00:00:00Z"]] } } },
      { id: "elsewhere", title: "Wellington 0.3m (2021)", summaries: { gsd: [0.3] }, extent: { spatial: { bbox: [[174.6, -41.4, 175.2, -41.1]] }, temporal: { interval: [["2021-01-01T00:00:00Z", "2021-02-01T00:00:00Z"]] } } }
    ],
    items: [
      { collection: "rural", geometry: { type: "Polygon", coordinates: [[[174.0, -37.5], [175.5, -37.5], [175.5, -36.0], [174.0, -36.0], [174.0, -37.5]]] }, properties: { "linz:zoom": { min: 13, max: 22 } } },
      { collection: "urban", geometry: { type: "Polygon", coordinates: [[[174.5, -37.1], [175.0, -37.1], [175.0, -36.6], [174.5, -36.6], [174.5, -37.1]]] }, properties: { "linz:zoom": { min: 14, max: 22 } } },
      { collection: "elsewhere", geometry: { type: "Polygon", coordinates: [[[174.6, -41.4], [175.2, -41.4], [175.2, -41.1], [174.6, -41.1], [174.6, -41.4]]] }, properties: { "linz:zoom": { min: 13, max: 22 } } }
    ]
  };
  const fetchImpl = fakeFetch([{ match: "basemaps.linz.govt.nz/v1/attribution", body: feed }]);
  const got = await lib.captureDateFor("linz", NZ, { fetchImpl, keys: { linzKey: "k1" } });
  assert.equal(got.status, "ok");
  assert.equal(got.text, "1 Feb 2024 – 11 Apr 2024");
  assert.match(got.detail, /Urban Aerial Photos \(2024\)/);
  assert.match(got.detail, /\+1 more survey/);
  assert.ok(fetchImpl.asked[0].includes("api=k1"), "the LINZ key goes on the request");
  /* Zoomed out past the urban survey's floor, the rural one is what is drawn. */
  const far = await lib.captureDateFor("linz", Object.assign({}, NZ, { zoom: 13 }), { fetchImpl });
  assert.equal(far.text, "5 Jan 2017 – 20 Mar 2017");
  const none = await lib.captureDateFor("linz", { lat: -45.9, lng: 170.5, zoom: 16 }, { fetchImpl });
  assert.equal(none.status, "none");
});

test("NAIP and Queensland: the newest raster under the point, by date field or name", async () => {
  const fetchImpl = fakeFetch([
    { match: "USGSNAIPImagery/ImageServer/query", body: { features: [
      { attributes: { OBJECTID: 1, Name: "m_3712213_ne_10_060_20200712" } },
      { attributes: { OBJECTID: 2, Name: "m_3712213_ne_10_060_20220601" } }
    ] } },
    { match: "LatestStateProgram_AllUsers/ImageServer/query", body: { features: [{ attributes: { OBJECTID: 9, Name: "Brisbane_2021", CaptureDate: 1621900800000 } }] } }
  ]);
  const naip = await lib.captureDateFor("naip", { lat: 37.77, lng: -122.42, zoom: 18 }, { fetchImpl });
  assert.equal(naip.status, "ok"); assert.equal(naip.text, "1 Jun 2022"); assert.equal(naip.detail, "m_3712213_ne_10_060_20220601");
  assert.ok(fetchImpl.asked[0].includes("geometry=-122.42%2C37.77") && fetchImpl.asked[0].includes("outFields=*"), "a point query with every field");
  const qld = await lib.captureDateFor("qld", { lat: -27.47, lng: 153.03, zoom: 18 }, { fetchImpl });
  assert.equal(qld.text, "25 May 2021");
  const empty = fakeFetch([{ match: "ImageServer/query", body: { features: [] } }]);
  assert.equal((await lib.captureDateFor("naip", { lat: 37.77, lng: -122.42 }, { fetchImpl: empty })).status, "none");
});

test("PDOK: the newest yearly layer is what Actueel_orthoHR shows", async () => {
  const xml = "<Capabilities><Layer><ows:Identifier>2023_orthoHR</ows:Identifier></Layer><Layer><ows:Identifier>Actueel_orthoHR</ows:Identifier></Layer><Layer><ows:Identifier>2025_orthoHR</ows:Identifier></Layer><Layer><ows:Identifier>2024_ortho25</ows:Identifier></Layer></Capabilities>";
  const fetchImpl = fakeFetch([{ match: "service.pdok.nl/hwh/luchtfotorgb/wmts", body: xml }]);
  const got = await lib.captureDateFor("pdok", { lat: 52.1, lng: 5.1, zoom: 18 }, { fetchImpl });
  assert.equal(got.status, "ok"); assert.equal(got.text, "2025"); assert.match(got.detail, /2025/);
});

test("IGN France and Spain: a GetFeatureInfo answer, JSON first and HTML when JSON is refused", async () => {
  const fetchImpl = fakeFetch([
    { match: "data.geopf.fr/wms-r", body: { type: "FeatureCollection", features: [{ type: "Feature", properties: { nom: "FD 33-2021", date_vol: "2021-06-23", resolution: "0.20" } }] } },
    { match: "ign.es/wms-inspire/pnoa-ma", body: "<html><body><table><tr><td>Fecha de vuelo</td><td>2022</td></tr></table></body></html>" }
  ]);
  const fr = await lib.captureDateFor("geopf", { lat: 48.8, lng: 2.2, zoom: 18 }, { fetchImpl });
  assert.equal(fr.status, "ok"); assert.equal(fr.text, "23 Jun 2021");
  assert.ok(fetchImpl.asked[0].includes("GRAPHE-MOSAIQUAGE") && fetchImpl.asked[0].includes("REQUEST=GetFeatureInfo"));
  const es = await lib.captureDateFor("pnoa", { lat: 40.4, lng: -3.7, zoom: 18 }, { fetchImpl });
  assert.equal(es.status, "ok"); assert.equal(es.text, "2022");
  assert.ok(fetchImpl.asked.some(u => u.includes("OI.MosaicElement") && u.includes("INFO_FORMAT=text%2Fhtml")), "fell back to HTML");
});

test("Esri: the citation for the zoom band in view, keyed", async () => {
  const fetchImpl = fakeFetch([{ match: "ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/identify", body: { results: [
    { layerName: "Low Resolution 15m Imagery", attributes: { NICE_NAME: "TerraColor", SRC_DATE: 20161231, MinMapLevel: 0, MaxMapLevel: 13 } },
    { layerName: "High Resolution 30cm Imagery", attributes: { NICE_NAME: "Maxar (Vivid Advanced)", SRC_DATE: 20230510, SRC_DATE2: 1683676800000, SRC_RES: 0.3, MinMapLevel: 14, MaxMapLevel: 23 } }
  ] } }]);
  const got = await lib.captureDateFor("esri", { lat: 51.5, lng: -0.1, zoom: 18, bounds: { north: 51.6, south: 51.4, east: 0, west: -0.2 } }, { fetchImpl, keys: { esriKey: "TOKEN" } });
  assert.equal(got.status, "ok"); assert.equal(got.text, "10 May 2023"); assert.equal(got.detail, "Maxar (Vivid Advanced), 0.30 m/px");
  assert.ok(fetchImpl.asked[0].includes("token=TOKEN") && fetchImpl.asked[0].includes("mapExtent=-0.2%2C51.4%2C0%2C51.6"));
  assert.equal((await lib.captureDateFor("esri", { lat: 51.5, lng: -0.1, zoom: 18 }, { fetchImpl, keys: {} })).status, "error", "no key, no identify");
});

test("sources with no published dates say so; a dead provider is an error, not a crash", async () => {
  for (const key of ["mapbox", "google", "osm"]) {
    const got = await lib.captureDateFor(key, NZ, { fetchImpl: fakeFetch([]) });
    assert.equal(got.status, "unsupported", key); assert.ok(got.text.length > 10);
  }
  const dead = await lib.captureDateFor("naip", { lat: 37.77, lng: -122.42, zoom: 18 }, { fetchImpl: fakeFetch([{ match: "ImageServer", status: 503 }]) });
  assert.equal(dead.status, "error"); assert.match(dead.text, /HTTP 503/);
  assert.equal((await lib.captureDateFor("nope", NZ, { fetchImpl: fakeFetch([]) })).status, "error");
  assert.equal((await lib.captureDateFor("linz", {}, { fetchImpl: fakeFetch([]) })).status, "error");
});

let failures = 0;
for (const item of tests) {
  try { await item.fn(); console.log("  ok  " + item.name); }
  catch (error) { failures += 1; console.error("  FAIL  " + item.name + "\n        " + (error && error.stack || error)); }
}
if (failures) { console.error("imagery-dates FAILED: " + failures + " of " + tests.length); process.exit(1); }
console.log("imagery-dates passed: " + tests.length + " checks");
