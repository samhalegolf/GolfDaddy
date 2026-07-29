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

function publishedCourseMap(holeCount = 1) {
  const c = course();
  const objects = {};
  const holes = {};
  const total = holeCount === true ? 1 : Number(holeCount) || 0;
  if (total <= 0) {
    return { version: 1, storage: "supabase", updatedAt: "2026-07-14T22:12:40.000Z", courses: {} };
  }
  for (let h = 1; h <= total; h += 1) {
    const baseLat = -36.9005 + h * 0.001;
    const green = { lat: baseLat + 0.0015, lng: 174.75 };
    const shape = [
      { lat: green.lat - 0.00006, lng: green.lng - 0.00006 },
      { lat: green.lat - 0.00006, lng: green.lng + 0.00006 },
      { lat: green.lat + 0.00006, lng: green.lng + 0.00006 }
    ];
    objects[`published-green-${h}`] = { id: `published-green-${h}`, userId: "published", courseId: c.courseId, type: "green", holeNumber: h, confirmed: true, position: green, greenCenter: green, shape, greenShape: shape, source: "supabase-course-map", published: true };
    objects[`published-tee-${h}`] = { id: `published-tee-${h}`, userId: "published", courseId: c.courseId, type: "tee", holeNumber: h, confirmed: true, position: { lat: baseLat, lng: 174.75 }, source: "supabase-course-map", published: true };
    objects[`published-fairway-${h}`] = { id: `published-fairway-${h}`, userId: "published", courseId: c.courseId, type: "fairway", holeNumber: h, confirmed: true, position: { lat: baseLat + 0.00075, lng: 174.75 }, source: "supabase-course-map", published: true };
    holes[h] = { id: `published-green-${h}`, userId: "published", courseId: c.courseId, holeNumber: h, greenCenter: green, greenShape: shape, greenSource: "supabase-course-map", confirmed: true, published: true };
  }
  return {
    version: 1,
    storage: "supabase",
    updatedAt: "2026-07-14T22:12:40.000Z",
    courses: {
      "published::controller-test": {
        id: "published::controller-test",
        userId: "published",
        courseId: c.courseId,
        courseName: c.courseName,
        published: true,
        publishedAt: "2026-07-14T22:12:40.000Z",
        publishedBy: { name: "Sam", email: "samhalegolf@gmail.com", accountId: "acct-1" },
        objects,
        holes
      }
    }
  };
}

/* Server course-package fixture (functions/course-package.mjs's response shape, read here via
   window.GDCoursePackageClient). This is what resolveGeometryFromServerPackage() consumes now
   that there is no client-side AutoMapper or Native Geometry Resolver left - both run entirely
   server-side (functions/lib/gd-automapper-core.mjs, functions/lib/gd-geometry-resolver-core.mjs,
   functions/course-mapper-worker-background.mjs) and report back only as a finished package. */
function serverPackage(holeCount = 1) {
  const holes = Array.from({ length: holeCount }, (_, index) => {
    const h = index + 1;
    const baseLat = -36.9005 + h * 0.001;
    return {
      holeNumber: h,
      tee: { lat: baseLat, lng: 174.75 },
      green: { lat: baseLat + 0.0015, lng: 174.75 },
      greenShape: [
        { lat: baseLat + 0.00144, lng: 174.74994 },
        { lat: baseLat + 0.00144, lng: 174.75006 },
        { lat: baseLat + 0.00156, lng: 174.75006 }
      ],
      route: [{ lat: baseLat, lng: 174.75 }, { lat: baseLat + 0.00075, lng: 174.75 }, { lat: baseLat + 0.0015, lng: 174.75 }],
      confidence: 0.83
    };
  });
  return { status: "lite-geo-ready", holes };
}

