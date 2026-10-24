/* Course ids fold accents instead of eating the accented letter: "Ngāruawāhia Golf Club"
 * is "ngaruawahia-golf-club", not "ng-ruawahia-golf-club". The server slug
 * (functions/lib/gd-course-slug.mjs) mints the ids and the app's courseKey()
 * (app/js/course-key.js) looks them up, so the two must agree. A phone that saved
 * scores under an old mangled id gets them moved to the new one.
 *
 * Run: node dev/course-slug.test.js */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { courseKey } = require("../app/js/course-key.js");

(async () => {
  const { courseSlug } = await import("../functions/lib/gd-course-slug.mjs");

  const cases = {
    "Ngāruawahia Golf Club": "ngaruawahia-golf-club",
    "Ngāhinapōuri Golf Course": "ngahinapouri-golf-course",
    "Ōtaki Golf Club": "otaki-golf-club",
    "Waitematā Golf Club": "waitemata-golf-club",
    "GolfCity Köln Pulheim": "golfcity-koln-pulheim",
    "Te Arai Links": "te-arai-links",
    "Royal Wellington Golf Club": "royal-wellington-golf-club",
    "taki-golf-club": "taki-golf-club"
  };
  for (const [name, id] of Object.entries(cases)) {
    assert.strictEqual(courseSlug(name), id, name);
    assert.strictEqual(courseKey(name), id, "app agrees: " + name);
  }
  /* The same name typed with a precomposed ā or with a + combining macron is one course. */
  assert.strictEqual(courseSlug("Ngāruawahia"), courseSlug("Ngāruawahia"));
  assert.strictEqual(courseSlug(""), "");
  assert.strictEqual(courseKey(""), "course");

  /* Scores saved under the old id follow the course to its new one. */
  const SRC = fs.readFileSync(path.join(__dirname, "..", "app", "js", "scorecard.js"), "utf8");
  function phone(saved) {
    const store = { "clarity:scorecard:v1": JSON.stringify(saved) };
    const window = { ClarityApp: { courseKey } };
    const ctx = {
      window,
      document: { getElementById: () => null, addEventListener: () => {} },
      localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
      fetch: async () => ({ ok: true, json: async () => ({ found: false }) }),
      AbortController, setTimeout, clearTimeout, console
    };
    vm.createContext(ctx);
    vm.runInContext(SRC, ctx);
    return { app: window.ClarityApp, saved: () => JSON.parse(store["clarity:scorecard:v1"]) };
  }

  let p = phone({ "ng-ruawahia-golf-club": { 1: 4, 2: 5 }, "other-course": { 1: 3 } });
  await p.app.scorecard.setCourse("ngaruawahia-golf-club", "Ngāruawahia Golf Club");
  assert.deepStrictEqual(p.saved(), { "ngaruawahia-golf-club": { 1: 4, 2: 5 }, "other-course": { 1: 3 } }, "old bucket moves to the new id");

  p = phone({ "ng-ruawahia-golf-club": { 1: 9 }, "ngaruawahia-golf-club": { 1: 4 } });
  await p.app.scorecard.setCourse("ngaruawahia-golf-club", "Ngāruawahia Golf Club");
  assert.deepStrictEqual(p.saved()["ngaruawahia-golf-club"], { 1: 4 }, "scores already under the new id are never overwritten");

  p = phone({ "royal-wellington-golf-club": { 1: 4 } });
  await p.app.scorecard.setCourse("royal-wellington-golf-club", "Royal Wellington Golf Club");
  assert.deepStrictEqual(p.saved(), { "royal-wellington-golf-club": { 1: 4 } }, "a plain name is untouched");

  console.log("course slug tests passed");
})().catch(error => { console.error(error); process.exit(1); });
