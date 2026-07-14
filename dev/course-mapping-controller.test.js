const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function storage(initial = {}) {
  const data = Object.assign({}, initial);
  return {
    data,
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    removeItem(key) { delete data[key]; }
  };
}

function classList() {
  const set = new Set();
  return {
    add(...items) { items.forEach((item) => set.add(item)); },
    remove(...items) { items.forEach((item) => set.delete(item)); },
    toggle(item, force) {
      if (force === undefined ? !set.has(item) : force) set.add(item);
      else set.delete(item);
    },
    contains(item) { return set.has(item); }
  };
}

function elementStub() {
  const list = classList();
  return {
    style: {},
    dataset: {},
    classList: list,
    textContent: "",
    innerHTML: "",
    value: "",
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    setAttribute() {},
    getAttribute() { return ""; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; }
  };
}

function course() {
  return {
    id: "controller-test",
    courseId: "controller-test",
    name: "Controller Test Golf Club",
    courseName: "Controller Test Golf Club",
    lat: -36.9,
    lng: 174.75,
    courseLat: -36.9,
    courseLng: 174.75
  };
}

function projectPoint(origin, bearingRad, metres) {
  const earth = 111320;
  const lat = Number(origin && origin.lat);
  const lng = Number(origin && origin.lng);
  return {
    lat: lat + (Math.cos(bearingRad) * metres) / earth,
    lng: lng + (Math.sin(bearingRad) * metres) / (earth * Math.cos(lat * Math.PI / 180))
  };
}

function scorecardHoles() {
  return [
    504, 332, 148, 471, 167, 348, 290, 363, 357,
    323, 413, 334, 311, 149, 483, 357, 122, 372
  ].map((distanceM, index) => ({
    hole: index + 1,
    par: [5, 4, 3, 5, 3, 4, 4, 4, 4, 4, 5, 4, 4, 3, 5, 4, 3, 4][index],
    metres: distanceM,
    tees: { White: { metres: distanceM, par: [5, 4, 3, 5, 3, 4, 4, 4, 4, 4, 5, 4, 4, 3, 5, 4, 3, 4][index] } }
  }));
}

function playableStore() {
  const c = course();
  return {
    courses: {
      "user-local-player::controller-test": {
        id: "user-local-player::controller-test",
        userId: "user-local-player",
        courseId: c.courseId,
        courseName: c.courseName,
        objects: {
          green1: { id: "green1", type: "green", holeNumber: 1, confirmed: true, position: { lat: -36.899, lng: 174.75 }, greenShape: [{ lat: -36.899, lng: 174.7499 }, { lat: -36.8989, lng: 174.7501 }, { lat: -36.8991, lng: 174.7501 }] },
          tee1: { id: "tee1", type: "tee", holeNumber: 1, confirmed: true, position: { lat: -36.9005, lng: 174.75 } },
          fairway1: { id: "fairway1", type: "fairway", holeNumber: 1, confirmed: true, position: { lat: -36.8997, lng: 174.75 } }
        },
        holes: {}
      }
    }
  };
}