function loadController(options = {}) {
  const events = [];
  const calls = { fetch: 0, courseMapsGet: 0, courseLibraryGet: 0, courseMapsPost: 0, courseMapsBodies: [], courseVisualsGet: 0, courseVisualsPost: 0, fetchUrls: [], order: [], ingestMappedCourse: 0, ingestMappedHole: 0, ingestedHoles: [], frameWarm: 0, frameWarmHoles: [], manual: 0 };
  const testConsole = Object.assign({}, console, { warn() {}, info() {} });
  const localStorage = storage({
    gd_user_course_library_v1: JSON.stringify(options.savedMap ? playableStore() : { courses: {} })
  });
  /* Storage-quota scenarios: the browser's localStorage bucket is full, so
     setItem on the course library throws QuotaExceededError. "recoverable"
     unblocks once the cloud-backed tile has been evicted; "hard" stays blocked
     no matter what gets evicted. Seeds one tile whose scan is confirmed pushed
     to Supabase (evictable) and one whose scan only exists locally (must
     never be evicted). */
  const SYNCED_TILE_KEY = "gd_captured_hole_frame_v19_other-course:h1";
  const UNSYNCED_TILE_KEY = "gd_captured_hole_frame_v19_other-course:h2";
  if (options.storageQuota) {
    localStorage.data[SYNCED_TILE_KEY] = "tile-data-cloud-backed";
    localStorage.data[UNSYNCED_TILE_KEY] = "tile-data-local-only";
    localStorage.data.gd_captured_surface_scans_v1 = JSON.stringify({
      version: 1,
      scans: [
        { id: "scan-synced", courseKey: "other-course", holeNumber: 1, updatedAt: "2026-07-01T00:00:00.000Z", storage: { legacyManifestKey: SYNCED_TILE_KEY } },
        { id: "scan-local", courseKey: "other-course", holeNumber: 2, updatedAt: "2026-07-02T00:00:00.000Z", storage: { legacyManifestKey: UNSYNCED_TILE_KEY } }
      ]
    });
    localStorage.data.gd_captured_surface_sync_v1 = JSON.stringify({ pushed: { "scan-synced": "2026-07-01T00:00:00.000Z" } });
    Object.defineProperty(localStorage, "length", { get: () => Object.keys(localStorage.data).length });
    localStorage.key = (index) => { const keys = Object.keys(localStorage.data); return index >= 0 && index < keys.length ? keys[index] : null; };
    const baseSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (key, value) => {
      const stillBlocked = options.storageQuota === "hard"
        || (options.storageQuota === "recoverable" && Object.prototype.hasOwnProperty.call(localStorage.data, SYNCED_TILE_KEY));
      if (key === "gd_user_course_library_v1" && stillBlocked) {
        const error = new Error("Failed to execute 'setItem' on 'Storage'");
        error.name = "QuotaExceededError";
        throw error;
      }
      baseSetItem(key, value);
    };
  }
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
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
    GolfDaddyAccounts: {
      current() {
        return { name: "Sam", email: "samhalegolf@gmail.com", role: "admin", accountId: "acct-1" };
      }
    },
    gdGetAccountPermission() { return "admin"; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    setTimeout(fn) { fn(); return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} }
  };
  if (options.resumeRound) {
    win.gdReadResumeRound = () => ({ updatedAt: Date.now(), course: course(), courseLabel: "Controller Test Golf Club", hole: 1, activated: true });
  }
  win.window = win;
  /* Stage 6 of the course-package migration plan: resolveGeometryFromServerPackage() reads
     window.GDCoursePackageClient, not a network call, so a scenario opts into the server
     result by supplying a canned response here rather than stubbing fetch. This is now the
     ONLY way a scenario can produce a playable map that isn't already saved locally or
     published to /api/course-maps - both the AutoMapper and the Native Geometry Resolver
     fallback run entirely server-side and report back only through this client. */
  if (options.serverCoursePackage) {
    win.GDCoursePackageClient = { fetchPackage: async () => options.serverCoursePackage };
  }

  const context = {
    window: win,
    document,
    localStorage,
    sessionStorage,
    scorecard: testScorecard,
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
    gdGetAccountPermission: win.gdGetAccountPermission,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    setInterval: win.setInterval,
    clearInterval: win.clearInterval,
    fetch: async (url, init = {}) => {
      const href = String(url || "");
      const method = String(init && init.method || "GET").toUpperCase();
      if (href.includes("/api/course-maps")) {
        if (method === "POST") {
          calls.courseMapsPost += 1;
          calls.order.push("course-maps-post");
          let body = {};
          try { body = JSON.parse(init.body || "{}"); } catch (_error) {}
          calls.courseMapsBodies.push(body);
          if (options.courseMapsPostFails) return { ok: false, status: 503, json: async () => ({ error: "course map write failed" }) };
          const id = body && body.course && body.course.id || "published::controller-test";
          return { ok: true, status: 200, json: async () => ({ version: 1, storage: "supabase", updatedAt: "2026-07-14T23:00:00.000Z", courses: { [id]: body.course } }) };
        }
        calls.courseMapsGet += 1;
        calls.order.push("course-maps-get");
        if (options.courseMapsFails) throw Object.assign(new Error("database pull failed"), { status: 502 });
        const holes = options.courseMapsHoles === undefined ? 0 : options.courseMapsHoles;
        return { ok: true, status: 200, json: async () => publishedCourseMap(holes) };
      }
      /* The library manifest the client now checks before pulling full course
         payloads. Reports the same version the published fixture carries, so a
         device that already holds the course sees it as current and skips the
         expensive /api/course-maps pull - which is the whole point of the
         endpoint, and what keeps the background startup sync from doubling the
         course-maps GET count here. */
      if (href.includes("/api/course-library")) {
        calls.courseLibraryGet += 1;
        calls.order.push("course-library-get");
        const holeCount = options.courseMapsHoles === undefined ? 0 : options.courseMapsHoles;
        /* Also advertise a course when the payload endpoint is set to fail:
           that scenario is about the pull failing, which presupposes there is
           something to pull. An empty manifest would short-circuit before the
           failure could happen and the scenario would test nothing. */
        const advertise = !!holeCount || !!options.courseMapsFails;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            configured: true,
            serverTime: "2026-07-14T23:00:00.000Z",
            count: advertise ? 1 : 0,
            courses: advertise
              ? [{
                course_id: course().courseId,
                course_name: course().courseName,
                hole_count: holeCount,
                objects_version: "2026-07-14T22:12:40.000Z",
                clarity_map_version: null
              }]
              : []
          })
        };
      }
      if (href.includes("/api/course-visuals")) {
        if (method === "POST") calls.courseVisualsPost += 1;
        else calls.courseVisualsGet += 1;
        calls.order.push(method === "POST" ? "course-visuals-post" : "course-visuals-get");
        return { ok: true, status: 200, json: async () => ({ visual: null, storage: "supabase" }) };
      }
      /* No production code path calls Overpass (or anything else) through fetch from within
         runCourseMappingAttempt any more - there is no client-side OSM query left in this
         function at all. This branch exists only as a safety net so an unexpected fetch
         doesn't crash a scenario; calls.fetch is asserted to stay 0 below as the actual
         regression check for "no client geometry fetch happens here". */
      calls.fetch += 1;
      calls.order.push("unexpected-fetch");
      calls.fetchUrls.push(href);
      return { ok: true, json: async () => ({}) };
    },
    AbortController: class { constructor() { this.signal = {}; } abort() {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "scripts", "gd-course-library-pin-lock.js"), "utf8"), context, { filename: "gd-course-library-pin-lock.js" });
  assert.strictEqual(typeof win.runCourseMappingAttempt, "function", "controller is exported");
  return { win, events, calls, course: course(), localStorage };
}

