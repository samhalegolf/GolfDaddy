/* Town and country on a course.
 *
 * The subtitle exists to tell two clubs with the same name apart, so the
 * things worth guarding are: that a place is only claimed when it is actually
 * known, that the client and the server read the geocoder the same way (two
 * copies of the settlement-key list would drift into two different subtitles
 * for the same course), and that a course with no place renders no subtitle
 * rather than a stray comma.
 *
 * The picker is a browser IIFE with no module boundary, so its functions are
 * lifted out of the source and run, the same trick course-picker-meta-label
 * uses. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PICKER = path.join(ROOT, "scripts", "inline", "gd-course-picker-search-v2.js");
const SERVER_PLACE = path.join(ROOT, "functions", "lib", "gd-course-place.mjs");
const COURSE_MAPS = path.join(ROOT, "functions", "course-maps.mjs");
const MIGRATION = path.join(ROOT, "supabase", "migrations", "20260818_add_course_place.sql");

const pickerSrc = fs.readFileSync(PICKER, "utf8");
const serverSrc = fs.readFileSync(SERVER_PLACE, "utf8");
const mapsSrc = fs.readFileSync(COURSE_MAPS, "utf8");

/* Lift a run of named functions (plus any consts between them) out of the
   picker source and evaluate them together. */
function loadPickerFns(startSignature, endSignature, names) {
  const start = pickerSrc.indexOf(startSignature);
  assert.notStrictEqual(start, -1, "could not find: " + startSignature);
  const end = pickerSrc.indexOf(endSignature, start);
  assert.notStrictEqual(end, -1, "could not find: " + endSignature);
  // eslint-disable-next-line no-new-func
  return new Function(pickerSrc.slice(start, end) + "\nreturn {" + names.join(",") + "};")();
}

const picker = loadPickerFns(
  "const PLACE_SETTLEMENT_KEYS",
  "function distance(a,b)",
  ["PLACE_SETTLEMENT_KEYS", "placeFromAddress", "placeLabel"]
);

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test("a Nominatim address becomes a town and a country", () => {
  const place = picker.placeFromAddress({
    town: "Papakura",
    country: "New Zealand",
    country_code: "nz"
  });
  assert.deepStrictEqual(place, { locality: "Papakura", country: "New Zealand", countryCode: "NZ" });
});

test("the largest settlement present wins", () => {
  /* Nominatim returns several at once for a metro course. "Auckland" is what a
     player recognises; "Epsom" is not. */
  const place = picker.placeFromAddress({
    suburb: "Epsom",
    city: "Auckland",
    country: "New Zealand",
    country_code: "nz"
  });
  assert.strictEqual(place.locality, "Auckland");
});

test("a rural course with only a hamlet still gets a subtitle", () => {
  const place = picker.placeFromAddress({ hamlet: "Kaiwaka", country: "New Zealand", country_code: "nz" });
  assert.strictEqual(picker.placeLabel(place), "Kaiwaka, New Zealand");
});

test("an address with no country is not a place", () => {
  assert.strictEqual(picker.placeFromAddress({ city: "Nowhere" }), null);
  assert.strictEqual(picker.placeFromAddress(null), null);
  assert.strictEqual(picker.placeFromAddress("Auckland"), null);
});

test("a country with no town labels as the country alone", () => {
  assert.strictEqual(
    picker.placeLabel({ locality: "", country: "Scotland", countryCode: "GB" }),
    "Scotland"
  );
});

test("a course with no place renders no subtitle, not a stray separator", () => {
  assert.strictEqual(picker.placeLabel({}), "");
  assert.strictEqual(picker.placeLabel(null), "");
  assert.ok(!picker.placeLabel({ name: "Akarana Golf Club" }).includes(","));
});

test("the country code carries a course geocoded before names were stored", () => {
  assert.strictEqual(picker.placeLabel({ locality: "Melbourne", countryCode: "au" }), "Melbourne, AU");
});