function osmPayload(kind) {
  if (kind === "success") {
    return {
      elements: [
        { type: "way", id: 101, tags: { golf: "hole", ref: "1" }, geometry: [{ lat: -36.9005, lon: 174.75 }, { lat: -36.899, lon: 174.75 }] },
        { type: "way", id: 201, tags: { golf: "green", ref: "1" }, geometry: [{ lat: -36.8991, lon: 174.7499 }, { lat: -36.8991, lon: 174.7501 }, { lat: -36.8989, lon: 174.7501 }, { lat: -36.8989, lon: 174.7499 }, { lat: -36.8991, lon: 174.7499 }] }
      ]
    };
  }
  if (kind === "native") {
    return {
      elements: [
        { type: "way", id: 301, tags: { golf: "green", ref: "1" }, geometry: [{ lat: -36.8991, lon: 174.7499 }, { lat: -36.8991, lon: 174.7501 }, { lat: -36.8989, lon: 174.7501 }, { lat: -36.8989, lon: 174.7499 }, { lat: -36.8991, lon: 174.7499 }] }
      ]
    };
  }
  if (kind === "frame") {
    return {
      elements: [
        { type: "way", id: 401, tags: { golf: "green" }, geometry: [{ lat: -36.8991, lon: 174.7499 }, { lat: -36.8991, lon: 174.7501 }, { lat: -36.8989, lon: 174.7501 }, { lat: -36.8989, lon: 174.7499 }, { lat: -36.8991, lon: 174.7499 }] },
        { type: "way", id: 402, tags: { golf: "fairway" }, geometry: [{ lat: -36.9006, lon: 174.7498 }, { lat: -36.9006, lon: 174.7502 }, { lat: -36.8992, lon: 174.7502 }, { lat: -36.8992, lon: 174.7498 }, { lat: -36.9006, lon: 174.7498 }] },
        { type: "way", id: 403, tags: { golf: "tee" }, geometry: [{ lat: -36.9007, lon: 174.74995 }, { lat: -36.9007, lon: 174.75005 }, { lat: -36.9006, lon: 174.75005 }, { lat: -36.9006, lon: 174.74995 }, { lat: -36.9007, lon: 174.74995 }] }
      ]
    };
  }
  return { elements: [] };
}

