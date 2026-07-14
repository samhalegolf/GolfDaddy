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
  return { elements: [] };
}

function loadController(options = {}) {
  const events = [];
  const calls = { fetch: 0, native: 0, manual: 0, nativeInputs: [] };
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
  const win = {
    document,
    localStorage,
    sessionStorage,
    currentCourse: course(),
    gdActiveCourse: course(),
    GDCourseMappingDebug: mappingDebug,
    GDCoursePlayPipeline: { recordDebugEvent() {} },
    GDCourseGeometryResolver: {
      highConfidence: 0.76,
      mediumConfidence: 0.58,
      shouldRunForAutoMapper() { return true; },
      async resolveCourseGeometryForAutoMapper(input) {
        calls.native += 1;
        calls.nativeInputs.push(input || {});
        if (options.nativeSuccess) {
          return {
            status: "resolved",
            confidence: 0.91,
            source: "test-native-resolver",
            holes: [{
              holeNumber: 1,
              confidence: 0.91,
              matchScore: 0.91,
              evidence: ["test"],
              candidate: {
                candidateId: "native-1",
                path: [{ lat: -36.9005, lng: 174.75 }, { lat: -36.899, lng: 174.75 }]
              }
            }],
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
  win.window = win;

  const context = {
    window: win,
    document,
    localStorage,
    sessionStorage,
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
    wholeCourse: false,
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
  if (process.env.DEBUG_MAPPING_CONTROLLER_TEST) {
    console.log(JSON.stringify({ result: env.result, events: env.events, store: env.localStorage.data.gd_user_course_library_v1 }, null, 2));
  }
  assert.strictEqual(env.result.playable, true, "saved map resolves play");
  assert.strictEqual(env.calls.fetch, 0, "saved map success prevents AutoMapper");
  assert.strictEqual(env.calls.native, 0, "saved map success prevents native resolver");

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