async function runScenario(options) {
  const env = loadController(options);
  Object.assign(env.calls, {
    fetch: 0,
    manual: 0,
    courseMapsGet: 0,
    courseMapsPost: 0,
    courseVisualsGet: 0,
    courseVisualsPost: 0,
    ingestMappedCourse: 0,
    ingestMappedHole: 0,
    frameWarm: 0
  });
  env.calls.courseMapsBodies.length = 0;
  env.calls.fetchUrls.length = 0;
  env.calls.order.length = 0;
  env.calls.ingestedHoles.length = 0;
  env.calls.frameWarmHoles.length = 0;
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
  assert.strictEqual(env.calls.fetch, 0, "saved map success makes no unexpected fetch");

  env = await runScenario({ courseMapsHoles: 1 });
  assert.strictEqual(env.result.playable, true, "published object course map resolves play before a fresh scan");
  assert.strictEqual(env.calls.courseMapsGet, 1, "published object library is checked once on a new-round open");
  assert.strictEqual(env.calls.fetch, 0, "published object map hit makes no unexpected fetch");
  assert(env.events.some((event) => event.event === "course-map-cloud-lookup-started" && event.summary === "Course map loading"), "cloud map loading is reported truthfully");
  assert(env.events.some((event) => event.event === "course-map-cloud-loaded"), "published object map hit is logged");
  assert(env.events.some((event) => event.event === "saved-map-found"), "published object map is available to the saved-map check");
  assert(env.events.findIndex((event) => event.event === "course-map-cloud-lookup-started") < env.events.findIndex((event) => event.event === "saved-map-lookup-started"), "cloud lookup happens before saved-map readiness");

  env = await runScenario({ courseMapsHoles: 18, wholeCourse: true });
  assert.strictEqual(env.result.playable, true, "whole-course published object map resolves play");
  assert.strictEqual(env.calls.courseMapsGet, 1, "whole-course object library is checked once");
  assert.strictEqual(env.calls.fetch, 0, "whole-course published object hit makes no unexpected fetch");
  assert.deepStrictEqual(env.calls.frameWarmHoles, Array.from({ length: 18 }, (_, index) => index + 1), "whole-course published object map collects every play frame on first load");
  assert.strictEqual(env.calls.ingestMappedCourse, 1, "whole-course published object map ingests the mapped course into the play pipeline");

  /* Stage 6/8 of the course-package migration plan: when the server has already mapped this
     course - whether by running the AutoMapper or, when OSM had shapes but no hole numbers,
     falling back to the Native Geometry Resolver - the client just persists what it is handed.
     Neither system runs on the client any more; resolveGeometryFromServerPackage() is now the
     only source of a freshly generated map. */
  env = await runScenario({ serverCoursePackage: serverPackage(1) });
  assert.strictEqual(env.result.playable, true, "server-provided geometry resolves play");
  assert.strictEqual(env.calls.fetch, 0, "a server hit makes no unexpected fetch");
  assert(env.events.some((event) => event.event === "server-course-package-hit"), "the server hit is logged for diagnostics");
  assert(env.events.some((event) => event.event === "automapper-succeeded"), "a server hit is reported through the existing automapper-succeeded event");

  /* No server package, and nothing saved or published: the client has no second geometry
     source of its own left to try (that used to be the native resolver's job) - it must fall
     straight through to the interactive manual fallback. */
  env = await runScenario({});
  assert.strictEqual(env.result.playable, false, "a miss with nothing else to try is not playable");
  assert.strictEqual(env.result.fallback, "interactive-green", "a miss opens the interactive green fallback");
  assert.strictEqual(env.calls.fetch, 0, "a miss makes no unexpected fetch - there is no client geometry source left to query");
  assert(env.events.some((event) => event.event === "server-course-package-pending"), "an unmapped course is logged as pending on the server");
  assert(env.events.some((event) => event.event === "automapper-failed"), "the miss is logged as automapper-failed for continuity with existing dashboards");
  assert(env.events.some((event) => event.event === "manual-fallback-opened" && event.details && event.details.reason === "server-map-not-ready"), "the fallback records why: the server has not produced a map yet");
  assert.strictEqual(env.calls.manual, 1, "exactly one manual fallback opens per miss");

  /* Re-entry into a course whose fallback is already open must be blocked, not silently
     restart the mapping attempt. */
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

  env = await runScenario({ courseMapsFails: true, serverCoursePackage: serverPackage(1) });
  assert.strictEqual(env.calls.courseMapsGet, 1, "database pull failure is attempted once");
  assert(env.events.some((event) => event.event === "course-map-cloud-lookup-failed"), "database pull failure is logged as a cloud warning");
  assert.strictEqual(env.result.playable, true, "database pull failure still falls through to a server-package hit");

  env = await runScenario({ courseMapsHoles: 1, resumeRound: true, serverCoursePackage: serverPackage(1) });
  /* The resolver must not run a cloud map lookup on a resume - that is what the
     event assertion below proves. Counting course-maps GETs cannot express it:
     a background startup sync populates the library independently of resume
     state, so the count depends on whether a 520ms timer happens to land inside
     the scenario rather than on the behaviour being tested. */
  assert(!env.events.some((event) => String(event.event || "").startsWith("course-map-cloud")), "resume-round path has no cloud-map lifecycle noise");
  assert.strictEqual(env.result.playable, true, "resume-round skip still resolves play from the server package");

  /* Unlike the old native-resolver stage - which warmed play frames for whatever holes it had
     just persisted regardless of whether the rest of the course was mapped - the surviving
     automapper branch only reaches showResolvedCoursePlayHole (where frame warming happens) once
     the whole-course map is fully complete. A 3-of-18 server package is real progress but is not
     "accepted" on its own; it falls through to the interactive fallback below like any other
     server-map-not-ready miss, and produces no play frames at all. */
  env = await runScenario({ wholeCourse: true, serverCoursePackage: serverPackage(3) });
  assert.strictEqual(env.result.playable, false, "an incomplete whole-course server package is not accepted on its own");
  assert.strictEqual(env.calls.frameWarm, 0, "an incomplete whole-course server package warms no play frames");
  assert.strictEqual(env.calls.ingestMappedCourse, 0, "an incomplete whole-course server package does not ingest into the play pipeline");

  env = await runScenario({ wholeCourse: true, serverCoursePackage: serverPackage(18) });
  assert.strictEqual(env.result.playable, true, "resolved server-package run confirms every assigned hole");
  assert.strictEqual(env.calls.manual, 0, "full resolved server-package run does not fall through to manual fallback");
  assert.deepStrictEqual(env.calls.frameWarmHoles, Array.from({ length: 18 }, (_, index) => index + 1), "complete first-load server-package success warms every newly mapped play frame");
  assert.strictEqual(env.calls.ingestMappedCourse, 1, "complete first-load server-package success ingests the mapped course into the play pipeline");
  assert.strictEqual(env.calls.courseMapsPost, 1, "complete generated object map syncs to the shared course-map library");
  assert.strictEqual(env.calls.courseVisualsPost, 0, "object map sync does not call the native visual publishing endpoint");
  assert.strictEqual(env.calls.courseMapsBodies[0].course.courseId, "controller-test", "generated object map sync uses the canonical course id");
  assert(Object.keys(env.calls.courseMapsBodies[0].course.objects || {}).length >= 54, "generated object map sync sends tee, green, and route objects");
  const resolvedStore = JSON.parse(env.localStorage.data.gd_user_course_library_v1);
  const resolvedCourse = resolvedStore.courses["user-local-player::controller-test"];
  const resolvedHole3 = Object.values(resolvedCourse.objects || {}).filter((object) => Number(object.holeNumber) === 3);
  assert(resolvedHole3.length >= 3, "resolved server-package run persists hole 3 play objects");
  assert(resolvedHole3.every((object) => object.confirmed), "resolved server-package run marks hole 3 objects confirmed");

  /* Full localStorage, but eviction can free enough: persisting the resolved geometry hits
     QuotaExceededError, evicts the cloud-backed tile, retries, and succeeds. The
     locally-captured tile must survive - its scan exists nowhere else. Persistence now always
     runs through resolveGeometryFromServerPackage() (there is no more client-AutoMapper or
     native-resolver persistence path), but the eviction logic itself lives in
     saveStore()/saveCourseObject() and is caller-agnostic, so the same guarantee applies here
     as it always did. */
  env = await runScenario({ serverCoursePackage: serverPackage(1), storageQuota: "recoverable" });
  assert.strictEqual(env.result.playable, true, "quota hit with evictable caches still resolves play via the server package");
  assert(!Object.prototype.hasOwnProperty.call(env.localStorage.data, "gd_captured_hole_frame_v19_other-course:h1"), "cloud-backed tile is evicted to make room");
  assert(Object.prototype.hasOwnProperty.call(env.localStorage.data, "gd_captured_hole_frame_v19_other-course:h2"), "locally-captured tile is never evicted");

  /* Full localStorage and eviction cannot free enough: geometry was resolved, but storage
     rejected the save outright, so play cannot be resolved from it. */
  env = await runScenario({ serverCoursePackage: serverPackage(1), storageQuota: "hard" });
  assert.strictEqual(env.result.playable, false, "a hard quota failure leaves nothing playable to resolve");
  assert(Object.prototype.hasOwnProperty.call(env.localStorage.data, "gd_captured_hole_frame_v19_other-course:h2"), "hard quota failure still never evicts a local-only tile");

  const noisyEvents = env.events.map((event) => event.event).filter(Boolean);
  assert(!noisyEvents.includes("automapper-invocation-requested"), "client AutoMapper request noise is absent");
  assert(!noisyEvents.includes("automapper-entered"), "client AutoMapper entered noise is absent");
  assert(!noisyEvents.includes("automapper-no-guides-to-save"), "client AutoMapper no-guides duplicate is absent");
  assert(!noisyEvents.includes("native-resolver-invoked"), "native resolver invocation noise is absent - it no longer runs client-side");
  assert(!noisyEvents.includes("native-resolver-succeeded"), "native resolver success noise is absent - it no longer runs client-side");
  assert(!noisyEvents.includes("native-resolver-skipped-numbered-course"), "native resolver skip noise is absent - it no longer runs client-side");

  console.log("course-mapping-controller tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
