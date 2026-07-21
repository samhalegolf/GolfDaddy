const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadResolver() {
  const code = fs.readFileSync(path.join(__dirname, "..", "scripts", "gd-course-geometry-resolver.js"), "utf8");
  const events = [];
  const checkpoints = [];
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
  context.window.GDCourseMappingDebug = {
    recordEvent(runId, event) {
      events.push(Object.assign({ runId }, event));
      return event;
    },
    attachCheckpoint(runId, checkpoint) {
      checkpoints.push(Object.assign({ runId }, checkpoint));
      return checkpoint;
    }
  };
  vm.runInNewContext(code, context, { filename: "gd-course-geometry-resolver.js" });
  context.window.GDCourseGeometryResolver._testEvents = events;
  context.window.GDCourseGeometryResolver._testCheckpoints = checkpoints;
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

function fairwayElement(id, startLat, startLng, lengthM) {
  const dLat = lengthM / 111320;
  const dLng = 0.00018;
  return {
    type: "way",
    id,
    tags: { golf: "fairway" },
    geometry: [
      point(startLat, startLng - dLng),
      point(startLat, startLng + dLng),
      point(startLat + dLat, startLng + dLng),
      point(startLat + dLat, startLng - dLng),
      point(startLat, startLng - dLng)
    ]
  };
}

function teeElement(id, centerLat, centerLng) {
  const radiusM = 7;
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos(centerLat * Math.PI / 180));
  return {
    type: "way",
    id,
    tags: { golf: "tee" },
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
    fairwayElement(301, baseLat, baseLng, 100),
    teeElement(401, baseLat, baseLng),
    greenElement(201, baseLat + 100 / 111320, baseLng),
    lineElement(102, baseLat, baseLng + 0.004, 300),
    fairwayElement(302, baseLat, baseLng + 0.004, 300),
    teeElement(402, baseLat, baseLng + 0.004),
    greenElement(202, baseLat + 300 / 111320, baseLng + 0.004),
    lineElement(103, baseLat, baseLng + 0.008, 500),
    fairwayElement(303, baseLat, baseLng + 0.008, 500),
    teeElement(403, baseLat, baseLng + 0.008),
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

  /* The resolver is for shapes-without-numbers ONLY. It used to divert whenever numbering was
     merely imperfect, which was a downgrade rather than a rescue: with no scorecard it refuses
     outright, so a working map got displaced by a stale result. */
  const partiallyLabelled = JSON.parse(JSON.stringify(labelled));
  delete partiallyLabelled.filter((el) => el.tags.golf === "hole")[0].tags.ref;
  assert.strictEqual(resolver.shouldRunForAutoMapper({
    osmPayload: { elements: partiallyLabelled },
    guideBundle: { guides: [] },
    expectedHoleCount: 3
  }), false, "does NOT run when only some holes carry a ref - the AutoMapper numbers those itself");

  const duplicateRefs = JSON.parse(JSON.stringify(labelled));
  duplicateRefs.filter((el) => el.tags.golf === "hole").forEach((el) => { el.tags.ref = "1"; });
  assert.strictEqual(resolver.shouldRunForAutoMapper({
    osmPayload: { elements: duplicateRefs },
    guideBundle: { guides: [] },
    expectedHoleCount: 3
  }), false, "does NOT run on duplicate refs - numbers are exposed, so it is not this resolver's case");

  assert.strictEqual(resolver.shouldRunForAutoMapper({
    osmPayload: { elements: labelled },
    guideBundle: { guides: [{ hole: 1 }] },
    expectedHoleCount: 18
  }), false, "does NOT run just because the guide bundle is short of the expected hole count");

  const shapesOnly = elements.filter((el) => el.tags.golf !== "hole");
  assert.strictEqual(resolver.shouldRunForAutoMapper({
    osmPayload: { elements: shapesOnly },
    guideBundle: { guides: [] },
    expectedHoleCount: 3
  }), true, "still runs for its actual case: shapes present, no hole numbers exposed");

  assert.strictEqual(resolver.shouldRunForAutoMapper({
    osmPayload: { elements: [] },
    guideBundle: { guides: [] },
    expectedHoleCount: 18
  }), false, "does not run without usable geometry");

  const emptySource = await resolver.resolveCourseGeometryForAutoMapper({
    course: { courseId: "resolver-test", courseName: "Resolver Test Course", courseLat: baseLat, courseLng: baseLng },
    osmPayload: { elements: [] },
    expectedHoleCount: 3,
    scorecardHoles: [
      { holeNumber: 1, par: 5, distanceM: 500 },
      { holeNumber: 2, par: 3, distanceM: 100 },
      { holeNumber: 3, par: 4, distanceM: 300 }
    ]
  });
  assert.strictEqual(emptySource.status, "source-load-failed", "empty native input fails as acquisition, not confidence");
  assert.strictEqual(emptySource.sourceLoadError.code, "no-supported-golf-geometry-returned");
  assert.strictEqual(emptySource.checkpoints.length, 0, "empty input does not create fake checkpoints");

  const noScorecard = await resolver.resolveCourseGeometryForAutoMapper({
    course: { courseId: "resolver-test", courseName: "Resolver Test Course", courseLat: baseLat, courseLng: baseLng },
    courseCentre: { lat: baseLat, lng: baseLng },
    mapViewport: { center: { lat: baseLat, lng: baseLng }, zoom: 16, bounds: { south: baseLat - 0.01, west: baseLng - 0.01, north: baseLat + 0.01, east: baseLng + 0.01 } },
    osmPayload: { elements },
    expectedHoleCount: 3
  });
  assert.strictEqual(noScorecard.status, "geometry-resolved-numbering-unavailable", "missing scorecard does not stop geometry loading");
  assert.strictEqual(noScorecard.sourceLoadError, undefined, "missing scorecard is not a source-load error");
  assert(noScorecard.warnings.includes("Scorecard unavailable"), "missing scorecard is reported as a warning");
  assert.strictEqual(noScorecard.holes.length, 0, "resolver does not fabricate hole numbers without scorecard evidence");
  assert.strictEqual(noScorecard.checkpoints.length, 3, "geometry checkpoints remain available without scorecard evidence");
  assert(noScorecard.checkpoints.find((checkpoint) => checkpoint.stage === "initial-snapshot"), "Initial Snapshot is produced without a scorecard");
  assert(noScorecard.checkpoints.find((checkpoint) => checkpoint.stage === "fairway-lines"), "Fairway Lines is produced without a scorecard");
  const noScorecardNumbers = noScorecard.checkpoints.find((checkpoint) => checkpoint.stage === "number-allocation");
  assert.strictEqual(noScorecardNumbers.metadata.status, "unavailable", "Number Allocation clearly reports unavailable");
  assert.strictEqual(noScorecardNumbers.metadata.warning, "Scorecard unavailable", "Number Allocation records the scorecard warning");
  assert.strictEqual(noScorecard.feedback.assignment.resolvedHoles, 0, "Number Allocation leaves resolved count at zero");
  assert.strictEqual(noScorecard.debugEvidence.holeCandidates.length, 3, "candidate centre-lines are constructed without scorecard evidence");
  assert(noScorecard.debugEvidence.holeCandidates.every((candidate) => candidate.evidence.includes("fairway-centreline")), "candidate centre-lines are traced from green-led fairways");
  assert.deepStrictEqual(
    resolver._testCheckpoints.map((checkpoint) => checkpoint.stage),
    ["initial-snapshot", "fairway-lines", "number-allocation"],
    "debug UI receives the real geometry checkpoints"
  );

  const scorecardShellOnly = await resolver.resolveCourseGeometryForAutoMapper({
    course: { courseId: "resolver-test", courseName: "Resolver Test Course", courseLat: baseLat, courseLng: baseLng },
    courseCentre: { lat: baseLat, lng: baseLng },
    mapViewport: { center: { lat: baseLat, lng: baseLng }, zoom: 16, bounds: { south: baseLat - 0.01, west: baseLng - 0.01, north: baseLat + 0.01, east: baseLng + 0.01 } },
    osmPayload: { elements },
    expectedHoleCount: 3,
    scorecardHoles: [
      { holeNumber: 1, par: 5 },
      { holeNumber: 2, par: 3 },
      { holeNumber: 3, par: 4 }
    ]
  });
  assert.strictEqual(scorecardShellOnly.status, "geometry-resolved-numbering-unavailable", "scorecard shell without distances cannot number geometry");
  assert(scorecardShellOnly.warnings.includes("Scorecard distances unavailable"), "missing scorecard distances are explicit");
  assert.strictEqual(scorecardShellOnly.holes.length, 0, "resolver does not fabricate numbers from par-only shells");
  const shellNumbers = scorecardShellOnly.checkpoints.find((checkpoint) => checkpoint.stage === "number-allocation");
  assert.strictEqual(shellNumbers.metadata.status, "unavailable", "par-only scorecard leaves Number Allocation unavailable");
  assert.strictEqual(shellNumbers.metadata.warning, "Scorecard distances unavailable", "Number Allocation reports missing distances");

  const noTaggedFairways = elements.filter((element) => element.tags.golf !== "fairway" && element.tags.golf !== "tee");
  const inferredFairways = await resolver.resolveCourseGeometryForAutoMapper({
    course: { courseId: "resolver-test", courseName: "Resolver Test Course", courseLat: baseLat, courseLng: baseLng },
    courseCentre: { lat: baseLat, lng: baseLng },
    osmPayload: { elements: noTaggedFairways },
    expectedHoleCount: 3
  });
  assert.strictEqual(inferredFairways.status, "geometry-resolved-numbering-unavailable", "missing scorecard still returns geometry-only result without tagged fairways");
  assert.strictEqual(inferredFairways.feedback.geometry.osmFairways, 0, "fixture has no OSM fairway polygons");
  assert.strictEqual(inferredFairways.feedback.geometry.fairwayCorridors, 3, "green-led OSM hole lines register as fairway corridors");
  assert.strictEqual(inferredFairways.debugEvidence.holeCandidates.length, 3, "green-led hole-line corridors produce one line per green");
  assert(inferredFairways.debugEvidence.holeCandidates.every((candidate) => candidate.evidence.includes("osm-hole-line-as-fairway")), "hole-line corridors are labelled as fairway fallback evidence");
  const inferredFairwayLines = inferredFairways.checkpoints.find((checkpoint) => checkpoint.stage === "fairway-lines");
  assert.strictEqual(inferredFairwayLines.metadata.overlayCounts.osmFairways, 0, "Fairway Lines keeps raw OSM fairway count separate");
  assert.strictEqual(inferredFairwayLines.metadata.overlayCounts.fairways, 3, "Fairway Lines registers inferred fairway corridors");

  const cromwellLat = -45.04;
  const cromwellLng = 169.2;
  const cromwellElements = [
    lineElement(501, cromwellLat, cromwellLng, 100),
    fairwayElement(701, cromwellLat, cromwellLng, 100),
    teeElement(801, cromwellLat, cromwellLng),
    greenElement(601, cromwellLat + 100 / 111320, cromwellLng),
    lineElement(502, cromwellLat, cromwellLng + 0.004, 300),
    fairwayElement(702, cromwellLat, cromwellLng + 0.004, 300),
    teeElement(802, cromwellLat, cromwellLng + 0.004),
    greenElement(602, cromwellLat + 300 / 111320, cromwellLng + 0.004),
    lineElement(503, cromwellLat, cromwellLng + 0.008, 500),
    fairwayElement(703, cromwellLat, cromwellLng + 0.008, 500),
    teeElement(803, cromwellLat, cromwellLng + 0.008),
    greenElement(603, cromwellLat + 500 / 111320, cromwellLng + 0.008)
  ];
  const staleViewport = await resolver.resolveCourseGeometryForAutoMapper({
    course: { courseId: "cromwell-test", courseName: "Cromwell Test Course", courseLat: cromwellLat, courseLng: cromwellLng },
    courseCentre: { lat: cromwellLat, lng: cromwellLng },
    mapViewport: {
      center: { lat: -36.914902, lng: 174.725498 },
      zoom: 18,
      bounds: { south: -36.91705, west: 174.723612, north: -36.912753, east: 174.727383 }
    },
    osmPayload: { elements: cromwellElements },
    expectedHoleCount: 3
  });
  assert.strictEqual(staleViewport.status, "geometry-resolved-numbering-unavailable", "stale viewport does not block geometry-only resolution");
  assert.strictEqual(staleViewport.debugEvidence.greenCandidates.length, 3, "stale viewport does not reject course greens");
  assert.strictEqual(staleViewport.debugEvidence.holeCandidates.length, 3, "stale viewport does not reject candidate centre-lines");
  assert(staleViewport.checkpoints.find((checkpoint) => checkpoint.stage === "initial-snapshot"), "Initial Snapshot is produced with stale viewport and no scorecard");
  assert(staleViewport.checkpoints.find((checkpoint) => checkpoint.stage === "fairway-lines"), "Fairway Lines is produced with stale viewport and no scorecard");
  const staleInitial = staleViewport.checkpoints.find((checkpoint) => checkpoint.stage === "initial-snapshot");
  assert(staleInitial.metadata.bounds.north < -44, "checkpoint bounds follow source/course geometry, not stale Auckland viewport");

  const result = await resolver.resolveCourseGeometryForAutoMapper({
    course: { courseId: "resolver-test", courseName: "Resolver Test Course", courseLat: baseLat, courseLng: baseLng },
    courseCentre: { lat: baseLat, lng: baseLng },
    mapViewport: { center: { lat: baseLat, lng: baseLng }, zoom: 16, bounds: { south: baseLat - 0.01, west: baseLng - 0.01, north: baseLat + 0.01, east: baseLng + 0.01 } },
    osmPayload: { elements },
    expectedHoleCount: 3,
    scorecardEvidence: {
      source: "multi-source-test",
      sources: [
        {
          source: "official-tour",
          sourceUrl: "https://example.test/official-tour",
          holes: [
            { holeNumber: 1, par: 5, distanceM: 500 },
            { holeNumber: 2, par: 3, distanceM: 100 },
            { holeNumber: 3, par: 4, distanceM: 300 }
          ]
        },
        {
          source: "gps-app",
          sourceUrl: "https://example.test/gps-app",
          holes: [
            { hole: 1, par: 5, metres: 500 },
            { hole: 2, par: 3, metres: 100 },
            { hole: 3, par: 4, metres: 300 }
          ]
        }
      ]
    }
  });

  assert.strictEqual(result.status, "resolved");
  assert(result.confidence >= resolver.highConfidence, "resolved confidence is high enough");
  assert.strictEqual(
    JSON.stringify(result.holes.map((hole) => [hole.holeNumber, hole.candidate.candidateId])),
    JSON.stringify([
      [1, "way-303-way-203"],
      [2, "way-301-way-201"],
      [3, "way-302-way-202"]
    ]),
    "global assignment follows scorecard distances using green-led fairway centrelines"
  );
  assert(result.analysisBoundary.length >= 3, "debug boundary is returned");
  assert(result.debugEvidence.greenCandidates.length === 3, "green evidence is returned");
  assert.strictEqual(result.debugEvidence.scorecardEvidence.sourceCount, 2, "resolver keeps multiple scorecard evidence sources");
  assert.strictEqual(
    JSON.stringify(result.debugEvidence.scorecardEvidence.lengthOrder.map((row) => row.hole)),
    JSON.stringify([1, 3, 2]),
    "scorecard evidence exposes longest-to-shortest hole order"
  );
  assert(result.holes.every((hole) => hole.assignmentEvidence.multiSourceCount === 2), "multi-source length order is used as first tie-breaker evidence");
  assert.strictEqual(result.feedback.tieBreakers["multi-source-length-order"], 3, "multi-source agreement is counted in tie-breakers");
  assert.strictEqual(result.checkpoints.length, 3, "real evidence produces three visual checkpoints");
  const fairwayLines = result.checkpoints.find((checkpoint) => checkpoint.stage === "fairway-lines");
  assert(fairwayLines.imageDataUrl.startsWith("data:image/svg+xml"), "checkpoint includes a visual preview");
  assert(fairwayLines.metadata.geometryIds.candidates.includes("way-301-way-201"), "checkpoint candidate IDs match green-led fairway evidence IDs");
  assert.strictEqual(fairwayLines.metadata.viewport.zoom, 16, "checkpoint metadata includes map viewport");
  const numberAllocation = result.checkpoints.find((checkpoint) => checkpoint.stage === "number-allocation");
  assert.strictEqual(numberAllocation.metadata.scorecardEvidenceSourceCount, 2, "Number Allocation metadata keeps scorecard source count");
  assert.strictEqual(numberAllocation.metadata.scorecardDistanceCount, 3, "Number Allocation metadata reports usable distances");
  assert.strictEqual(JSON.stringify(numberAllocation.metadata.scorecardLengthOrder.map((row) => row.hole)), JSON.stringify([1, 3, 2]), "Number Allocation shows scorecard length ranking");
  assert.strictEqual(JSON.stringify(numberAllocation.metadata.candidateLengthOrder.map((row) => row.candidateId).slice(0, 3)), JSON.stringify(["way-303-way-203", "way-302-way-202", "way-301-way-201"]), "Number Allocation shows candidate length ranking");

  const fullScorecard = [
    { holeNumber: 1, par: 5, distanceM: 500 },
    { holeNumber: 2, par: 3, distanceM: 100 },
    { holeNumber: 3, par: 4, distanceM: 300 }
  ];
  const summary = resolver._test.scorecardEvidenceSummary(
    { scorecardEvidence: { source: "website-scorecard", distanceCount: 3, lengthOrder: [{ hole: 3, distanceM: 300, par: 4 }] } },
    [
      { source: "official", sourceUrl: "https://example.test/official", holes: [{ holeNumber: 3, par: 4, distanceM: 300 }], distanceCount: 1 },
      { source: "gps-app", sourceUrl: "https://example.test/gps", holes: fullScorecard, distanceCount: 3 }
    ],
    fullScorecard,
    3
  );
  assert.strictEqual(JSON.stringify(summary.lengthOrder.map((row) => row.hole)), JSON.stringify([1, 3, 2]), "complete source length order outranks partial top-level evidence order");
  assert.strictEqual(
    resolver._test.resolveStatus(Array.from({ length: 18 }, () => ({ confidence: 0.7 })), 0.8379, 18, true),
    "resolved",
    "18/18 assigned holes with high overall confidence are resolved"
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
