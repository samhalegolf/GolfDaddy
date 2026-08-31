/* Listing-led vs geometry-led multi-course resolution.
 *
 * The Millbrook case, as a regression fixture rather than as production logic.
 *
 * A scan started from the individual listing "Millbrook - Remarkables 18"
 * captured the intended eighteen AND enough of the rest of the resort's golf
 * geometry to trip the multi-course detector. The mapper then set about
 * interpreting the ground itself and produced several separated candidates,
 * including short fragments - when the search result it was handed had already
 * said which course was wanted.
 *
 * Two rules, and they are deliberately opposites:
 *
 *   a course backed by a real listing may duplicate another listing's geometry.
 *   The listing is the identity. Scanning the same ground twice is cheap.
 *
 *   a course the MAPPER inferred may not, because unique physical-hole
 *   allocation is part of the evidence that it is a separate course at all.
 *
 * Run: node dev/listing-led-resolution.test.js */

const assert = require("assert");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const REMARKABLES = { lat: -45.0300, lng: 168.8100 };
const CORONET = { lat: -45.0380, lng: 168.8200 };
const ARROW = { lat: -45.0450, lng: 168.8300 };

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function holeWay(id, number, origin, step) {
  const start = { lat: origin.lat + step * 0.0004, lng: origin.lng + step * 0.0004 };
  const end = { lat: start.lat + 0.0012, lng: start.lng + 0.0009 };
  return {
    type: "way", id, tags: { golf: "hole", ref: String(number) },
    geometry: [start, { lat: (start.lat + end.lat) / 2, lng: (start.lng + end.lng) / 2 }, end]
  };
}

function ringAround(origin) {
  return [
    { lat: origin.lat - 0.002, lng: origin.lng - 0.002 },
    { lat: origin.lat + 0.009, lng: origin.lng - 0.002 },
    { lat: origin.lat + 0.009, lng: origin.lng + 0.009 },
    { lat: origin.lat - 0.002, lng: origin.lng + 0.009 },
    { lat: origin.lat - 0.002, lng: origin.lng - 0.002 }
  ];
}

/* Three 18s on one resort, each numbered 1-18. With `named`, OSM carries a
   course polygon per course - which is what the course search itself reads, so
   those polygons ARE the individual listings. Without it there is one outline
   over the lot and nothing has named anything. */
function millbrook({ named }) {
  const elements = [];
  [REMARKABLES, CORONET, ARROW].forEach((origin, course) => {
    for (let n = 1; n <= 18; n++) elements.push(holeWay(1000 * (course + 1) + n, n, origin, n));
  });
  if (named) {
    elements.push({ type: "way", id: 9001, tags: { golf: "course", name: "Remarkables 18", holes: 18 }, geometry: ringAround(REMARKABLES) });
    elements.push({ type: "way", id: 9002, tags: { golf: "course", name: "Coronet 18", holes: 18 }, geometry: ringAround(CORONET) });
    elements.push({ type: "way", id: 9003, tags: { golf: "course", name: "Arrow 18", holes: 18 }, geometry: ringAround(ARROW) });
  } else {
    elements.push({ type: "way", id: 9004, tags: { leisure: "golf_course", name: "Millbrook Resort" }, geometry: ringAround(REMARKABLES).concat(ringAround(ARROW)) });
  }
  return { elements };
}

