/* The scorecard editor's two shapes (functions/lib/gd-scorecard-edit-core.mjs): a stored card
 * laid out as rows - Par, SI, a row a tee - and back, checked.
 *
 * Run: node dev/scorecard-edit-core.test.js */

const assert = require("assert");
const path = require("path");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

(async () => {
  const core = await import(path.join(__dirname, "..", "functions", "lib", "gd-scorecard-edit-core.mjs"));

  const PORTSALON = [
    { hole: 1, par: 4, index: 2, metres: 320, tees: { White: { metres: 325 }, Yellow: { metres: 320 }, Red: { metres: 267 } } },
    { hole: 2, par: 3, index: 1, metres: 150, tees: { White: { metres: 160 }, Yellow: { metres: 150 }, Red: { metres: 120 } } }
  ];

  test("a card with tees opens as one row a tee, in the card's order", () => {
    const card = core.editorCard(PORTSALON);
    assert.deepStrictEqual(card.tees, ["White", "Yellow", "Red"]);
    assert.deepStrictEqual(card.holes[0], { hole: 1, par: 4, index: 2, distances: [325, 320, 267] });
  });

  test("a card of par and plain distances has one unnamed distance row, and no SI", () => {
    const card = core.editorCard([{ hole: 1, par: 4, metres: 300 }, { hole: 2, par: 5, metres: 450 }]);
    assert.deepStrictEqual(card.tees, [""]);
    assert.deepStrictEqual(card.holes.map(h => [h.index, h.distances[0]]), [[null, 300], [null, 450]]);
    const back = core.storedHoles(card);
    assert.deepStrictEqual(back.holes, [{ hole: 1, par: 4, index: null, metres: 300 }, { hole: 2, par: 5, index: null, metres: 450 }], "it saves back as plain metres, as it came");
  });

  test("a par-only card has no distance rows at all", () => {
    assert.deepStrictEqual(core.editorCard([{ hole: 1, par: 3 }]).tees, []);
  });

  test("round trip: what opens saves back the same, the first tee's distance as the main one", () => {
    const back = core.storedHoles(core.editorCard(PORTSALON));
    assert.strictEqual(back.holes[0].metres, 325);
    assert.deepStrictEqual(back.holes[0].tees, { White: { metres: 325 }, Yellow: { metres: 320 }, Red: { metres: 267 } });
  });

  test("what is wrong is said, not saved", () => {
    const ok = core.editorCard(PORTSALON);
    const bad = (mutate) => { const c = JSON.parse(JSON.stringify(ok)); mutate(c); return core.storedHoles(c).error; };
    assert.match(bad(c => { c.holes[1].par = 7; }), /par of 3 to 6/);
    assert.match(bad(c => { c.holes[1].index = 2; }), /used twice/);
    assert.match(bad(c => { c.holes[1].hole = 3; }), /run 1 to 2/);
    assert.match(bad(c => { c.tees[1] = "white"; }), /both called/);
    assert.match(bad(c => { c.holes[0].distances[0] = 1200; }), /not a hole length/);
    assert.match(bad(c => { c.tees[0] = ""; }), /every tee a name/);
    assert.match(core.storedHoles({ tees: [], holes: [] }).error, /no holes/);
  });

  let failed = 0;
  for (const t of tests) {
    try { t.fn(); console.log("  ok  " + t.name); }
    catch (error) { failed++; console.error("  FAIL  " + t.name + "\n        " + (error && error.message)); }
  }
  if (failed) { console.error("scorecard-edit-core FAILED: " + failed + " of " + tests.length); process.exit(1); }
  console.log("scorecard-edit-core passed: " + tests.length + " checks");
})().catch(error => { console.error(error); process.exit(1); });