function loadController(options = {}) {
  const events = [];
  const calls = { fetch: 0, native: 0, manual: 0, scorecard: 0, nativeInputs: [], fetchUrls: [], order: [], ingestMappedCourse: 0, ingestMappedHole: 0, ingestedHoles: [], frameWarm: 0, frameWarmHoles: [] };
  const testConsole = Object.assign({}, console, { warn() {}, info() {} });
  const localStorage = storage({
    gd_user_course_library_v1: JSON.stringify(options.savedMap ? playableStore() : { courses: {} })
  });
  const sessionStorage = storage();
  const body = elementStub();
  body.dataset = {};
  const head = elementStub();
  const document = {
    body,
    head,
    readyState: "complete",
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement: elementStub
  };
  const mappingDebug = {
    recordEvent(runId, event) {
      events.push(Object.assign({ runId }, event));
      if (event && event.event === "manual-fallback-opened") calls.manual += 1;
      return event;
    },
    startRun() { return "debug-run"; },
    getOrStartRun() { return "debug-run"; },
    finishRun() {}
  };
  const testScorecard = { courseKey: "", courseName: "", source: "none", sourceUrl: "", holes: [] };
  const win = {
    document,
    localStorage,
    sessionStorage,
    currentCourse: course(),
    gdActiveCourse: course(),
    scorecard: testScorecard,
    GDCourseMappingDebug: mappingDebug,
    GDCoursePlayPipeline: {
      recordDebugEvent() {},
      ingestMappedCourse(courseInput, holes) {
        calls.ingestMappedCourse += 1;
        (holes || []).forEach((hole) => calls.ingestedHoles.push(Number(hole && (hole.holeNumber || hole.hole))));
        return { courseId: courseInput && courseInput.courseId, holes: holes || [] };
      },
      ingestMappedHole(courseInput, holeNumber) {
        calls.ingestMappedHole += 1;
        calls.ingestedHoles.push(Number(holeNumber));
        return { courseId: courseInput && courseInput.courseId, holeNumber };
      }
    },
    gdRenderCoursePlayHoleFrame(courseInput, holeNumber, holeData, opts) {
      if (opts && opts.cacheOnly) {
        calls.frameWarm += 1;
        calls.frameWarmHoles.push(Number(holeNumber));
        return !!(holeData && Array.isArray(holeData.route) && holeData.route.length >= 2);
      }
      return false;
    },
    GDCourseGeometryResolver: {
      highConfidence: 0.76,
      mediumConfidence: 0.58,
      shouldRunForAutoMapper() { return true; },
      async resolveCourseGeometryForAutoMapper(input) {
        calls.native += 1;
        calls.nativeInputs.push(input || {});
        if (options.nativePartial) {
          return {
            status: "geometry-resolved-numbering-unavailable",
            confidence: 0,
            source: "test-native-resolver",
            holes: [],
            unresolvedCandidates: [{ candidateId: "native-geometry-1" }],
            unresolvedScorecardHoles: [],
            checkpoints: [
              { stage: "initial-snapshot", imageDataUrl: "data:image/svg+xml,initial", metadata: {} },
              { stage: "fairway-lines", imageDataUrl: "data:image/svg+xml,lines", metadata: {} },
              { stage: "number-allocation", imageDataUrl: "data:image/svg+xml,numbers", metadata: { status: "unavailable", warning: "Scorecard unavailable" } }
            ],
            feedback: {
              geometry: { greenCandidates: 1, acceptedGreens: 1, rejectedGreens: 0, fairwayCorridors: 1, candidatePaths: 1 },
              assignment: { scorecardHoles: 0, resolvedHoles: 0, unresolvedHoles: [] },
              distance: {},
              tieBreakers: {}
            },
            warnings: ["Scorecard unavailable"]
          };
        }
        if (options.nativeSuccess) {
          const resolvedHoles = Array.from({ length: options.nativeSuccessHoles || 1 }, (_, index) => {
            const holeNumber = index + 1;
            const baseLat = -36.9005 + index * 0.001;
            const confidence = Number(options.nativeLowConfidenceHole) === holeNumber ? 0.744 : 0.91;
            return {
              holeNumber,
              confidence,
              matchScore: confidence,
              evidence: ["test"],
              candidate: {
                candidateId: `native-${holeNumber}`,
                path: [{ lat: baseLat, lng: 174.75 }, { lat: baseLat + 0.0015, lng: 174.75 }]
              }
            };
          });
          return {
            status: "resolved",
            confidence: 0.91,
            source: "test-native-resolver",
            holes: resolvedHoles,
            feedback: { geometry: {}, assignment: {}, distance: {}, tieBreakers: {} },
            warnings: []
          };
        }
        return {
          status: "failed",
          confidence: 0,
          holes: [],
          feedback: { geometry: {}, assignment: {}, distance: {}, tieBreakers: {} },
          warnings: ["test native failure"]
        };
      }
    },
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    setTimeout(fn) { fn(); return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} }
  };
  if (options.scorecardDistances) {
    win.gdEnsureScorecardForCourse = async () => {
      calls.scorecard += 1;
      calls.order.push("scorecard");
      testScorecard.courseKey = "controller test golf club";
      testScorecard.courseName = "Controller Test Golf Club";
      testScorecard.source = "website";
      testScorecard.sourceUrl = "https://example.test/controller-scorecard";
      testScorecard.holes = scorecardHoles();
      testScorecard.scorecardSources = [
        { source: "website", sourceUrl: "https://example.test/controller-scorecard", holes: scorecardHoles() },
        { source: "gps-app", sourceUrl: "https://example.test/controller-gps-scorecard", holes: scorecardHoles() }
      ];
    };
  }
  win.window = win;

  const context = {
    window: win,
    document,
    localStorage,
    sessionStorage,
    scorecard: testScorecard,
    gdEnsureScorecardForCourse: win.gdEnsureScorecardForCourse,
    currentCourse: course(),
    map: {
      getContainer() { return elementStub(); },
      invalidateSize() {},
      panTo() {},
      getCenter() { return { lat: -36.9, lng: 174.75 }; },
      distance(a, b) {
        const dy = (Number(b.lat) - Number(a.lat)) * 111320;
        const dx = (Number(b.lng) - Number(a.lng)) * 111320;
        return Math.hypot(dx, dy);
      }
    },
    project: projectPoint,
    L: {
      latLng(lat, lng) { return { lat: Number(lat), lng: Number(lng) }; },
      circleMarker() { return { addTo() { return this; }, setLatLng() {}, remove() {} }; },
      polygon() { return { addTo() { return this; }, setLatLngs() {}, remove() {} }; },
      polyline() { return { addTo() { return this; }, setLatLngs() {}, remove() {}, bringToBack() {} }; }
    },
    target: null,
    greenCentre: null,
    greenMarker: null,
    greenOutline: null,
    greenSoft: null,
    greenLabel: null,
    frontLabel: null,
    backLabel: null,
    greenPolygon: null,
    console: testConsole,
    CustomEvent: win.CustomEvent,
    MutationObserver: win.MutationObserver,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    setInterval: win.setInterval,
    clearInterval: win.clearInterval,
    fetch: async (url) => {
      const overpass = String(url || "").includes("overpass-api");
      if (!overpass) return { ok: true, json: async () => ({}) };
      calls.fetch += 1;
      calls.order.push("osm-fetch");
      calls.fetchUrls.push(String(url || ""));
      const sequence = Array.isArray(options.fetchSequence) ? options.fetchSequence : null;
      const next = sequence && sequence.length ? sequence.shift() : null;
      if (options.fetchFails || next === "fail") return { ok: false, status: 504, json: async () => ({}) };
      const kind = next || (options.automapperSuccess ? "success" : options.nativeSuccess ? "native" : "zero");
      return { ok: true, json: async () => osmPayload(kind) };
    },
    AbortController: class { constructor() { this.signal = {}; } abort() {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "scripts", "gd-course-library-pin-lock.js"), "utf8"), context, { filename: "gd-course-library-pin-lock.js" });
  assert.strictEqual(typeof win.runCourseMappingAttempt, "function", "controller is exported");
  return { win, events, calls, course: course(), localStorage };
}

