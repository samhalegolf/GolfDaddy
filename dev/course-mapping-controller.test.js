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

function cloudScan(holeNumber) {
  const h = Number(holeNumber) || 1;
  const baseLat = -36.9005 + h * 0.001;
  const tee = { lat: baseLat, lng: 174.75 };
  const fairway = { lat: baseLat + 0.00075, lng: 174.75 };
  const green = { lat: baseLat + 0.0015, lng: 174.75 };
  return {
    client_scan_id: `controller-test-cloud-scan-${h}`,
    course_key: "controller-test",
    course_name: "Controller Test Golf Club",
    hole_number: h,
    source_type: "leaflet-tile-capture",
    status: { latest: true, confidence: "cloud-scan" },
    interaction: { owner: "captured-surface" },
    projection: { type: "leaflet-pixel-origin", captureZoom: 19, originPx: { x: 1000 + h, y: 2000 + h }, imageWidth: 900, imageHeight: 1200 },
    pins: {
      tee,
      green,
      route: [tee, fairway, green],
      greenShape: [
        { lat: green.lat - 0.00006, lng: green.lng - 0.00006 },
        { lat: green.lat - 0.00006, lng: green.lng + 0.00006 },
        { lat: green.lat + 0.00006, lng: green.lng + 0.00006 },
        { lat: green.lat + 0.00006, lng: green.lng - 0.00006 }
      ]
    },
    manifest: { key: `gd_captured_hole_frame_v19_controller-test:h${h}`, courseKey: "controller-test", courseName: "Controller Test Golf Club", holeNumber: h, tileCount: 16, tiles: [], originPx: { x: 1000 + h, y: 2000 + h }, imageWidth: 900, imageHeight: 1200, captureZoom: 19 },
    created_at: "2026-07-14T21:33:15.000Z",
    updated_at: "2026-07-14T22:12:40.000Z"
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
  const calls = { fetch: 0, native: 0, manual: 0, scorecard: 0, courseMapsGet: 0, courseLibraryGet: 0, courseMapsPost: 0, courseMapsBodies: [], courseVisualsGet: 0, courseVisualsPost: 0, nativeInputs: [], fetchUrls: [], order: [], ingestMappedCourse: 0, ingestMappedHole: 0, ingestedHoles: [], frameWarm: 0, frameWarmHoles: [] };
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
  if (options.resumeRound) {
    win.gdReadResumeRound = () => ({ updatedAt: Date.now(), course: course(), courseLabel: "Controller Test Golf Club", hole: 1, activated: true });
  }
  win.window = win;
  /* Stage 6 of the course-package migration plan: resolveGeometryFromServerPackage() reads
     window.GDCoursePackageClient, not a network call, so a scenario opts into the server
     short-circuit by supplying a canned response here rather than stubbing fetch. */
  if (options.serverCoursePackage) {
    win.GDCoursePackageClient = { fetchPackage: async () => options.serverCoursePackage };
  }

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
      const overpass = href.includes("overpass-api");
      if (!overpass) return { ok: true, json: async () => ({}) };
      calls.fetch += 1;
      calls.order.push("osm-fetch");
      calls.fetchUrls.push(href);
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
  Object.assign(env.calls, {
    fetch: 0,
    native: 0,
    manual: 0,
    scorecard: 0,
    courseMapsGet: 0,
    courseMapsPost: 0,
    courseVisualsGet: 0,
    courseVisualsPost: 0,
    ingestMappedCourse: 0,
    ingestMappedHole: 0,
    frameWarm: 0
  });
  env.calls.courseMapsBodies.length = 0;
  env.calls.nativeInputs.length = 0;
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
  assert.strictEqual(env.calls.fetch, 0, "saved map success prevents AutoMapper");
  assert.strictEqual(env.calls.native, 0, "saved map success prevents native resolver");

  env = await runScenario({ savedMap: true, wholeCourse: true, fetchSequence: ["fail", "native"], nativeSuccess: true });
  assert.strictEqual(env.calls.native, 1, "partial saved map does not block whole-course native resolver");
  assert(env.events.some((event) => event.event === "saved-map-incomplete"), "partial saved map is reported clearly");
  assert(!env.events.some((event) => event.event === "saved-map-found"), "partial saved map is not treated as complete course evidence");

  env = await runScenario({ courseMapsHoles: 1 });
  assert.strictEqual(env.result.playable, true, "published object course map resolves play before a fresh scan");
  assert.strictEqual(env.calls.courseMapsGet, 1, "published object library is checked once on a new-round open");
  assert.strictEqual(env.calls.fetch, 0, "published object map hit prevents OSM scan");
  assert(env.events.some((event) => event.event === "course-map-cloud-lookup-started" && event.summary === "Course map loading"), "cloud map loading is reported truthfully");
  assert(env.events.some((event) => event.event === "course-map-cloud-loaded"), "published object map hit is logged");
  assert(env.events.some((event) => event.event === "saved-map-found"), "published object map is available to the saved-map check");
  assert(env.events.findIndex((event) => event.event === "course-map-cloud-lookup-started") < env.events.findIndex((event) => event.event === "saved-map-lookup-started"), "cloud lookup happens before saved-map readiness");

  env = await runScenario({ courseMapsHoles: 18, wholeCourse: true });
  assert.strictEqual(env.result.playable, true, "whole-course published object map resolves play");
  assert.strictEqual(env.calls.courseMapsGet, 1, "whole-course object library is checked once");
  assert.strictEqual(env.calls.fetch, 0, "whole-course published object hit prevents OSM scan");
  assert.deepStrictEqual(env.calls.frameWarmHoles, Array.from({ length: 18 }, (_, index) => index + 1), "whole-course published object map collects every play frame on first load");
  assert.strictEqual(env.calls.ingestMappedCourse, 1, "whole-course published object map ingests the mapped course into the play pipeline");

  env = await runScenario({ automapperSuccess: true });
  /* The published database is still consulted before a fresh scan, but the
     manifest answers "the server holds nothing" without pulling any payload -
     so the check shows up as a course-library GET rather than a course-maps
     one. Asserting course-maps here would require the expensive call to happen
     precisely when there is nothing to fetch. */
  assert.strictEqual(env.calls.courseLibraryGet, 1, "published object library is checked before fresh scan");
  assert.strictEqual(env.calls.courseMapsGet, 0, "an empty library costs no payload pull");
  assert(env.events.some((event) => event.event === "course-map-cloud-not-found"), "cloud miss is logged");
  assert.strictEqual(env.calls.fetch, 1, "cloud miss falls through to the existing fresh scan");

  env = await runScenario({ courseMapsFails: true, automapperSuccess: true });
  assert.strictEqual(env.calls.courseMapsGet, 1, "database pull failure is attempted once");
  assert(env.events.some((event) => event.event === "course-map-cloud-lookup-failed"), "database pull failure is logged as a cloud warning");
  assert.strictEqual(env.calls.fetch, 1, "database pull failure falls through to the existing fresh scan");

  env = await runScenario({ courseMapsHoles: 1, resumeRound: true, automapperSuccess: true });
  /* The resolver must not run a cloud map lookup on a resume - that is what the
     event assertion below proves. Counting course-maps GETs cannot express it:
     a background startup sync populates the library independently of resume
     state, so the count depends on whether a 520ms timer happens to land inside
     the scenario rather than on the behaviour being tested. */
  assert(!env.events.some((event) => String(event.event || "").startsWith("course-map-cloud")), "resume-round path has no cloud-map lifecycle noise");
  assert.strictEqual(env.calls.fetch, 1, "resume-round skip leaves the existing scan path available");

  /* There is no more client AutoMapper fast path (course-package migration, stage 8): when
     the server has not mapped a course, the client goes straight to the native/image-based
     resolver, which does its own OSM acquisition (reusing the same query/parse code that used
     to belong to the removed client AutoMapper) and then always runs its real resolution -
     good OSM hole numbering alone no longer short-circuits it the way client AutoMapper used to. */
  env = await runScenario({ automapperSuccess: true, nativeSuccess: true });
  assert.strictEqual(env.result.playable, true, "native resolver, seeded by its own OSM acquisition, resolves play");
  assert.strictEqual(env.calls.fetch, 1, "one OSM fetch total - the native resolver's own source acquisition, not a separate AutoMapper pass");
  assert.strictEqual(env.calls.native, 1, "native resolver runs directly now; there is no client AutoMapper fast path left to skip it");

  /* Stage 6 of the course-package migration plan: when the server already has this course
     mapped, the client must skip its own OSM fetch entirely and persist straight from the
     server's answer - not run AutoMapper "just in case" and not fall back to the native
     resolver either. */
  env = await runScenario({
    serverCoursePackage: {
      status: "lite-geo-ready",
      holes: [{
        holeNumber: 1,
        tee: { lat: -36.9006, lng: 174.75 },
        green: { lat: -36.9008, lng: 174.75 },
        greenShape: [{ lat: -36.90081, lng: 174.7501 }, { lat: -36.90079, lng: 174.7501 }, { lat: -36.9008, lng: 174.74995 }],
        route: [{ lat: -36.9006, lng: 174.75 }, { lat: -36.9007, lng: 174.75 }, { lat: -36.9008, lng: 174.75 }],
        confidence: 0.83
      }]
    }
  });
  assert.strictEqual(env.result.playable, true, "server-provided geometry resolves play");
  assert.strictEqual(env.calls.fetch, 0, "a server hit must skip the client's own OSM fetch");
  assert.strictEqual(env.calls.native, 0, "a server hit must skip the native resolver too");
  assert(env.events.some((event) => event.event === "server-course-package-hit"), "the server short-circuit is logged for diagnostics");

  /* Fails open: a course the server has never touched (or a response missing a "ready"
     status) must fall straight through to today's AutoMapper path, unchanged. */
  env = await runScenario({ serverCoursePackage: { status: "processing" }, automapperSuccess: true });
  assert.strictEqual(env.calls.fetch, 1, "a non-ready server response falls through to the existing OSM fetch");
  assert.strictEqual(env.result.playable, true);

  /* fetchFails covers every OSM request, including the native resolver's own first attempt.
     Previously a failed client-AutoMapper pass still seeded a payload the native resolver
     could widen and retry from; with no client AutoMapper priming step left, the resolver's
     own first attempt failing with nothing to build a retry frame from is terminal - one
     fetch, not two. */
  env = await runScenario({ fetchFails: true });
  assert.strictEqual(env.calls.native, 1, "OSM fetch failure still invokes native resolver exactly once");
  assert.strictEqual(env.calls.fetch, 1, "one failed OSM fetch - no payload to build a widened retry frame from");
  assert(env.events.some((event) => event.event === "automapper-failed"), "the OSM fetch failure is terminally logged");
  assert.strictEqual(env.events.filter((event) => event.event === "automapper-failed").length, 1, "OSM fetch failure is logged once");
  assert(env.events.some((event) => event.event === "native-resolver-started"), "native resolver start is logged after the OSM fetch failure");
  assert.strictEqual(env.calls.nativeInputs[0].sourceLoadError.code, "osm-request-failed", "native resolver receives a source-load error when its own acquisition fails");

  /* The old ["fail","native"] two-fetch reload scenario (a failed client-AutoMapper pass
     seeding a retry the native resolver's own acquisition then repeated) no longer applies:
     there is no client AutoMapper fetch to fail first, and a failed first fetch has no
     payload to build a retry frame from (see the fetchFails scenario above) - so it is now
     identical in shape to that single-fetch-failure case and is not tested separately here. */

  /* A single sparse element (the "native" fixture: one unnumbered green) is not enough for
     the native resolver's own acquisition to compute a widen-retry frame from - it accepts
     that one fetch and moves on, so this no longer exercises a second fetch (that needs the
     richer "frame" fixture below, which has enough geometry to bound a real frame). */
  env = await runScenario({ fetchSequence: ["native"] });
  assert.strictEqual(env.calls.fetch, 1, "a single sparse OSM payload does not have enough geometry to compute a retry frame from");
  assert.strictEqual(env.calls.nativeInputs[0].osmPayload.elements.length, 1, "native resolver receives what its own acquisition found");

  env = await runScenario({ fetchSequence: ["frame", "success"] });
  assert.strictEqual(env.calls.fetch, 2, "native resolver runs a framed second OSM query when first-pass source can frame the course");
  assert(decodeURIComponent(env.calls.fetchUrls[0]).includes("around:1400"), "first pass is seeded from the selected course pin");
  assert(!decodeURIComponent(env.calls.fetchUrls[1]).includes("around:"), "second pass is not another arbitrary radius query");
  assert(decodeURIComponent(env.calls.fetchUrls[1]).includes("way("), "second pass uses a framed Overpass bbox query");
  assert.strictEqual(env.calls.nativeInputs[0].osmPayload.elements.length, 2, "native resolver receives the framed source payload");
  assert.strictEqual(env.calls.nativeInputs[0].courseBoundary, undefined, "native resolver does not receive a stale saved course boundary");

  env = await runScenario({ fetchSequence: ["native"], nativePartial: true });
  assert.strictEqual(env.calls.native, 1, "partial native resolver runs once");
  assert(env.events.some((event) => event.event === "native-resolver-source-load-started"), "native source load start is logged");
  assert(env.events.some((event) => event.event === "native-resolver-source-load-succeeded"), "native source load success is logged");
  assert(!env.events.some((event) => event.event === "native-resolver-source-load-failed"), "scorecard-unavailable partial result is not logged as source-load-failed");
  assert(env.events.some((event) => event.event === "native-resolver-failed"), "partial native result still falls through as unresolved");
  assert.strictEqual(env.events.filter((event) => event.event === "manual-fallback-opened").length, 1, "partial native result opens manual fallback once");

  env = await runScenario({ fetchSequence: ["native"], nativePartial: true, scorecardDistances: true });
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
  assert.strictEqual(env.calls.courseMapsPost, 1, "complete generated object map syncs to the shared course-map library");
  assert.strictEqual(env.calls.courseVisualsPost, 0, "object map sync does not call the native visual publishing endpoint");
  assert.strictEqual(env.calls.courseMapsBodies[0].course.courseId, "controller-test", "generated object map sync uses the canonical course id");
  assert(Object.keys(env.calls.courseMapsBodies[0].course.objects || {}).length >= 54, "generated object map sync sends tee, green, and route objects");
  const resolvedStore = JSON.parse(env.localStorage.data.gd_user_course_library_v1);
  const resolvedCourse = resolvedStore.courses["user-local-player::controller-test"];
  const resolvedHole3 = Object.values(resolvedCourse.objects || {}).filter((object) => Number(object.holeNumber) === 3);
  assert(resolvedHole3.length >= 3, "resolved native run persists hole 3 play objects");
  assert(resolvedHole3.every((object) => object.confirmed), "resolved native run marks hole 3 objects confirmed");

  /* Full localStorage, but eviction can free enough: persisting the resolved geometry hits
     QuotaExceededError, evicts the cloud-backed tile, retries, and succeeds. The
     locally-captured tile must survive - its scan exists nowhere else. Persistence now
     always runs through the native resolver (there is no more direct client-AutoMapper
     persistence path), but the eviction logic itself lives in saveStore()/saveCourseObject()
     and is caller-agnostic, so the same guarantee applies here as it always did. */
  env = await runScenario({ automapperSuccess: true, nativeSuccess: true, storageQuota: "recoverable" });
  assert.strictEqual(env.result.playable, true, "quota hit with evictable caches still resolves play via the native resolver");
  assert.strictEqual(env.calls.native, 1, "native resolver runs (it always does now) and its persistence recovers from the quota hit");
  assert(!Object.prototype.hasOwnProperty.call(env.localStorage.data, "gd_captured_hole_frame_v19_other-course:h1"), "cloud-backed tile is evicted to make room");
  assert(Object.prototype.hasOwnProperty.call(env.localStorage.data, "gd_captured_hole_frame_v19_other-course:h2"), "locally-captured tile is never evicted");

  /* Full localStorage and eviction cannot free enough: geometry was resolved, but storage
     rejected the save outright, so play cannot be resolved from it. */
  env = await runScenario({ automapperSuccess: true, nativeSuccess: true, storageQuota: "hard" });
  assert.strictEqual(env.calls.native, 1, "native resolver still runs and attempts to persist");
  assert.strictEqual(env.result.playable, false, "a hard quota failure leaves nothing playable to resolve");
  assert(Object.prototype.hasOwnProperty.call(env.localStorage.data, "gd_captured_hole_frame_v19_other-course:h2"), "hard quota failure still never evicts a local-only tile");

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
