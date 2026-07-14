const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadResolver() {
  const code = fs.readFileSync(path.join(__dirname, "..", "scripts", "gd-course-geometry-resolver.js"), "utf8");
  const context = {
    console,
    window: {},
    localStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {}
    }
  };
  context.window.window = context.window;
  context.window.localStorage = context.localStorage;
  vm.runInNewContext(code, context, { filename: "gd-course-geometry-resolver.js" });
  return context.window.GDCourseGeometryResolver;
}

function point(lat, lng) {
  return { lat, lon: lng };
}

function lineElement(id, startLat, startLng, lengthM) {
  const dLat = lengthM / 111320;
  return {
    type: "way",
    id,
    tags: { golf: "hole" },
    geometry: [
      point(startLat, startLng),
      point(startLat + dLat, startLng)
    ]
  };
}

function greenElement(id, centerLat, centerLng) {
  const radiusM = 14;
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos(centerLat * Math.PI / 180));
  return {
    type: "way",
    id,
    tags: { golf: "green" },
    geometry: [
      point(centerLat - dLat, centerLng - dLng),
      point(centerLat - dLat, centerLng + dLng),
      point(centerLat + dLat, centerLng + dLng),
      point(centerLat + dLat, centerLng - dLng),
      point(centerLat - dLat, centerLng - dLng)
    ]
  };
}

async function main() {
  const resolver = loadResolver();
  assert(resolver, "resolver exported");

  const baseLat = -36.9;
  const baseLng = 174.75;
  const elements = [
    lineElement(101, baseLat, baseLng, 100),
    greenElement(201, baseLat + 100 / 111320, baseLng),
    lineElement(102, baseLat, baseLng + 0.004, 300),
    greenElement(202, baseLat + 300 / 111320, baseLng + 0.004),
    lineElement(103, baseLat, baseLng + 0.008, 500),
    greenElement(203, baseLat + 500 / 111320, baseLng + 0.008)
  ];

  assert.strictEqual(resolver.shouldRunForAutoMapper({
    osmPayload: { elements },
    guideBundle: { guides: [] },
    expectedHoleCount: 3
  }), true, "runs when OSM hole refs are missing");

  const labelled = JSON.parse(JSON.stringify(elements));
  labelled.filter((el) => el.tags.golf === "hole").forEach((el, index) => {
    el.tags.ref = String(index + 1);
  });
  assert.strictEqual(resolver.shouldRunForAutoMapper({
    osmPayload: { elements: labelled },
    guideBundle: { guides: [{ hole: 1 }, { hole: 2 }, { hole: 3 }] },
    expectedHoleCount: 3
  }), false, "does not run when AutoMapper already has numbered guides");

  const result = await resolver.resolveCourseGeometryForAutoMapper({
    course: { courseId: "resolver-test", courseName: "Resolver Test Course", courseLat: baseLat, courseLng: baseLng },
    osmPayload: { elements },
    expectedHoleCount: 3,
    scorecardHoles: [
      { holeNumber: 1, par: 5, distanceM: 500 },
      { holeNumber: 2, par: 3, distanceM: 100 },
      { holeNumber: 3, par: 4, distanceM: 300 }
    ]
  });

  assert.strictEqual(result.status, "resolved");
  assert(result.confidence >= resolver.highConfidence, "resolved confidence is high enough");
  assert.strictEqual(
    JSON.stringify(result.holes.map((hole) => [hole.holeNumber, hole.candidate.candidateId])),
    JSON.stringify([
      [1, "way-103"],
      [2, "way-101"],
      [3, "way-102"]
    ]),
    "global assignment follows scorecard distances rather than raw OSM order"
  );
  assert(result.analysisBoundary.length >= 3, "debug boundary is returned");
  assert(result.debugEvidence.greenCandidates.length === 3, "green evidence is returned");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