(async () => {
  const core = await import("file://" + path.join(ROOT, "functions", "lib", "gd-automapper-core.mjs"));
  const listing = await import("file://" + path.join(ROOT, "functions", "lib", "gd-course-listing-core.mjs"));
  const claims = await import("file://" + path.join(ROOT, "functions", "lib", "gd-inferred-course-claims-core.mjs"));
  const { RESOLUTION_MODE } = listing;

  /* ---------- does the name of a search result say "course" or "place"? ---- */

  test("a name carrying a course label is an individual course listing", () => {
    assert.strictEqual(listing.courseLabelOf("Millbrook - Remarkables 18"), "Remarkables 18");
    assert.strictEqual(listing.courseLabelOf("Te Arai Links Golf Club - North Course"), "North Course");
    assert.strictEqual(listing.courseLabelOf("Taupo Golf Club (Par 3)"), "Par 3");
    assert.strictEqual(listing.listingKindOf("Millbrook - Remarkables 18"), "individual-course");
  });

  test("a place name is not turned into a course label by a dash", () => {
    /* splitCourseName's own case: one course's name, not a facility and a loop.
       Reading "Taupo" as a course label would suppress a real facility's real
       siblings, which is the more expensive mistake of the two. */
    assert.strictEqual(listing.courseLabelOf("Wairakei - Taupo"), "");
    assert.strictEqual(listing.courseLabelOf("Millbrook Resort"), "");
    assert.strictEqual(listing.courseLabelOf("Te Arai Links"), "");
    assert.strictEqual(listing.listingKindOf("Millbrook Resort"), "general-facility");
  });

  /* ---------- the listings are read back off the ground, not invented ------ */

  test("named course polygons on the site ARE the individual listings", () => {
    const loops = core.separateLoops(millbrook({ named: true }), REMARKABLES);
    assert.strictEqual(loops.length, 3, "three courses separate");
    assert.ok(loops.every(loop => loop.method === "containment"));
    const listings = listing.listingsFromLoops(loops, { facilityName: "Millbrook Resort" });
    assert.deepStrictEqual(listings.map(entry => entry.name).sort(), ["Arrow 18", "Coronet 18", "Remarkables 18"]);
    assert.ok(listings.every(entry => entry.osmRef), "each child keeps the listing's own stable identity");
  });

  test("a loop the mapper chained together itself is not a listing", () => {
    const loops = core.separateLoops(millbrook({ named: false }), REMARKABLES);
    assert.ok(loops.every(loop => loop.method === "routing"), "nothing on the ground separated these");
    assert.deepStrictEqual(listing.listingsFromLoops(loops, { facilityName: "Millbrook Resort" }), [],
      "routing is the mapper inferring courses - it may not then cite itself as a listing");
  });

  test("the site-wide outline is the parent, never one of the children", () => {
    const loops = [
      { method: "containment", name: "Millbrook Resort", osmRef: "way/1", holeNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
      { method: "containment", name: "Remarkables 18", osmRef: "way/2", holeNumbers: Array.from({ length: 18 }, (_, i) => i + 1) }
    ];
    assert.deepStrictEqual(
      listing.listingsFromLoops(loops, { facilityName: "Millbrook Resort" }).map(entry => entry.name),
      ["Remarkables 18"]);
  });

  /* ---------- which listing was the scan started from? -------------------- */

  test("the selection is matched on the words that tell the listings apart", () => {
    const listings = [
      { name: "Remarkables 18", osmRef: "way/9001", holes: 18, loopIndex: 0 },
      { name: "Coronet 18", osmRef: "way/9002", holes: 18, loopIndex: 1 },
      { name: "Arrow 18", osmRef: "way/9003", holes: 18, loopIndex: 2 }
    ];
    /* "millbrook" and "18" say nothing about WHICH course; "remarkables" does,
       and it needs no word list to know that - the facility's own listings say
       which of their words are shared. */
    assert.deepStrictEqual([...listing.distinguishingTokens(listings)].sort(), ["arrow", "coronet", "remarkables"]);
    assert.strictEqual(listing.matchSelectionToListing("Millbrook - Remarkables 18", listings).name, "Remarkables 18");
    assert.strictEqual(listing.matchSelectionToListing("Millbrook Resort", listings), null,
      "a selection carrying no distinguishing word named the place");
    assert.strictEqual(listing.matchSelectionToListing("Coronet and Arrow", listings), null,
      "and two answers is not an answer - the multi-course branches are the safe direction");
  });

  /* ---------- the router ------------------------------------------------- */

  test("MILLBROOK: an individual listing is trusted, not reinterpreted", () => {
    const loops = core.separateLoops(millbrook({ named: true }), REMARKABLES);
    const plan = listing.planListingResolution({ courseName: "Millbrook - Remarkables 18", loops });
    assert.strictEqual(plan.mode, RESOLUTION_MODE.SINGLE_LISTING);
    assert.strictEqual(plan.selectedListing.name, "Remarkables 18");
    assert.strictEqual(loops[plan.scopedLoopIndex].name, "Remarkables 18",
      "the run maps the course the player chose, and the rest of the resort belongs to other listings");
  });

  test("MILLBROOK: the general facility routes to the listings on its ground", () => {
    const loops = core.separateLoops(millbrook({ named: true }), REMARKABLES);
    const plan = listing.planListingResolution({ courseName: "Millbrook Resort", loops });
    assert.strictEqual(plan.mode, RESOLUTION_MODE.LISTING_LED);
    assert.strictEqual(plan.parentListing, "Millbrook Resort");
    assert.deepStrictEqual(plan.childListings.map(child => child.name).sort(), ["Arrow 18", "Coronet 18", "Remarkables 18"]);
    assert.strictEqual(plan.scopedLoopIndex, null, "nothing is scoped away - every child is mapped");
  });

  test("an individual listing with nothing to separate it still maps ONE course", () => {
    /* No polygons, so no listings to match against - but the player still
       picked a course rather than a place, and manufacturing Course 1 / Course 2
       / a three-hole Course 3 under that name is the failure this exists to
       stop. The pinned loop is the ground the chosen listing sits on. */
    const loops = core.separateLoops(millbrook({ named: false }), REMARKABLES);
    const plan = listing.planListingResolution({ courseName: "Millbrook - Remarkables 18", loops });
    assert.strictEqual(plan.mode, RESOLUTION_MODE.SINGLE_LISTING);
    assert.strictEqual(plan.scopedLoopIndex, 0, "the loop nearest the pin the listing supplied");
  });

  test("TE ARAI: a facility nothing has named still falls to the geometry resolver", () => {
    const loops = core.separateLoops(millbrook({ named: false }), REMARKABLES);
    const plan = listing.planListingResolution({ courseName: "Te Arai Links", loops });
    assert.strictEqual(plan.mode, RESOLUTION_MODE.GEOMETRY_LED);
    assert.strictEqual(plan.reason, "no-credible-individual-course-listings");
    assert.deepStrictEqual(plan.childListings, [], "nothing named these courses, so nothing may be cited as having");
  });

  /* ---------- elimination, and ONLY on the geometry-led path -------------- */

  function candidate(index, name, numbers, idPrefix) {
    return {
      index, name,
      contiguous: numbers[0] === 1 && numbers[numbers.length - 1] === numbers.length,
      holes: numbers.map(number => ({ number, id: (idPrefix || name) + "/" + number }))
    };
  }

  test("a 1,2,18 candidate is unresolved ground, not a sibling course", () => {
    const full = Array.from({ length: 18 }, (_, i) => i + 1);
    const result = claims.eliminateInferredCourses([
      candidate(0, "Course 1", full, "a"),
      candidate(1, "Course 2", [1, 2, 18], "b")
    ]);
    assert.deepStrictEqual(result.courses.map(entry => entry.name), ["Course 1"]);
    assert.strictEqual(result.withheld.length, 1);
    assert.strictEqual(result.withheld[0].verdict.reason, "fewer-than-9-holes-of-its-own");
    assert.strictEqual(result.ledger.unexplainedHoles, 3,
      "the fragment's ground is outstanding, not discarded - a facility waiting on evidence");
  });

  test("a clipped scan of a real course is NOT a fragment", () => {
    /* Te Arai's North came out of separation holding 16 of its 18. Withholding
       that would cost a player a whole course over two missing holes. */
    const clipped = Array.from({ length: 18 }, (_, i) => i + 1).filter(n => n !== 5 && n !== 12);
    const result = claims.eliminateInferredCourses([candidate(0, "North", clipped, "n")]);
    assert.strictEqual(result.courses.length, 1);
    assert.ok(claims.holeNumberDensity(clipped) > claims.MIN_HOLE_NUMBER_DENSITY);
  });

  test("an inferred course built on ground another already claimed is refused", () => {
    const full = Array.from({ length: 18 }, (_, i) => i + 1);
    /* Same physical holes, walked in another order. Two courses cannot both be
       right about one piece of ground when it is US deciding they are two. */
    const result = claims.eliminateInferredCourses([
      candidate(0, "Course 1", full, "shared"),
      candidate(1, "Course 2", full, "shared")
    ]);
    assert.deepStrictEqual(result.courses.map(entry => entry.name), ["Course 1"]);
    assert.strictEqual(result.withheld[0].verdict.reason, "mostly-ground-another-course-already-claimed");
    assert.strictEqual(result.ledger.reusedHoles, 18);
  });

  test("two courses on genuinely separate ground both survive", () => {
    const full = Array.from({ length: 18 }, (_, i) => i + 1);
    const result = claims.eliminateInferredCourses([
      candidate(0, "Course 1", full, "north"),
      candidate(1, "Course 2", full, "south")
    ]);
    assert.strictEqual(result.courses.length, 2, "both numbered 1-18, neither sharing a hole");
    assert.strictEqual(result.ledger.reusedHoles, 0);
    assert.deepStrictEqual(result.courses.map(entry => entry.index), [0, 1],
      "and they come back in the separation's own order, pinned loop first");
  });

  test("the strongest candidate claims first, whatever order they arrive in", () => {
    const full = Array.from({ length: 18 }, (_, i) => i + 1);
    const result = claims.eliminateInferredCourses([
      candidate(0, "Fragment", [1, 2, 18], "shared"),
      candidate(1, "Whole", full, "shared")
    ]);
    assert.deepStrictEqual(result.courses.map(entry => entry.name), ["Whole"],
      "elimination order is strength, not arrival - otherwise a fragment claims ground first and the course looks like the duplicate");
  });

  /* ---------- and the two attitudes stay separate in the code ------------- */

  test("elimination is reachable only from the geometry-led branch", () => {
    const fs = require("fs");
    const src = fs.readFileSync(path.join(ROOT, "functions", "course-mapper-worker-background.mjs"), "utf8");
    const geometryLed = src.indexOf("plan.mode === RESOLUTION_MODE.GEOMETRY_LED");
    const eliminate = src.indexOf("eliminateInferredCourses(");
    assert.notStrictEqual(geometryLed, -1, "the worker must branch on the mode, not on a generic multiCourse flag");
    assert.notStrictEqual(eliminate, -1);
    assert.ok(geometryLed < eliminate,
      "listing-backed children must never be judged by unique-hole allocation - duplicate geometry is legitimate there");
    assert.notStrictEqual(src.indexOf("resolutionMode: resolution.mode"), -1,
      "and the reason several courses were created is on the result, not left to be inferred");
  });

  test("nothing global forbids two course records from sharing geometry", () => {
    const fs = require("fs");
    const guard = fs.readFileSync(path.join(ROOT, "functions", "lib", "gd-duplicate-course-guard.mjs"), "utf8");
    /* The duplicate guard matches on IDENTITY - facility plus course label - and
       never on geometry. Two legitimate listings resolving to the same eighteen
       must both be mappable; deciding they are one identity risks routing a
       player to the wrong course payload, which is the worse failure. */
    assert.notStrictEqual(guard.indexOf("classifyCourseRelationship"), -1,
      "the guard's verdict comes from identity");
    assert.ok(!/claimOverlap|sharedHoles|sameGeometry|geometryMatch/.test(guard),
      "and never from comparing one row's holes against another's");
    assert.strictEqual(core.classifyCourseRelationship(
      { courseName: "Millbrook Golf Club - Remarkables" },
      { courseName: "Millbrook Golf Club - Coronet" }
    ), "sibling", "two named courses at one facility are both mapped, never merged");
  });

  let failures = 0;
  for (const entry of tests) {
    try { await entry.fn(); console.log("  ok  " + entry.name); }
    catch (error) { failures += 1; console.error("  FAIL  " + entry.name + "\n        " + (error && error.message)); }
  }
  if (failures) { console.error("listing-led-resolution FAILED: " + failures + " of " + tests.length); process.exit(1); }
  console.log("listing-led-resolution passed: " + tests.length + " checks");
})().catch(error => { console.error(error); process.exit(1); });
