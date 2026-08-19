/* The course picker meta line.
 *
 * A course we already hold a map for used to be labelled "database map".
 * Where the map came from is our concern, not the player's - they only need to
 * recognise the course.
 *
 * The branch has to stay even though it emits nothing: removing it would let
 * those courses fall through the else-if chain and get relabelled "search
 * result" or "course result", which is a different change from removing a
 * badge. Ranking still favours them, which is behaviour rather than a label. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PICKER = path.join(ROOT, "scripts", "inline", "gd-course-picker-search-v2.js");
const src = fs.readFileSync(PICKER, "utf8");

/* Run the real metaText against course fixtures. placeLabel comes along with
   it because metaText calls it for the region/country subtitle - lifting metaText
   on its own would throw on the first call instead of testing anything. */
function loadMetaText() {
  const idx = src.indexOf("function metaText(course)");
  assert.notStrictEqual(idx, -1, "metaText must exist");
  const end = src.indexOf("\n  }", idx);
  assert.notStrictEqual(end, -1, "could not bound metaText");
  const placeStart = src.indexOf("function placeLabel(course)");
  assert.notStrictEqual(placeStart, -1, "placeLabel must exist");
  const placeEnd = src.indexOf("\n  }", placeStart);
  assert.notStrictEqual(placeEnd, -1, "could not bound placeLabel");
  // eslint-disable-next-line no-new-func
  return new Function(
    src.slice(placeStart, placeEnd + 4) + "\n" + src.slice(idx, end + 4) + "\nreturn metaText;"
  )();
}

const metaText = loadMetaText();
const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test("a database-backed course shows no source badge", () => {
  assert.strictEqual(metaText({ source: "database-course", name: "Takapuna" }), "");
  assert.strictEqual(metaText({ hasDatabaseMap: true, name: "Takapuna" }), "");
});

test("a database-backed course is not relabelled as something else", () => {
  const meta = metaText({ source: "database-course", name: "Takapuna" });
  ["search result", "course result", "database map"].forEach(function (label) {
    assert.ok(!meta.includes(label), "must not fall through to: " + label);
  });
});

test("distance is still shown for a database course", () => {
  assert.strictEqual(
    metaText({ source: "database-course", distanceM: 850, name: "Takapuna" }),
    "850m away",
    "removing the badge must not remove the useful part of the line"
  );
  assert.strictEqual(metaText({ hasDatabaseMap: true, distanceM: 2400 }), "2.4km away");
});

test("region and country lead the line when they are known", () => {
  assert.strictEqual(
    metaText({ source: "database-course", region: "Auckland", country: "New Zealand", distanceM: 850 }),
    "Auckland, New Zealand · 850m away"
  );
  assert.strictEqual(
    metaText({ source: "remote-search", region: "Scotland", country: "United Kingdom" }),
    "Scotland, United Kingdom · search result"
  );
});

test("a course with no known place is unchanged", () => {
  /* Every case below this line predates the subtitle. None of them may gain a
     leading separator because a place was looked for and not found. */
  assert.strictEqual(metaText({ source: "recent-course", distanceM: 400 }), "400m away · Recent");
  assert.ok(!metaText({ source: "database-course" }).startsWith("·"));
  assert.ok(!metaText({ source: "database-course", country: "" }).startsWith(","));
});

test("other sources keep their labels", () => {
  assert.strictEqual(metaText({ source: "recent-course" }), "Recent");
  assert.strictEqual(metaText({ source: "remote-search" }), "search result");
  assert.strictEqual(metaText({ source: "something-else" }), "course result");
});

test("the phrase is gone from the picker entirely", () => {
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, " "); })
    .replace(/\/\/[^\n]*/g, function (m) { return m.replace(/[^\n]/g, " "); });
  assert.ok(
    !/parts\.push\("database map"\)/.test(codeOnly),
    "the label must not come back"
  );
});

test("database courses are still ranked above other results", () => {
  assert.ok(
    /source==="database-course"\|\|course\.hasDatabaseMap\)score-=12/.test(src),
    "removing the badge must not change which courses surface first"
  );
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("course-picker-meta-label failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("course-picker-meta-label passed: " + tests.length + " checks");
})();
