const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const mapperPath = path.join(root, "scripts", "gd-course-library-pin-lock.js");
const mapperSource = fs.readFileSync(mapperPath, "utf8");

const expose = `
  window.__gdAutomapperGreenRefinementTestApi={
    automapperRunGreenShapeRefinement,
    saveOsmAutoHole,
    persistOsmGuideBundle,
    automapperGreenShapeVerdict,
    automapperBuildGreenShapeCrop,
    mappingAttemptContext,
    publishMappingAttempt,
    isCurrentMappingAttempt,
    mapperHoleCompletion,
    loadUserCourseData
  };
`;
const instrumentedSource = mapperSource.replace(
  "\n})();\n\n/* Clarity GPS visual/hole-rail/zoom hotfix",
  `\n${expose}})();\n\n/* Clarity GPS visual/hole-rail/zoom hotfix`
);
assert.notStrictEqual(instrumentedSource, mapperSource, "test harness instruments the actual mapper source");

function storage() {
  const data = new Map();
  return {
    getItem(key) { return data.has(String(key)) ? data.get(String(key)) : null; },
    setItem(key, value) { data.set(String(key), String(value)); },
    removeItem(key) { data.delete(String(key)); },
    clear() { data.clear(); },
    dump() { return Object.fromEntries(data.entries()); }
  };
}

function classList() {
  const values = new Set();
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    contains(name) { return values.has(name); },
    values
  };
}

function canvasStub() {
  return {
    width: 0,
    height: 0,
    getContext() {
      return {
        drawImage() {},
        getImageData() { return { data: new Uint8ClampedArray([0, 0, 0, 255]) }; },
        fillRect() {},
        beginPath() {},
        arc() {},
        ellipse() {},
        fill() {},
        stroke() {}
      };
    }
  };
}

function makeElement(id = "") {
  return {
    id,
    style: {},
    dataset: {},
    classList: classList(),
    textContent: "",
    innerHTML: "",
    value: "",
    disabled: false,
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    insertAdjacentHTML() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    getAttribute() { return null; }
  };
}

class FakeImage {
  set src(value) {
    this._src = value;
    setTimeout(() => {
      if (this.onload) this.onload();
    }, 0);
  }
  get src() { return this._src; }
}