test("client and server read the geocoder identically", () => {
  /* Two copies of this list is the whole risk: they would quietly produce two
     different subtitles for the same course depending on which path filled it
     in. If one side changes, this fails and the other side changes too. */
  const serverKeys = serverSrc
    .slice(serverSrc.indexOf("const SETTLEMENT_KEYS"), serverSrc.indexOf("];", serverSrc.indexOf("const SETTLEMENT_KEYS")))
    .match(/"[a-z_]+"/g)
    .map(function (s) { return s.replace(/"/g, ""); });
  assert.deepStrictEqual(
    picker.PLACE_SETTLEMENT_KEYS,
    serverKeys,
    "gd-course-place.mjs and the picker must agree on settlement precedence"
  );
});

test("the server labels a place the same way the picker does", async () => {
  const server = await import("../functions/lib/gd-course-place.mjs");
  [
    { locality: "Auckland", country: "New Zealand", countryCode: "NZ" },
    { locality: "", country: "Scotland", countryCode: "GB" },
    { locality: "Melbourne", country: "", countryCode: "AU" },
    {}
  ].forEach(function (place) {
    assert.strictEqual(server.placeLabel(place), picker.placeLabel(place));
  });
});

test("the server accepts place fields under any spelling a caller uses", async () => {
  const server = await import("../functions/lib/gd-course-place.mjs");
  assert.deepStrictEqual(
    server.placeFromCourse({ locality: "Auckland", country: "New Zealand", country_code: "nz" }),
    { locality: "Auckland", country: "New Zealand", countryCode: "NZ" }
  );
  assert.deepStrictEqual(
    server.placeFromCourse({ courseLocality: "Sydney", courseCountry: "Australia", countryCode: "AU" }),
    { locality: "Sydney", country: "Australia", countryCode: "AU" }
  );
  assert.strictEqual(server.placeFromCourse({ courseName: "Akarana" }), null);
});

test("a bad coordinate never reaches the geocoder", async () => {
  const server = await import("../functions/lib/gd-course-place.mjs");
  assert.strictEqual(await server.reverseGeocodePlace(null, null), null);
  assert.strictEqual(await server.reverseGeocodePlace("not-a-number", 174), null);
});

test("place columns are written and read on the Supabase row", () => {
  assert.ok(/locality: text\(course && course\.locality/.test(mapsSrc), "row write must include locality");
  assert.ok(/country_code: text\(course && course\.countryCode/.test(mapsSrc), "row write must include country_code");
  assert.ok(/locality: text\(row\.locality/.test(mapsSrc), "row read must include locality");
  assert.ok(/select=[^"]*country_code/.test(mapsSrc), "the read query must select the place columns");
});

test("a publish resolves the place when the client did not send one", () => {
  assert.ok(/await ensureCoursePlace\(course\)/.test(mapsSrc), "publish must fill in a missing place");
  const fn = mapsSrc.slice(mapsSrc.indexOf("async function ensureCoursePlace"));
  assert.ok(
    /if \(!course \|\| course\.countryCode \|\| course\.country\) return course;/.test(fn),
    "a place the client already sent must not be re-fetched"
  );
  assert.ok(
    /if \(!place\) return course;/.test(fn),
    "a geocoder failure must not fail the publish"
  );
});

test("the migration adds nullable columns and leaves existing rows alone", () => {
  const sql = fs.readFileSync(MIGRATION, "utf8");
  ["locality", "country", "country_code"].forEach(function (column) {
    assert.ok(
      new RegExp("add column if not exists " + column + " text").test(sql),
      "missing column: " + column
    );
  });
  assert.ok(!/not null/i.test(sql), "place columns must be nullable - unknown is a real state");
  assert.ok(!/drop |delete |update /i.test(sql), "the migration must not touch existing data");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("course-place failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("course-place passed: " + tests.length + " checks");
})();
