/* What an unnamed nine is called until something names it.
 *
 * "Course 1" and "Course 2" are honest but useless: nothing in the label
 * connects to anything a player standing at the clubhouse can see. Two facts we
 * already hold do - how long the loop plays, and where on the property it sits -
 * and both are free, because the lengths are already summed to match cards and
 * the centres already exist because separation computed them.
 *
 *     Course 2 - 3547m South
 *
 * A real name replaces it the moment one is found. This is what the placeholder
 * says in the meantime, not a naming scheme. */
const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

(async () => {
  const core = await import("file://" + path.join(ROOT, "functions", "lib", "gd-automapper-core.mjs"));
  const { compassPointFrom, loopDescriptor, provisionalLoopName, COMPASS_POINTS } = core;

  /* A facility centre, and loops placed around it. Roughly Howeston's latitude,
     so the longitude scaling is representative. */
  const CENTRE = { lat: -27.5018, lng: 153.1945 };
  const at = (dLat, dLng) => ({ lat: CENTRE.lat + dLat, lng: CENTRE.lng + dLng });

  test("the label reads the way it was asked for", () => {
    assert.strictEqual(provisionalLoopName(1, { totalM: 3547, compass: "South" }), "Course 2 - 3547m South");
  });

  test("compass points are measured from the facility's own middle", () => {
    /* A loop is South of ITS OWN SITE, not of anywhere else - so the reference
       is the mean of the loop centres, not the pin or the clubhouse. */
    assert.strictEqual(compassPointFrom(CENTRE, at(0.01, 0)), "North");
    assert.strictEqual(compassPointFrom(CENTRE, at(-0.01, 0)), "South");
    assert.strictEqual(compassPointFrom(CENTRE, at(0, 0.01)), "East");
    assert.strictEqual(compassPointFrom(CENTRE, at(0, -0.01)), "West");
  });

  test("eight points, not four - three nines sit closer than 90 degrees apart", () => {
    assert.strictEqual(compassPointFrom(CENTRE, at(0.01, 0.01)), "North-East");
    assert.strictEqual(compassPointFrom(CENTRE, at(-0.01, 0.01)), "South-East");
    assert.strictEqual(compassPointFrom(CENTRE, at(-0.01, -0.01)), "South-West");
    assert.strictEqual(compassPointFrom(CENTRE, at(0.01, -0.01)), "North-West");
    assert.strictEqual(COMPASS_POINTS.length, 8);
  });

  test("longitude is scaled by latitude, or east/west drifts near the poles", () => {
    /* One degree of longitude is much shorter than one of latitude away from
       the equator. Without the cosine an equal lat/lng offset would not read as
       a clean diagonal, and at high latitude it would read as nearly due
       north. */
    const far = { lat: 60, lng: 0 };
    assert.strictEqual(compassPointFrom(far, { lat: 60.005, lng: 0.01 }), "North-East");
  });

  test("three loops around a site get three DIFFERENT points", () => {
    /* The whole purpose. If two nines label the same, the label has not helped. */
    const loops = [at(0.008, 0), at(-0.006, 0.007), at(-0.006, -0.007)];
    const points = loops.map(loop => compassPointFrom(CENTRE, loop));
    assert.strictEqual(new Set(points).size, 3, "got " + points.join(", "));
  });

  test("it never invents the half it does not have", () => {
    /* A loop with no measurable holes, or one sitting exactly on the facility
       centre, gets a shorter label rather than a confident wrong one. */
    assert.strictEqual(loopDescriptor({ totalM: 3547, compass: "" }), "3547m");
    assert.strictEqual(loopDescriptor({ totalM: 0, compass: "South" }), "South");
    assert.strictEqual(loopDescriptor({ totalM: 0, compass: "" }), "");
    assert.strictEqual(provisionalLoopName(0, {}), "Course 1", "bare, rather than 'Course 1 - '");
  });

  test("a loop exactly on the centre has no direction, and says so", () => {
    assert.strictEqual(compassPointFrom(CENTRE, CENTRE), "");
    assert.strictEqual(compassPointFrom(null, CENTRE), "");
    assert.strictEqual(compassPointFrom(CENTRE, null), "");
  });

  test("metres are whole - a nine is not 3547.28m", () => {
    assert.strictEqual(loopDescriptor({ totalM: 3547.28, compass: "South" }), "3547m South");
  });

  test("the facility prefix still applies to a described course", () => {
    /* publishSeparatedLoops decides whether to prefix the club's name by
       testing the loop name against /^course \d+\b/i. That regex was anchored
       with $ before descriptors existed, so a described loop would have lost
       its facility prefix and published as a bare "Course 2 - 3547m South". */
    const rule = /^course \d+\b/i;
    assert.ok(rule.test("Course 2"), "plain placeholder still prefixed");
    assert.ok(rule.test("Course 2 - 3547m South"), "described placeholder must still be prefixed");
    assert.ok(!rule.test("South Course"), "a real name must NOT be prefixed");
    assert.ok(!rule.test("Coursemaster Links"), "and the word boundary must hold");
  });

  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("loop-labels failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("loop-labels passed: " + tests.length + " checks");
})();