async function runScenario(options) {
  const env = loadController(options);
  const result = await env.win.runCourseMappingAttempt({
    course: env.course,
    hole: 1,
    wholeCourse: options.wholeCourse === undefined ? false : options.wholeCourse,
    showLoading: false,
    selectedAt: "2026-07-14T00:00:00.000Z",
    attemptToken: `attempt-${Math.random().toString(36).slice(2)}`,
    debugRunId: "debug-run",
    reason: "test"
  });
  return Object.assign(env, { result });
}

async function main() {
  let env = await runScenario({ savedMap: true });
  assert.strictEqual(env.result.playable, true, "saved map resolves play");
  assert.strictEqual(env.calls.fetch, 0, "saved map success prevents AutoMapper");
  assert.strictEqual(env.calls.native, 0, "saved map success prevents native resolver");

  env = await runScenario({ savedMap: true, wholeCourse: true, fetchSequence: ["fail", "native"], nativeSuccess: true });
  assert.strictEqual(env.calls.native, 1, "partial saved map does not block whole-course native resolver");
  assert(env.events.some((event) => event.event === "saved-map-incomplete"), "partial saved map is reported clearly");
  assert(!env.events.some((event) => event.event === "saved-map-found"), "partial saved map is not treated as complete course evidence");

  env = await runScenario({ automapperSuccess: true });
  assert.strictEqual(env.result.playable, true, "AutoMapper success resolves play");
  assert.strictEqual(env.calls.fetch, 1, "AutoMapper ran once");
  assert.strictEqual(env.calls.native, 0, "AutoMapper success prevents native resolver");

  env = await runScenario({ fetchFails: true });
  assert.strictEqual(env.calls.native, 1, "AutoMapper fetch failure invokes native resolver exactly once");
  assert.strictEqual(env.calls.fetch, 2, "native resolver retries source geometry after AutoMapper fetch failure");
  assert(env.events.some((event) => event.event === "automapper-failed"), "AutoMapper failure is terminally logged");
  assert.strictEqual(env.events.filter((event) => event.event === "automapper-failed").length, 1, "AutoMapper fetch failure is logged once");
  assert(env.events.some((event) => event.event === "native-resolver-started"), "native resolver start is logged after AutoMapper failure");
  assert.strictEqual(env.calls.nativeInputs[0].sourceLoadError.code, "osm-request-failed", "native resolver receives a source-load error when geometry reload fails");

  env = await runScenario({ fetchSequence: ["fail", "native"] });
  assert.strictEqual(env.calls.fetch, 2, "native resolver can independently reload source geometry");
  assert.strictEqual(env.calls.native, 1, "native resolver still runs once after reload");
  assert.strictEqual(env.calls.nativeInputs[0].sourceLoadError, null, "source reload clears the acquisition error");
  assert.strictEqual(env.calls.nativeInputs[0].osmPayload.elements.length, 1, "native resolver receives reloaded OSM geometry");
  assert(decodeURIComponent(env.calls.fetchUrls[0]).includes("around:1400"), "AutoMapper starts with the tighter course query");
  assert(decodeURIComponent(env.calls.fetchUrls[1]).includes("around:1400"), "native resolver repeats the pin-based source query when AutoMapper acquisition failed");

  env = await runScenario({ fetchSequence: ["native", "success"] });
  assert.strictEqual(env.calls.fetch, 2, "native resolver reloads when AutoMapper only found a narrow source slice");
  assert(decodeURIComponent(env.calls.fetchUrls[0]).includes("around:1400"), "narrow source slice came from AutoMapper radius");
  assert(decodeURIComponent(env.calls.fetchUrls[1]).includes("around:3200"), "native resolver zoomed out for full-course framing");
  assert.strictEqual(env.calls.nativeInputs[0].osmPayload.elements.length, 2, "native resolver receives the widened source payload");

  env = await runScenario({ fetchSequence: ["frame", "success"] });
  assert.strictEqual(env.calls.fetch, 2, "native resolver runs a framed second OSM query when first-pass source can frame the course");
  assert(decodeURIComponent(env.calls.fetchUrls[0]).includes("around:1400"), "first pass is seeded from the selected course pin");
  assert(!decodeURIComponent(env.calls.fetchUrls[1]).includes("around:"), "second pass is not another arbitrary radius query");
  assert(decodeURIComponent(env.calls.fetchUrls[1]).includes("way("), "second pass uses a framed Overpass bbox query");
  assert.strictEqual(env.calls.nativeInputs[0].osmPayload.elements.length, 2, "native resolver receives the framed source payload");
  assert.strictEqual(env.calls.nativeInputs[0].courseBoundary, undefined, "native resolver does not receive a stale saved course boundary");

  env = await runScenario({ fetchSequence: ["fail", "native"], nativePartial: true });
  assert.strictEqual(env.calls.native, 1, "partial native resolver runs once");
  assert(env.events.some((event) => event.event === "native-resolver-source-load-started"), "native source load start is logged");
  assert(env.events.some((event) => event.event === "native-resolver-source-load-succeeded"), "native source load success is logged");
  assert(!env.events.some((event) => event.event === "native-resolver-source-load-failed"), "scorecard-unavailable partial result is not logged as source-load-failed");
  assert(env.events.some((event) => event.event === "native-resolver-failed"), "partial native result still falls through as unresolved");
  assert.strictEqual(env.events.filter((event) => event.event === "manual-fallback-opened").length, 1, "partial native result opens manual fallback once");

  env = await runScenario({ fetchSequence: ["fail", "native"], nativePartial: true, scorecardDistances: true });
  assert.strictEqual(env.calls.scorecard, 1, "scorecard distances are fetched once for native resolver evidence");
  assert(env.calls.order.indexOf("scorecard") >= 0 && env.calls.order.indexOf("scorecard") < env.calls.order.lastIndexOf("osm-fetch"), "scorecard fetch starts before native OSM acquisition");
  assert.strictEqual(env.calls.nativeInputs[0].scorecardHoles.length, 18, "native resolver receives scorecard holes");
  assert.strictEqual(env.calls.nativeInputs[0].scorecardEvidence.distanceCount, 18, "native resolver receives 18 scorecard distances");
  assert.strictEqual(env.calls.nativeInputs[0].scorecardEvidence.sources.length, 2, "native resolver receives multiple scorecard evidence sources");
  assert.deepStrictEqual(env.calls.nativeInputs[0].scorecardEvidence.lengthOrder.slice(0, 3).map((row) => row.hole), [1, 15, 4], "scorecard length order is exposed longest-to-shortest");

  env = await runScenario({});
  assert.strictEqual(env.calls.native, 1, "AutoMapper zero-guide result invokes native resolver exactly once");
  assert.strictEqual(env.events.filter((event) => event.event === "automapper-failed").length, 1, "AutoMapper zero-guide failure is logged once");
  assert(env.events.some((event) => event.event === "native-resolver-failed"), "native resolver failure is terminally logged");
  assert.strictEqual(env.events.filter((event) => event.event === "manual-fallback-opened").length, 1, "automatic failure opens one manual fallback");
  const reentry = await env.win.runCourseMappingAttempt({
    course: env.course,
    hole: 1,
    wholeCourse: false,
    showLoading: false,
    selectedAt: "2026-07-14T00:00:01.000Z",
    attemptToken: "attempt-reentry",
    debugRunId: "debug-run-reentry",
    reason: "open-course-quarantine"
  });
  assert.strictEqual(reentry.terminal, true, "manual fallback blocks course-loader re-entry");
  assert.strictEqual(env.events.filter((event) => event.event === "mapping-attempt-started").length, 1, "manual fallback does not trigger course-loader re-entry");
  assert.strictEqual(env.events.filter((event) => event.event === "manual-fallback-opened").length, 1, "one attempt produces exactly one manual fallback opened event");
  assert(env.events.some((event) => event.event === "manual-fallback-terminal-reentry-blocked"), "blocked re-entry is explicitly logged");

  env = await runScenario({ nativeSuccess: true });
  assert.strictEqual(env.calls.native, 1, "native resolver success runs once");
  assert.strictEqual(env.result.playable, true, "native resolver success resolves play");
  assert.strictEqual(env.calls.manual, 0, "native resolver success prevents manual fallback");
  assert(env.events.some((event) => event.event === "native-resolver-succeeded"), "native resolver success is terminally logged");

  env = await runScenario({ fetchSequence: ["fail", "native"], nativeSuccess: true, nativeSuccessHoles: 3, wholeCourse: true });
  assert.deepStrictEqual(env.calls.frameWarmHoles, [1, 2, 3], "first-load native success warms every newly mapped play frame");
  assert.strictEqual(env.calls.ingestMappedCourse, 1, "first-load native success ingests the mapped course into the play pipeline");

  env = await runScenario({ fetchSequence: ["fail", "native"], nativeSuccess: true, nativeSuccessHoles: 18, nativeLowConfidenceHole: 3, wholeCourse: true });
  assert.strictEqual(env.result.playable, true, "resolved native run confirms every assigned hole even when one hole is below high-confidence threshold");
  assert.strictEqual(env.calls.manual, 0, "full resolved native run does not fall through to manual fallback");
  const resolvedStore = JSON.parse(env.localStorage.data.gd_user_course_library_v1);
  const resolvedCourse = resolvedStore.courses["user-local-player::controller-test"];
  const resolvedHole3 = Object.values(resolvedCourse.objects || {}).filter((object) => Number(object.holeNumber) === 3);
  assert(resolvedHole3.length >= 3, "resolved native run persists hole 3 play objects");
  assert(resolvedHole3.every((object) => object.confirmed), "resolved native run marks hole 3 objects confirmed");

  const noisyEvents = env.events.map((event) => event.event).filter(Boolean);
  assert(!noisyEvents.includes("automapper-invocation-requested"), "AutoMapper request noise is absent");
  assert(!noisyEvents.includes("automapper-entered"), "AutoMapper entered noise is absent");
  assert(!noisyEvents.includes("automapper-no-guides-to-save"), "AutoMapper no-guides duplicate is absent");
  assert(!noisyEvents.includes("native-resolver-skipped-after-automapper"), "native skip-after-AutoMapper noise is absent");

  console.log("course-mapping-controller tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