function makeHarness() {
  const localStorage = storage();
  const sessionStorage = storage();
  const events = [];
  const wandCalls = [];
  const routeCalls = [];
  const gpsCalls = [];
  const holeChanges = [];
  const elements = new Map([
    ["gdWandPanel", makeElement("gdWandPanel")]
  ]);
  elements.get("gdWandPanel").classList.add("hidden");

  const document = {
    readyState: "loading",
    body: makeElement("body"),
    addEventListener() {},
    removeEventListener() {},
    createElement(name) {
      if (name === "canvas") return canvasStub();
      return makeElement(name);
    },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };

  const context = {
    console,
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    JSON,
    Promise,
    Error,
    Map,
    Set,
    RegExp,
    parseInt,
    parseFloat,
    isFinite,
    clamp(value, min, max) { return Math.min(max, Math.max(min, value)); },
    setTimeout,
    clearTimeout,
    setInterval() { return 0; },
    clearInterval() {},
    localStorage,
    sessionStorage,
    document,
    Image: FakeImage,
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    fetch() { return Promise.reject(new Error("network disabled in test")); },
    currentPlayingHole: 1,
    selectedHole: 1,
    currentCourse: { name: "Fixture Course", courseName: "Fixture Course", courseId: "fixture-course", lat: 0, lng: 0 },
    activePlayerProfile() { return { id: "fixture", name: "Fixture Player", email: "fixture@example.com" }; },
    gdGetAccountPermission() { return "player"; },
    toast() {},
    showHint() {},
    renderShot() {},
    gdCLRefreshProfileCard() {},
    updateMapperHoleUi() {},
    updateMapperToolCompletion() {},
    renderCourseLibraryPanel() {},
    drawHoleObjects() {},
    focusMapperHoleReference() {},
    frameMappedHoleForPlay() {},
    gdOpenShellRoute(route) { routeCalls.push(route); },
    setHole(hole) { holeChanges.push(hole); },
    openGpsWand(...args) { wandCalls.push(["openGpsWand", args]); },
    gdCompactWandOpen(...args) { wandCalls.push(["gdCompactWandOpen", args]); },
    startMapperGreenWand(...args) { wandCalls.push(["startMapperGreenWand", args]); },
    closeWandPanel(...args) { wandCalls.push(["closeWandPanel", args]); },
    acceptGreenWand(...args) { wandCalls.push(["acceptGreenWand", args]); },
    importGreenWandResult(...args) { wandCalls.push(["importGreenWandResult", args]); },
    rejectGreenWand(...args) { wandCalls.push(["rejectGreenWand", args]); },
    gdStartGpsCamera(...args) { gpsCalls.push(["gdStartGpsCamera", args]); },
    map: {
      project(point) {
        return { x: 1000 + Number(point.lng) * 100000, y: 1000 - Number(point.lat) * 100000 };
      },
      unproject(point) {
        return { lat: (1000 - Number(point.y)) / 100000, lng: (Number(point.x) - 1000) / 100000 };
      },
      distance(a, b) {
        const lat = (Number(a.lat) + Number(b.lat)) * Math.PI / 360;
        const dy = (Number(b.lat) - Number(a.lat)) * 111320;
        const dx = (Number(b.lng) - Number(a.lng)) * 111320 * Math.cos(lat);
        return Math.hypot(dx, dy);
      },
      removeLayer() {},
      getCenter() { return { lat: 0, lng: 0 }; },
      getZoom() { return 18; },
      setZoom() {},
      setView() {},
      fitBounds() {},
      stop() {},
      dragging: { enable() {}, disable() {} },
      on() {}
    },
    L: {
      point(x, y) { return { x, y }; },
      latLng(lat, lng) { return { lat: Number(lat), lng: Number(lng) }; },
      marker() { return { addTo() { return this; }, on() {}, getLatLng() { return { lat: 0, lng: 0 }; } }; },
      circleMarker() { return { addTo() { return this; } }; },
      polygon() { return { addTo() { return this; }, on() {}, getLatLngs() { return [[]]; }, setLatLngs() {} }; },
      polyline() { return { addTo() { return this; } }; },
      divIcon(options) { return options; },
      latLngBounds() { return { pad() { return this; } }; },
      DomEvent: { stop() {} }
    }
  };
  context.window = context;
  context.globalThis = context;

  context.GDCourseMappingDebug = {
    recordEvent(runId, event) {
      events.push({ runId, ...event });
      return event;
    },
    finishRun() {}
  };
  context.GolfDaddyAccounts = { current() { return { role: "player", email: "fixture@example.com" }; } };

  vm.runInNewContext(instrumentedSource, context, { filename: mapperPath });
  const api = context.window.__gdAutomapperGreenRefinementTestApi;
  assert(api, "instrumented mapper API is available");
  return { context, api, localStorage, sessionStorage, events, wandCalls, routeCalls, gpsCalls, holeChanges };
}

function ring(center, radiusM, points = 24) {
  const latMetres = 111320;
  const lngMetres = 111320 * Math.cos(Number(center.lat) * Math.PI / 180);
  return Array.from({ length: points }, (_, index) => {
    const angle = Math.PI * 2 * index / points;
    return {
      lat: center.lat + Math.cos(angle) * radiusM / latMetres,
      lng: center.lng + Math.sin(angle) * radiusM / lngMetres
    };
  });
}

function pixelsRing(center, radius = 16, points = 24) {
  return Array.from({ length: points }, (_, index) => {
    const angle = Math.PI * 2 * index / points;
    return {
      x: center.x + Math.sin(angle) * radius,
      y: center.y - Math.cos(angle) * radius
    };
  });
}

