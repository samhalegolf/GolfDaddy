/* Course discovery: /api/course-search and its pure core.
 *
 * The picker's search only has to find a real golf course and return
 * trustworthy coordinates. These pin the cases that broke the old
 * Nominatim-only, "<query> golf course" search:
 *   - a club Mapbox knows and OSM does not (Duchess, Alberta)
 *   - a short name that must not collapse to two letters (Ba, Fiji)
 *   - the same name in many countries (Royal Golf Club) -> country groups
 *   - the same name in many countries with one selected (Springfield)
 *   - several courses at one place that must stay separate (St Andrews)
 * and the physical-course evidence model (holes, outdoor space, simulators,
 * scorecard confirmation) plus cross-provider dedupe.
 *
 * Run: node dev/course-search.test.js */
const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const VOCAB = path.join(ROOT, "functions", "lib", "gd-golf-vocabulary.mjs");
const CORE = path.join(ROOT, "functions", "lib", "gd-course-search-core.mjs");
const FN = path.join(ROOT, "functions", "course-search.mjs");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ------------------------------------------------------------ fixtures */
function mapboxFeature(name, lat, lng, opts = {}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: {
      name, mapbox_id: opts.id || "mb-" + name.replace(/\W+/g, "-").toLowerCase() + "-" + lat.toFixed(2),
      feature_type: "poi",
      coordinates: { latitude: lat, longitude: lng },
      poi_category_ids: opts.categories || ["golf_course"],
      context: {
        country: { name: opts.country || "", country_code: (opts.cc || "").toLowerCase() },
        region: opts.region ? { name: opts.region } : undefined
      }
    }
  };
}
function nominatimItem(name, lat, lng, opts = {}) {
  return {
    osm_type: opts.osmType || "way", osm_id: opts.osmId || Math.floor(Math.abs(lat * 1e5 + lng * 1e3)),
    lat: String(lat), lon: String(lng), name,
    display_name: name + ", " + (opts.region || "") + ", " + (opts.country || ""),
    category: opts.cls || "leisure", type: opts.type || "golf_course",
    address: { state: opts.region, country: opts.country, country_code: (opts.cc || "").toLowerCase() },
    extratags: opts.extratags || {}
  };
}
function clarityRow(name, lat, lng, opts = {}) {
  return {
    id: opts.id || "row-" + name, course_id: opts.courseId || name.toLowerCase().replace(/\W+/g, "-"),
    course_name: name, course_lat: lat, course_lng: lng, region: opts.region || "", country: opts.country || "",
    country_code: opts.cc || "", facility_key: opts.facilityKey || "", facility_name: "", course_aliases: [],
    hole_count: opts.holes == null ? 18 : opts.holes
  };
}
/* Overpass `out tags bb`: one hole every ~120m along a line from a point. */
function holesAround(lat, lng, count) {
  const elements = [];
  for (let i = 0; i < count; i++) {
    const la = lat + 0.0008 * (i % 6) - 0.002, lo = lng + 0.001 * Math.floor(i / 6) - 0.0015;
    elements.push({ type: "way", id: 9000 + i, tags: { golf: "hole", ref: String(i + 1), par: "4" }, bounds: { minlat: la, maxlat: la + 0.0006, minlon: lo, maxlon: lo + 0.0002 } });
    elements.push({ type: "way", id: 9500 + i, tags: { golf: "green" }, bounds: { minlat: la + 0.0006, maxlat: la + 0.0007, minlon: lo, maxlon: lo + 0.0001 } });
  }
  return elements;
}

