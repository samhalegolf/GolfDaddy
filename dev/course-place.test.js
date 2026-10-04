/* Region and country on a course.
 *
 * The subtitle exists to tell two clubs with the same name apart, so the
 * things worth guarding are: that a place is only claimed when it is actually
 * known, that the client and the server read the geocoder the same way (two
 * copies of the region-key list would drift into two different subtitles for
 * the same course), and that a course with no place renders no subtitle
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

/* The picker no longer reads Nominatim itself - /api/course-search does, through
   gd-course-place.mjs - so only its label survives on the client. */
const picker = loadPickerFns(
  "function placeLabel(course)",
  "function distance(a,b)",
  ["placeLabel"]
);

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test("a Nominatim address becomes a region and a country", async () => {
  const server = await import("../functions/lib/gd-course-place.mjs");
  const place = server.placeFromAddress({
    state: "Auckland",
    country: "New Zealand",
    country_code: "nz"
  });
  assert.deepStrictEqual(place, { region: "Auckland", country: "New Zealand", countryCode: "NZ" });
});

test("the state beats the settlement fields", async () => {
  const server = await import("../functions/lib/gd-course-place.mjs");
  /* The whole reason this is region rather than town. These are the real
     values Nominatim returned for Takapuna Golf Course: the council name is
     accurate and useless, the state is what a player recognises. */
  const place = server.placeFromAddress({
    city: "Kaipatiki",
    state: "Auckland",
    country: "New Zealand",
    country_code: "nz"
  });
  assert.strictEqual(place.region, "Auckland");
  assert.strictEqual(picker.placeLabel(place), "Auckland, New Zealand");
});

test("a place with no state falls back to a settlement", async () => {
  const server = await import("../functions/lib/gd-course-place.mjs");
  /* City-states have no state field. Something recognisable still beats an
     empty subtitle. */
  const place = server.placeFromAddress({ city: "Singapore", country: "Singapore", country_code: "sg" });
  assert.strictEqual(picker.placeLabel(place), "Singapore, Singapore");
});

test("an address with no country is not a place", async () => {
  const server = await import("../functions/lib/gd-course-place.mjs");
  assert.strictEqual(server.placeFromAddress({ city: "Nowhere" }), null);
  assert.strictEqual(server.placeFromAddress(null), null);
  assert.strictEqual(server.placeFromAddress("Auckland"), null);
});

test("a country with no region labels as the country alone", () => {
  assert.strictEqual(
    picker.placeLabel({ region: "", country: "United Kingdom", countryCode: "GB" }),
    "United Kingdom"
  );
});

test("a course with no place renders no subtitle, not a stray separator", () => {
  assert.strictEqual(picker.placeLabel({}), "");
  assert.strictEqual(picker.placeLabel(null), "");
  assert.ok(!picker.placeLabel({ name: "Akarana Golf Club" }).includes(","));
});

test("the country code carries a course geocoded before names were stored", () => {
  assert.strictEqual(picker.placeLabel({ region: "Victoria", countryCode: "au" }), "Victoria, AU");
});

test("course search reads the geocoder through the one shared copy", () => {
  /* A second copy of the region-key list would quietly produce two different
     subtitles for the same course depending on which path filled it in. */
  const core = fs.readFileSync(path.join(ROOT, "functions", "lib", "gd-course-search-core.mjs"), "utf8");
  assert.ok(/import \{ placeFromAddress \} from "\.\/gd-course-place\.mjs"/.test(core), "course search must use gd-course-place.mjs");
  assert.ok(!/REGION_KEYS/.test(core) && !/PLACE_REGION_KEYS/.test(pickerSrc), "no second copy of the region keys");
  assert.strictEqual(serverSrc.slice(serverSrc.indexOf("const REGION_KEYS")).match(/"([a-z_]+)"/)[1], "state", "state is the intended answer, not a fallback");
});

test("the server labels a place the same way the picker does", async () => {
  const server = await import("../functions/lib/gd-course-place.mjs");
  [
    { region: "Auckland", country: "New Zealand", countryCode: "NZ" },
    { region: "", country: "United Kingdom", countryCode: "GB" },
    { region: "Victoria", country: "", countryCode: "AU" },
    {}
  ].forEach(function (place) {
    assert.strictEqual(server.placeLabel(place), picker.placeLabel(place));
  });
});

test("the server accepts place fields under any spelling a caller uses", async () => {
  const server = await import("../functions/lib/gd-course-place.mjs");
  assert.deepStrictEqual(
    server.placeFromCourse({ region: "Auckland", country: "New Zealand", country_code: "nz" }),
    { region: "Auckland", country: "New Zealand", countryCode: "NZ" }
  );
  assert.deepStrictEqual(
    server.placeFromCourse({ courseRegion: "New South Wales", courseCountry: "Australia", countryCode: "AU" }),
    { region: "New South Wales", country: "Australia", countryCode: "AU" }
  );
  assert.strictEqual(server.placeFromCourse({ courseName: "Akarana" }), null);
});

test("the reverse lookup pins language and detail level", () => {
  /* Without accept-language the country comes back as "New Zealand / Aotearoa";
     zoom=10 is where the state field is reliably populated. Both were found by
     running this against the real database, so both are load-bearing. */
  assert.ok(/accept-language=en/.test(serverSrc), "country name must not vary by locale");
  assert.ok(/zoom=10/.test(serverSrc), "detail level must be the one state is populated at");
});

test("a bad coordinate never reaches the geocoder", async () => {
  const server = await import("../functions/lib/gd-course-place.mjs");
  assert.strictEqual(await server.reverseGeocodePlace(null, null), null);
  assert.strictEqual(await server.reverseGeocodePlace("not-a-number", 174), null);
});

test("place columns are written and read on the Supabase row", () => {
  assert.ok(/region: text\(course && course\.region/.test(mapsSrc), "row write must include region");
  assert.ok(/country_code: text\(course && course\.countryCode/.test(mapsSrc), "row write must include country_code");
  assert.ok(/region: text\(row\.region/.test(mapsSrc), "row read must include region");
  /* The reads select a named column list (FULL_COLUMNS / LIST_COLUMNS), not an inline string. */
  assert.ok(/const FULL_COLUMNS = [^;]*country_code/.test(mapsSrc) && /select=" \+ FULL_COLUMNS/.test(mapsSrc), "the read query must select the place columns");
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
  ["region", "country", "country_code"].forEach(function (column) {
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