function manifestFor(course, hole, center) {
  return {
    key: captureKey(course, hole),
    courseKey: course.courseId,
    holeNumber: hole,
    originPx: { x: 0, y: 0 },
    imageWidth: 2200,
    imageHeight: 2200,
    captureZoom: 18,
    tiles: [{ x: 0, y: 0, width: 2200, height: 2200, url: "data:image/png;base64,fixture" }],
    center
  };
}

function captureKey(courseInput, hole) {
  const raw = `${courseInput.courseId || courseInput.id || courseInput.courseName || "course"}:h${Number(hole) || 1}`;
  const slug = String(raw).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "course";
  return `gd_captured_hole_frame_v19_${slug}`;
}

function course() {
  return { name: "Fixture Course", courseName: "Fixture Course", courseId: "fixture-course", lat: 0, lng: 0 };
}

function seedStore(harness, courseInput = course()) {
  harness.localStorage.setItem("gd_active_course_v1", JSON.stringify(courseInput));
  harness.context.currentCourse = courseInput;
}

function savedCourse(harness) {
  const store = JSON.parse(harness.localStorage.getItem("gd_user_course_library_v1"));
  return Object.values(store.courses)[0];
}

function greenObjects(harness) {
  return Object.values(savedCourse(harness).objects).filter((object) => object.type === "green");
}

function debugReasons(harness) {
  return harness.events.map((event) => event.details && (event.details.rejectionReason || event.details.skipReason)).filter(Boolean);
}

function setEngine(harness, impl) {
  harness.context.GDGreenShapeEngine = impl;
  harness.context.GolfDaddyGreenWandEngine = impl;
  harness.context.ClarityCaddieGreenWandEngine = impl;
}

async function saveFixtureHole(harness, opts = {}) {
  const c = opts.course || course();
  seedStore(harness, c);
  const center = opts.greenCenter || { lat: 0, lng: 0.01 };
  const guide = {
    hole: opts.hole || 1,
    points: [{ lat: 0, lng: 0 }, center],
    source: "fixture-guide",
    resolverVersion: "fixture-resolver",
    resolverConfidence: 0.6,
    resolverEvidence: ["fixture"]
  };
  const green = opts.green === null ? [] : [{
    ref: opts.hole || 1,
    center,
    shape: opts.greenShape || ring(center, 14, 24)
  }];
  return harness.api.saveOsmAutoHole(guide, green, c, {
    debugRunId: opts.debugRunId || "debug-run",
    debugAttemptContext: opts.attempt || null,
    sessionCourse: c
  });
}