/* A fake world behind fetch, keyed by provider. Records every request. */
function installFetch(world) {
  const calls = { mapbox: [], nominatim: [], clarity: [], overpass: [], web: [], page: [] };
  global.fetch = async (input, init) => {
    const href = String(input);
    const url = new URL(href);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), headers: { get: () => "text/html" } });
    if (url.hostname === "api.mapbox.com") {
      calls.mapbox.push(url);
      return ok({ type: "FeatureCollection", features: (world.mapbox || (() => []))(url) });
    }
    if (url.hostname === "nominatim.openstreetmap.org") {
      calls.nominatim.push(url);
      return ok((world.nominatim || (() => []))(url));
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      calls.clarity.push(url);
      return ok((world.clarity || (() => []))(url));
    }
    if (url.hostname === "overpass-api.de") {
      calls.overpass.push(url);
      if (world.overpassDown) return { ok: false, status: 504, json: async () => ({}) };
      return ok({ elements: (world.overpass || (() => []))(decodeURIComponent(url.search)) });
    }
    if (url.hostname === "api.search.brave.com") {
      calls.web.push(url);
      return ok({ web: { results: (world.web || (() => []))(url) } });
    }
    calls.page.push(url);
    return ok(world.page ? world.page(url) : "");
  };
  return calls;
}
function configure(env) {
  ["MAPBOX_PUBLIC_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "BRAVE_SEARCH_API_KEY", "GOOGLE_CSE_KEY", "GOOGLE_CSE_ID"].forEach((k) => { delete process.env[k]; });
  Object.assign(process.env, env);
}
const FULL_ENV = { MAPBOX_PUBLIC_TOKEN: "pk.test", SUPABASE_URL: "https://db.example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service" };
let uniq = 0;
/* Each search uses a distinct Overpass query (different points), but give
   repeated calls distinct queries anyway: the Overpass client caches by query. */
async function search(params) {
  const { default: handler } = await import(FN);
  const qs = new URLSearchParams(Object.assign({ debug: "1" }, params)).toString();
  const res = await handler(new Request("https://x.test/api/course-search?" + qs + "&_=" + (uniq++)));
  assert.strictEqual(res.status, 200);
  return res.json();
}

/* ------------------------------------------------------------ vocabulary */
test("Ba Golf Club keeps its identity: comparison keeps the club words and a short core is flagged", async () => {
  const v = await import(VOCAB);
  assert.strictEqual(v.comparable("Ba Golf Club"), "ba golf club", "comparison form must not collapse to 'ba'");
  assert.strictEqual(v.displayName("  Ba   Golf Club "), "Ba Golf Club");
  assert.deepStrictEqual(v.distinctiveTokens("Ba Golf Club"), { tokens: ["ba"], short: true, all: ["ba", "golf", "club"] });
  assert.strictEqual(v.nameMatch("Ba Golf Club", "Balgove Golf Club").tier, "none", "two letters never substring-match a longer word");
  assert.strictEqual(v.nameMatch("Ba", "Barnbougle Dunes").tier, "none");
  assert.strictEqual(v.nameMatch("Ba Golf Club", "FSC Ba Golf Club").tier, "strong");
  const core = await import(CORE);
  assert.strictEqual(core.relaxedQuery("Ba Golf Club"), "", "no relaxed variant that would search for 'ba golf'");
  assert.deepStrictEqual(core.aliasQueries("Ba Golf Club", "FJ"), [], "and no alias expansion of a two-letter core");
});

test("abbreviations and translations classify as golf courses without being dropped", async () => {
  const v = await import(VOCAB);
  assert.strictEqual(v.comparable("Akarana G.C."), v.comparable("Akarana Golf Club"));
  assert.strictEqual(v.comparable("Royal Golf & Country Club"), "royal golf and country club");
  [["Ullna Golfklubb", "golfklubb"], ["Golfclub Feldafing", "golfclub"], ["Club de Golf Alcanada", "club de golf"],
    ["Golfbaan Spaarnwoude", "golfbaan"], ["Golfplatz Wörthsee", "golfplatz"], ["Campo de Golf El Saler", "campo de golf"],
    ["남서울 골프장", "골프장"], ["太平洋クラブ ゴルフ場", "ゴルフ場"], ["Fanling Golf Links", "golf links"], ["소피아그린CC", "country club"]]
    .forEach(([name, term]) => assert.ok(v.golfTerms(name).includes(term), name + " should carry " + term + ", got " + v.golfTerms(name)));
  assert.deepStrictEqual(v.golfTerms("Golf Road Dairy"), [], "'golf' alone is not a course");
});

/* ------------------------------------------------------------- the ladder */
test("Duchess Golf Club / Canada / Alberta: exact text first, provider-native country and region filters, no 'golf course' suffix", async () => {
  configure(FULL_ENV);
  const calls = installFetch({
    nominatim: (url) => url.searchParams.get("featureType") === "state"
      ? [{ boundingbox: ["48.99", "60.0", "-120.0", "-110.0"], display_name: "Alberta, Canada" }] : [],
    mapbox: (url) => url.searchParams.get("q") === "Duchess Golf Club"
      ? [mapboxFeature("Duchess Golf Club", 50.7317, -111.9172, { country: "Canada", cc: "CA", region: "Alberta" })] : []
  });
  const body = await search({ q: "Duchess Golf Club", country: "CA", region: "Alberta" });
  assert.strictEqual(body.results[0].name, "Duchess Golf Club");
  assert.strictEqual(body.results[0].region, "Alberta");
  assert.strictEqual(body.results[0].countryCode, "CA");
  assert.ok(Number.isFinite(body.results[0].lat) && Number.isFinite(body.results[0].lng), "coordinates are the product");
  assert.strictEqual(body.results[0].hasMap, false, "no Clarity map, still a valid result");
  const first = calls.mapbox[0];
  assert.strictEqual(first.searchParams.get("q"), "Duchess Golf Club", "the typed text, unchanged, is the primary query");
  assert.strictEqual(first.searchParams.get("country"), "ca", "country goes in Mapbox's country filter");
  assert.ok(first.searchParams.get("bbox"), "region goes in as a bounding box");
  assert.ok(!/alberta|canada/i.test(first.searchParams.get("q")), "never glued onto the name");
  const nomSearch = calls.nominatim.find((u) => u.searchParams.get("q") === "Duchess Golf Club");
  assert.strictEqual(nomSearch.searchParams.get("countrycodes"), "ca");
  assert.strictEqual(nomSearch.searchParams.get("bounded"), "1");
  assert.ok(!calls.mapbox.some((u) => /golf course$/i.test(u.searchParams.get("q"))), "no '<query> golf course' rewrite anywhere");
  assert.deepStrictEqual(body.diagnostics.rungs.map((r) => r.rung), [1], "a strong first answer stops the ladder");
});

test("a weak first answer climbs the ladder: golf category, then relaxed name, then local terms", async () => {
  configure(FULL_ENV);
  const calls = installFetch({
    mapbox: (url) => url.searchParams.get("q").toLowerCase() === "ullna golfklubb"
      ? [mapboxFeature("Ullna Golfklubb", 59.44, 18.13, { country: "Sweden", cc: "SE", region: "Stockholm" })] : []
  });
  const body = await search({ q: "Ullna Golf Club", country: "SE" });
  assert.deepStrictEqual(body.diagnostics.rungs.map((r) => r.rung), [1, 2, 3, 4]);
  assert.strictEqual(calls.mapbox[1].searchParams.get("poi_category"), "golf_course", "rung 2 is the provider's own golf filter");
  assert.strictEqual(calls.mapbox[2].searchParams.get("q"), "ullna golf", "rung 3 relaxes the name");
  assert.strictEqual(calls.mapbox[3].searchParams.get("q"), "ullna golfklubb", "rung 4 tries the Swedish word");
  assert.strictEqual(body.results[0].name, "Ullna Golfklubb");
});

test("FSC Ba Golf Club / Fiji is found for 'Ba Golf Club'; Balgove and Barnbougle are not", async () => {
  configure(FULL_ENV);
  installFetch({
    mapbox: () => [
      mapboxFeature("FSC Ba Golf Club", -17.535, 177.676, { country: "Fiji", cc: "FJ", region: "Western" }),
      mapboxFeature("Balgove Course", 56.344, -2.818, { country: "United Kingdom", cc: "GB", region: "Scotland" }),
      mapboxFeature("Barnbougle Dunes", -41.07, 147.38, { country: "Australia", cc: "AU", region: "Tasmania" })
    ],
    overpass: () => []
  });
  const body = await search({ q: "Ba Golf Club" });
  assert.deepStrictEqual(body.results.map((r) => r.name), ["FSC Ba Golf Club"]);
  assert.strictEqual(body.results[0].country, "Fiji");
});

test("St Andrews: several courses at one place stay separate rows", async () => {
  configure(FULL_ENV);
  installFetch({
    nominatim: (url) => url.searchParams.get("q") === "St Andrews" ? [
      nominatimItem("St Andrews Links Old Course", 56.3433, -2.8030, { region: "Scotland", country: "United Kingdom", cc: "GB", osmId: 1 }),
      nominatimItem("St Andrews Links New Course", 56.3460, -2.8060, { region: "Scotland", country: "United Kingdom", cc: "GB", osmId: 2 }),
      nominatimItem("St Andrews Links Jubilee Course", 56.3490, -2.8070, { region: "Scotland", country: "United Kingdom", cc: "GB", osmId: 3 }),
      nominatimItem("St Andrews Links Eden Course", 56.3500, -2.8150, { region: "Scotland", country: "United Kingdom", cc: "GB", osmId: 4 }),
      nominatimItem("St Andrews Street", 56.34, -2.79, { cls: "highway", type: "residential", region: "Scotland", country: "United Kingdom", cc: "GB", osmId: 5 })
    ] : [],
    mapbox: () => [mapboxFeature("The Old Course at St Andrews", 56.3431, -2.8028, { country: "United Kingdom", cc: "GB", region: "Scotland" })]
  });
  const body = await search({ q: "St Andrews" });
  const names = body.results.map((r) => r.name);
  ["Old", "New", "Jubilee", "Eden"].forEach((course) => assert.ok(names.some((n) => n.includes(course)), course + " survives dedupe: " + names));
  assert.ok(!names.includes("St Andrews Street"), "a street is not a golf listing");
  assert.strictEqual(body.groups.mode, "list", "one country - the list, not a country question");
  assert.ok(body.results.every((r) => r.confidence === "confirmed_course"), "OSM course polygons are confirmed without a ground check");
});

test("Royal Golf Club across many countries condenses into country groups", async () => {
  configure(FULL_ENV);
  const spots = [
    ["CA", "Canada", "Ontario", 43.6, -79.4], ["CA", "Canada", "Alberta", 51.0, -114.0], ["CA", "Canada", "Quebec", 45.5, -73.6],
    ["GB", "United Kingdom", "England", 51.5, -0.1], ["GB", "United Kingdom", "Scotland", 56.0, -3.2],
    ["AU", "Australia", "Victoria", -37.8, 145.0], ["SE", "Sweden", "Skane", 55.6, 13.0], ["BE", "Belgium", "Brussels", 50.8, 4.4],
    ["MA", "Morocco", "Rabat", 34.0, -6.8], ["ZA", "South Africa", "Gauteng", -26.2, 28.0]
  ];
  installFetch({
    mapbox: () => spots.map(([cc, country, region, lat, lng]) => mapboxFeature("Royal " + region + " Golf Club", lat, lng, { cc, country, region })),
    overpass: () => []
  });
  const body = await search({ q: "Royal Golf Club" });
  assert.strictEqual(body.groups.mode, "countries");
  const counts = Object.fromEntries(body.groups.countries.map((g) => [g.other ? "other" : g.countryCode, g.count]));
  assert.strictEqual(counts.CA, 3);
  assert.strictEqual(counts.GB, 2);
  assert.ok(body.groups.countries.length <= 6, "at most six groups; the long tail goes into Other");
  assert.strictEqual(body.groups.countries.reduce((n, g) => n + g.count, 0), body.results.length, "every result is in exactly one group");
  assert.strictEqual(body.diagnostics.countries.CA, 3);
});

test("Springfield Golf Club with a selected country only returns that country", async () => {
  configure(FULL_ENV);
  const calls = installFetch({
    mapbox: (url) => {
      const all = [
        mapboxFeature("Springfield Golf Club", 39.8, -89.6, { cc: "US", country: "United States", region: "Illinois" }),
        mapboxFeature("Springfield Golf Club", 51.6, -0.5, { cc: "GB", country: "United Kingdom", region: "England" }),
        mapboxFeature("Springfield Golf Club", -27.6, 153.0, { cc: "AU", country: "Australia", region: "Queensland" })
      ];
      const cc = url.searchParams.get("country");
      return cc ? all.filter((f) => f.properties.context.country.country_code === cc) : all;
    },
    overpass: () => []
  });
  const world = await search({ q: "Springfield Golf Club" });
  assert.strictEqual(world.results.length, 3, "the same name in three countries is three courses, never merged");
  assert.strictEqual(world.groups.mode, "countries", "three countries -> ask which");
  const au = await search({ q: "Springfield Golf Club", country: "AU" });
  assert.deepStrictEqual(au.results.map((r) => r.region), ["Queensland"]);
  assert.strictEqual(au.groups.mode, "list");
  assert.strictEqual(calls.mapbox[calls.mapbox.length - 1].searchParams.get("country"), "au");
});

/* -------------------------------------------------------------- ranking */
test("an exact name farther away beats a partial name next to the player", async () => {
  const core = await import(CORE);
  const near = { lat: -36.93, lng: 174.742 };
  const listings = core.listingsFromMapbox({ features: [
    mapboxFeature("Akarana Park Pitch And Putt", -36.9302, 174.7421, { cc: "NZ", country: "New Zealand" }),
    mapboxFeature("Akarana Golf Club", -36.9175, 174.7400, { cc: "NZ", country: "New Zealand" }),
    mapboxFeature("Akarana Golf Club", -45.0, 170.0, { cc: "NZ", country: "New Zealand", id: "far" })
  ] });
  const ranked = core.rankCandidates(core.dedupeListings(listings), { query: "Akarana Golf Club", near });
  assert.strictEqual(ranked[0].name, "Akarana Golf Club");
  assert.strictEqual(ranked[1].name, "Akarana Golf Club", "even the one 900km away outranks the nearby partial match");
  assert.strictEqual(ranked[2].name, "Akarana Park Pitch And Putt");
  assert.ok(ranked[0].distanceM < ranked[1].distanceM, "proximity still breaks the tie between two exact matches");
});

/* ----------------------------------------------------------- confidence */
function candidateFor(feature) {
  return (async () => {
    const core = await import(CORE);
    return core.dedupeListings(core.listingsFromMapbox({ features: [feature] }))[0];
  })();
}

test("a Mapbox POI with no OSM course polygon but mapped holes nearby is a confirmed course", async () => {
  const core = await import(CORE);
  const c = await candidateFor(mapboxFeature("Nadi Airport Golf Club", -17.76, 177.44, { categories: ["golf_course"] }));
  const ground = core.groundEvidence({ elements: holesAround(-17.76, 177.44, 9) }, c);
  assert.strictEqual(ground.coursePolygon, null, "no enclosing polygon in this fixture");
  assert.strictEqual(ground.holes, 9);
  const scored = core.scoreCandidate(c, ground, null);
  assert.strictEqual(scored.confidence, "confirmed_course", scored.reasons.join("; "));
});

test("a golf POI with no golf features but a large outdoor footprint is a likely course", async () => {
  const core = await import(CORE);
  const c = await candidateFor(mapboxFeature("Desert Springs Golf Club", 33.8, -116.4, { categories: ["sports"] }));
  const ground = core.groundEvidence({ elements: [
    { type: "way", id: 1, tags: { natural: "scrub" }, bounds: { minlat: 33.796, maxlat: 33.804, minlon: -116.405, maxlon: -116.395 } }
  ] }, c);
  assert.ok(ground.outdoorHa >= 15, "~80ha of scrub, got " + ground.outdoorHa);
  const scored = core.scoreCandidate(c, ground, null);
  assert.strictEqual(scored.confidence, "likely_course", scored.reasons.join("; "));
});

test("an indoor simulator with no outdoor golf evidence is hidden from player results", async () => {
  configure(FULL_ENV);
  installFetch({
    mapbox: () => [
      mapboxFeature("Downtown Golf Club Indoor Simulators", 49.28, -123.12, { categories: ["golf_course"], cc: "CA", country: "Canada" }),
      mapboxFeature("Downtown Golf Club", 49.35, -123.0, { categories: ["golf_course"], cc: "CA", country: "Canada" })
    ],
    overpass: (q) => /49\.280000,-123\.120000/.test(q) ? [
      { type: "way", id: 77, tags: { landuse: "commercial" }, bounds: { minlat: 49.2795, maxlat: 49.2805, minlon: -123.1205, maxlon: -123.1195 } }
    ] : holesAround(49.35, -123.0, 18)
  });
  const body = await search({ q: "Downtown Golf Club" });
  assert.deepStrictEqual(body.results.map((r) => r.name), ["Downtown Golf Club"]);
  const sim = body.debug.candidates.find((c) => /Simulators/.test(c.name));
  assert.strictEqual(sim.confidence, "possible_golf_facility");
  assert.ok(sim.nonCourse.includes("indoor"));
  assert.ok(sim.reasons.some((r) => /commercial ground/.test(r)));
  assert.strictEqual(body.diagnostics.hidden, 1);
});

test("an ambiguous candidate is promoted by scorecard evidence", async () => {
  const core = await import(CORE);
  const c = await candidateFor(mapboxFeature("Lautoka Golf Club", -17.6, 177.45, { categories: ["sports_club"] }));
  const before = core.scoreCandidate(c, { coursePolygon: null, holes: 0, features: 0, outdoorHa: 0, commercial: false }, null);
  assert.strictEqual(before.confidence, "possible_golf_facility");
  assert.ok(before.ambiguous, "nothing says simulator, nothing cheap says course: ambiguous");
  const evidence = core.scorecardEvidence([{ url: "https://lautokagolf.example/course", text:
    "Lautoka Golf Club scorecard Hole 1 2 3 4 5 6 7 8 9 Out Par 4 4 3 5 4 4 3 4 5 Metres 350 362 150 480 Stroke index" }], "Lautoka Golf Club");
  assert.ok(evidence.confirmed && evidence.strong);
  const after = core.scoreCandidate(c, null, evidence);
  assert.ok(after.score > before.score);
  assert.notStrictEqual(after.confidence, "possible_golf_facility", after.reasons.join("; "));

  const other = core.scorecardEvidence([{ url: "https://x.example", text: "Royal Lautoka Hotel - 18 holes nearby par 72" }], "Ba Golf Club");
  assert.strictEqual(other.confirmed, false, "a page about a different club confirms nothing");
});

test("?confirm=1 runs the web search and reports the promotion", async () => {
  configure(Object.assign({}, FULL_ENV, { BRAVE_SEARCH_API_KEY: "brave" }));
  const calls = installFetch({
    web: () => [{ url: "https://lautokagolf.example/course", title: "Lautoka Golf Club - Course", description: "Our 18 holes: par 72, course rating 70.1, slope 121, yardage" }]
  });
  const { default: handler } = await import(FN);
  const res = await handler(new Request("https://x.test/api/course-search?confirm=1&name=Lautoka%20Golf%20Club&lat=-17.6&lng=177.45&country=Fiji"));
  const body = await res.json();
  assert.strictEqual(body.confirmed, true);
  assert.strictEqual(body.holes, 18);
  assert.strictEqual(body.confidence, "likely_course");
  assert.strictEqual(calls.web.length, 1, "one search, no page fetch needed when the snippet is conclusive");
  assert.strictEqual(calls.page.length, 0);
});

test("Overpass being down never hides a golf-course POI", async () => {
  configure(FULL_ENV);
  installFetch({
    overpassDown: true,
    mapbox: () => [mapboxFeature("Te Kauwhata Golf Club", -37.4, 175.15, { categories: ["golf_course"], cc: "NZ", country: "New Zealand" })]
  });
  const body = await search({ q: "Te Kauwhata Golf Club" });
  assert.strictEqual(body.results.length, 1);
  assert.strictEqual(body.results[0].confidence, "likely_course");
  assert.strictEqual(body.diagnostics.ground.status, "unavailable");
});

/* --------------------------------------------------------------- dedupe */
test("Clarity, Mapbox and OSM listings of the same course become one result, Clarity canonical", async () => {
  configure(FULL_ENV);
  installFetch({
    clarity: () => [clarityRow("Akarana Golf Club", -36.9175, 174.7400, { courseId: "akarana-golf-club", region: "Auckland", country: "New Zealand", cc: "NZ" })],
    mapbox: () => [mapboxFeature("Akarana GC", -36.9182, 174.7409, { cc: "NZ", country: "New Zealand", region: "Auckland" })],
    nominatim: (url) => url.searchParams.get("q") ? [nominatimItem("Akarana Golf Club", -36.9160, 174.7395, { region: "Auckland", country: "New Zealand", cc: "NZ" })] : []
  });
  const body = await search({ q: "Akarana Golf Club" });
  assert.strictEqual(body.results.length, 1, body.results.map((r) => r.name + "/" + r.source).join(", "));
  const r = body.results[0];
  assert.strictEqual(r.source, "clarity");
  assert.strictEqual(r.courseId, "akarana-golf-club");
  assert.strictEqual(r.hasMap, true);
  assert.strictEqual(r.confidence, "confirmed_course");
  assert.deepStrictEqual(body.debug.candidates[0].sources.sort(), ["clarity", "mapbox", "nominatim"]);
});

test("separate courses at one facility are not merged", async () => {
  const core = await import(CORE);
  const listings = core.listingsFromClarity([
    clarityRow("Te Arai Links North Course", -36.16, 174.63, { facilityKey: "te-arai" }),
    clarityRow("Te Arai Links South Course", -36.162, 174.632, { facilityKey: "te-arai" })
  ]).concat(core.listingsFromMapbox({ features: [mapboxFeature("Te Arai Links", -36.161, 174.631)] }));
  const out = core.dedupeListings(listings);
  const names = out.map((c) => c.name);
  assert.ok(names.includes("Te Arai Links North Course") && names.includes("Te Arai Links South Course"), names.join(", "));
  assert.strictEqual(out.find((c) => c.name.includes("North")).sources.length, 1, "the facility POI is not folded into one of its courses");
});

test("a Clarity stub row (no holes) never stands on its own", async () => {
  const core = await import(CORE);
  const out = core.dedupeListings(core.listingsFromClarity([clarityRow("Failed Scan Golf Club", 10, 10, { holes: 0 })]));
  assert.strictEqual(out.length, 0);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (error) { failed++; console.log("  FAIL " + t.name + "\n       " + (error && error.stack || error)); }
  }
  if (failed) { console.log("course-search: " + failed + " failed"); process.exit(1); }
  console.log("course-search passed: " + tests.length + " checks");
})();