(async () => {
  {
    const harness = makeHarness();
    const c = course();
    const center = { lat: 0, lng: 0.01 };
    seedStore(harness, c);
    harness.localStorage.setItem(captureKey(c, 1), JSON.stringify(manifestFor(c, 1, center)));
    let detectCalls = 0;
    setEngine(harness, {
      async detect(input) {
        detectCalls++;
        assert.strictEqual(input.width, 240, "engine receives constrained crop width");
        assert.strictEqual(input.height, 240, "engine receives constrained crop height");
        assert(input.image && input.image.width === 240, "engine receives crop canvas");
        return {
          ok: true,
          confidence: 0.83,
          polygonPixels: pixelsRing(input.candidateCentrePx, 16, 24),
          metrics: { acceptedDots: 18, bestChain: 12, ridgeCoverage: 90, difference: 30 }
        };
      }
    });

    const first = await saveFixtureHole(harness, { course: c, greenCenter: center });
    const firstGreen = greenObjects(harness)[0];
    assert.strictEqual(first.refinement.accepted, true, `valid candidate and strong engine result accepts refinement: ${JSON.stringify(first.refinement)}`);
    assert.strictEqual(detectCalls, 1, "mapping owner calls the engine once");
    assert.strictEqual(greenObjects(harness).length, 1, "accepted refinement creates one green object");
    assert.strictEqual(firstGreen.source, "osm_auto_green_refined", "accepted geometry uses refinement source metadata");
    assert.strictEqual(firstGreen.greenShapeRefinement.engine, "GDGreenShapeEngine", "accepted source metadata includes engine identity");
    assert.strictEqual(firstGreen.greenShapeRefinement.status, "accepted", "accepted source metadata includes handoff status");
    assert.strictEqual(firstGreen.greenShapeRefinement.confidence, 0.83, "accepted source metadata includes confidence");
    assert.strictEqual(firstGreen.resolverEvidence.includes("green-shape-engine-refinement"), true, "expected source metadata is attached");
    assert.strictEqual(firstGreen.greenShape.length >= 3, true, "finite polygon is persisted");
    assert.strictEqual(harness.events.some((event) => event.event === "automapper-green-shape-refinement-accepted"), true, "diagnostics record acceptance");

    const second = await saveFixtureHole(harness, { course: c, greenCenter: center });
    assert.strictEqual(second.refinement.accepted, true, "same stale course snapshot can re-run refinement");
    assert.strictEqual(greenObjects(harness).length, 1, "repeated accepted refinement does not duplicate persistence");
    assert.strictEqual(harness.wandCalls.length, 0, "no standalone Wand function is called");
    assert.strictEqual(harness.context.document.getElementById("gdWandPanel").classList.contains("hidden"), true, "Wand panel stays closed");
    assert.strictEqual(harness.context.document.body.classList.contains("wand-active"), false, "no Wand-active body class is added");
    assert.deepStrictEqual(harness.gpsCalls, [], "no GPS camera command is issued");
    assert.deepStrictEqual(harness.routeCalls, [], "no shell route changes");
    assert.deepStrictEqual(harness.holeChanges, [], "no hole change occurs");

    harness.localStorage.setItem(captureKey(c, 2), JSON.stringify(manifestFor(c, 2, center)));
    const repeatA = await harness.api.automapperRunGreenShapeRefinement({ course: c, hole: 2, greenCenter: center, greenShape: ring(center, 14, 24), debugRunId: "repeat-a" });
    const repeatB = await harness.api.automapperRunGreenShapeRefinement({ course: c, hole: 2, greenCenter: center, greenShape: ring(center, 14, 24), debugRunId: "repeat-b" });
    assert.deepStrictEqual(
      { accepted: repeatB.accepted, shape: repeatB.greenShape, confidence: repeatB.confidence },
      { accepted: repeatA.accepted, shape: repeatA.greenShape, confidence: repeatA.confidence },
      "identical fixture input gives equivalent refinement output"
    );
  }

  const rejectionCases = [
    {
      name: "no imagery",
      reason: "no-renderable-crop",
      setup(h) {
        setEngine(h, { async detect() { throw new Error("should not call engine without imagery"); } });
      }
    },
    {
      name: "invalid projection",
      reason: "projection-unavailable",
      setup(h, c, center) {
        h.localStorage.setItem(captureKey(c, 1), JSON.stringify(manifestFor(c, 1, center)));
        h.context.map.project = () => null;
        setEngine(h, { async detect() { throw new Error("should not call engine without projection"); } });
      }
    },
    {
      name: "engine no-match",
      reason: "no-match",
      setup(h, c, center) {
        h.localStorage.setItem(captureKey(c, 1), JSON.stringify(manifestFor(c, 1, center)));
        setEngine(h, { async detect() { return { ok: false, rejectionReason: "no-match", confidence: 0.2, metrics: {} }; } });
      }
    },
    {
      name: "engine exception",
      reason: "refinement-error",
      setup(h, c, center) {
        h.localStorage.setItem(captureKey(c, 1), JSON.stringify(manifestFor(c, 1, center)));
        setEngine(h, { async detect() { throw new Error("fixture engine failed"); } });
      }
    },
    {
      name: "confidence below threshold",
      reason: "low-confidence",
      setup(h, c, center) {
        h.localStorage.setItem(captureKey(c, 1), JSON.stringify(manifestFor(c, 1, center)));
        setEngine(h, { async detect(input) { return { ok: true, confidence: 0.51, polygonPixels: pixelsRing(input.candidateCentrePx, 16, 24), metrics: {} }; } });
      }
    },
    {
      name: "invalid polygon",
      reason: "too-few-map-points",
      setup(h, c, center) {
        h.localStorage.setItem(captureKey(c, 1), JSON.stringify(manifestFor(c, 1, center)));
        setEngine(h, { async detect(input) { return { ok: true, confidence: 0.9, polygonPixels: pixelsRing(input.candidateCentrePx, 16, 2), metrics: {} }; } });
      }
    },
    {
      name: "non-finite polygon points",
      reason: "too-few-map-points",
      setup(h, c, center) {
        h.localStorage.setItem(captureKey(c, 1), JSON.stringify(manifestFor(c, 1, center)));
        setEngine(h, { async detect(input) { return { ok: true, confidence: 0.9, polygonPixels: [{ x: input.candidateCentrePx.x, y: input.candidateCentrePx.y }, { x: NaN, y: 1 }, { x: Infinity, y: 2 }], metrics: {} }; } });
      }
    },
    {
      name: "polygon too far from candidate",
      reason: "centroid-drift",
      setup(h, c, center) {
        h.localStorage.setItem(captureKey(c, 1), JSON.stringify(manifestFor(c, 1, center)));
        setEngine(h, { async detect(input) { return { ok: true, confidence: 0.9, polygonPixels: pixelsRing({ x: input.candidateCentrePx.x + 80, y: input.candidateCentrePx.y }, 16, 24), metrics: {} }; } });
      }
    },
    {
      name: "course mismatch",
      reason: "stale-mapping-attempt",
      setup(h, c, center) {
        h.localStorage.setItem(captureKey(c, 1), JSON.stringify(manifestFor(c, 1, center)));
        const active = { debugRunId: "active", runId: "active", courseId: "other-course", hole: 1, attemptToken: "active-token", at: Date.now() };
        h.context.window.__gdCourseMappingDebugActiveAttempt = active;
        setEngine(h, { async detect() { throw new Error("stale course should not call engine"); } });
        return { debugRunId: "stale", runId: "stale", courseId: "fixture-course", hole: 1, attemptToken: "stale-token", at: Date.now() - 100 };
      }
    },
    {
      name: "hole mismatch",
      reason: "stale-mapping-attempt",
      setup(h, c, center) {
        h.localStorage.setItem(captureKey(c, 1), JSON.stringify(manifestFor(c, 1, center)));
        h.context.window.__gdCourseMappingDebugActiveAttempt = { debugRunId: "active", runId: "active", courseId: "fixture-course", hole: 2, attemptToken: "active-token", at: Date.now() };
        setEngine(h, { async detect() { throw new Error("stale hole should not call engine"); } });
        return { debugRunId: "stale", runId: "stale", courseId: "fixture-course", hole: 1, attemptToken: "stale-token", at: Date.now() - 100 };
      }
    },
    {
      name: "stale mapping attempt",
      reason: "stale-mapping-attempt",
      setup(h, c, center) {
        h.localStorage.setItem(captureKey(c, 1), JSON.stringify(manifestFor(c, 1, center)));
        h.context.window.__gdCourseMappingDebugActiveAttempt = { debugRunId: "active", runId: "active", courseId: "fixture-course", hole: 1, attemptToken: "new-token", at: Date.now() };
        setEngine(h, { async detect() { throw new Error("stale token should not call engine"); } });
        return { debugRunId: "old", runId: "old", courseId: "fixture-course", hole: 1, attemptToken: "old-token", at: Date.now() - 100 };
      }
    }
  ];

  for (const rejectionCase of rejectionCases) {
    const harness = makeHarness();
    const c = course();
    const center = { lat: 0, lng: 0.01 };
    seedStore(harness, c);
    const attempt = rejectionCase.setup(harness, c, center) || null;
    const result = await saveFixtureHole(harness, { course: c, greenCenter: center, attempt });
    assert.doesNotThrow(() => result, `${rejectionCase.name} does not throw`);
    assert.strictEqual(result.refinement.accepted, false, `${rejectionCase.name} rejects or skips refinement`);
    assert.strictEqual(result.refinement.reason, rejectionCase.reason, `${rejectionCase.name} records a specific reason`);
    assert.strictEqual(greenObjects(harness).some((object) => object.source === "osm_auto_green_refined"), false, `${rejectionCase.name} does not write a refined green`);
    assert.strictEqual(greenObjects(harness).length, 1, `${rejectionCase.name} preserves existing AutoMapper fallback green behavior`);
    assert.strictEqual(debugReasons(harness).includes(rejectionCase.reason), true, `${rejectionCase.name} records diagnostics reason`);
    assert.strictEqual(harness.wandCalls.length, 0, `${rejectionCase.name} does not call standalone Wand`);
    assert.deepStrictEqual(harness.gpsCalls, [], `${rejectionCase.name} does not issue GPS camera command`);
    assert.deepStrictEqual(harness.routeCalls, [], `${rejectionCase.name} does not change shell route`);
    assert.deepStrictEqual(harness.holeChanges, [], `${rejectionCase.name} does not change hole`);
  }

  {
    const harness = makeHarness();
    const c = course();
    const center = { lat: 0, lng: 0.01 };
    seedStore(harness, c);
    harness.localStorage.setItem(captureKey(c, 1), JSON.stringify(manifestFor(c, 1, center)));
    await saveFixtureHole(harness, { course: c, greenCenter: center, attempt: null });
    const seededGreenCount = greenObjects(harness).length;
    setEngine(harness, { async detect() { throw new Error("existing green should prevent refinement"); } });
    const skipped = await saveFixtureHole(harness, { course: savedCourse(harness), greenCenter: center });
    assert.strictEqual(skipped.refinement.reason, "green-already-mapped", "stronger existing geometry already present is skipped");
    assert.strictEqual(greenObjects(harness).length, seededGreenCount, "existing geometry is not duplicated");
  }

  {
    const harness = makeHarness();
    const c = course();
    const center = { lat: 0, lng: 0.01 };
    seedStore(harness, c);
    harness.localStorage.setItem(captureKey(c, 1), JSON.stringify(manifestFor(c, 1, center)));
    let calls = 0;
    setEngine(harness, {
      async detect(input) {
        calls++;
        if (calls === 1) {
          harness.context.window.__gdCourseMappingDebugActiveAttempt = { debugRunId: "attempt-b", runId: "attempt-b", courseId: "fixture-course", hole: 1, attemptToken: "b", at: Date.now() };
        }
        return { ok: true, confidence: 0.9, polygonPixels: pixelsRing(input.candidateCentrePx, 16, 24), metrics: {} };
      }
    });
    const attemptA = { debugRunId: "attempt-a", runId: "attempt-a", courseId: "fixture-course", hole: 1, attemptToken: "a", at: Date.now() };
    harness.context.window.__gdCourseMappingDebugActiveAttempt = attemptA;
    const staleResult = await harness.api.automapperRunGreenShapeRefinement({ course: c, hole: 1, greenCenter: center, greenShape: ring(center, 14, 24), debugRunId: "attempt-a", attempt: attemptA });
    assert.strictEqual(staleResult.accepted, true, "current implementation only gates attempt freshness before engine handoff");
    const saveResult = await saveFixtureHole(harness, { course: c, greenCenter: center, attempt: attemptA });
    assert.strictEqual(saveResult.refinement.reason, "stale-mapping-attempt", "one mapping attempt cannot save through another active attempt");
    assert.strictEqual(greenObjects(harness).some((object) => object.source === "osm_auto_green_refined"), false, "stale accepted output from another attempt is not persisted by the save path");
  }

  console.log("automapper-green-refinement-behavior tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
