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

function loadDebug(options = {}) {
  const code = fs.readFileSync(path.join(__dirname, "..", "scripts", "gd-course-mapping-debug.js"), "utf8");
  const sessionStorage = options.sessionStorage || storage();
  let fallbackCopied = false;
  let alertCalled = false;
  const body = {
    dataset: { gdPermission: options.role || "admin" },
    classList: classList(),
    appendChild(node) { node.parentNode = body; },
    removeChild(node) { node.parentNode = null; }
  };
  const elements = {
    gdCourseMappingDebugPanel: {
      hidden: false,
      innerHTML: "",
      classList: classList()
    },
    developerPanel: {
      classList: { contains(value) { return value === "open"; } }
    },
    gdCourseMappingCopyStatus: {
      textContent: "",
      classList: classList()
    }
  };
  const document = {
    readyState: "complete",
    body,
    addEventListener() {},
    getElementById(id) { return elements[id] || null; },
    createElement() {
      return {
        value: "",
        style: {},
        setAttribute() {},
        focus() {},
        select() {}
      };
    },
    execCommand(command) {
      fallbackCopied = command === "copy";
      return fallbackCopied;
    }
  };
  const window = {
    document,
    sessionStorage,
    navigator: options.clipboard === "ok" ? { clipboard: { writeText: async () => true } } :
      options.clipboard === "fail" ? { clipboard: { writeText: async () => { throw new Error("denied"); } } } : {},
    console,
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
    addEventListener() {},
    dispatchEvent() {},
    setTimeout(fn) { fn(); return 1; },
    clearTimeout() {},
    open() { return null; },
    alert() { alertCalled = true; }
  };
  const context = {
    window,
    document,
    navigator: window.navigator,
    sessionStorage,
    console,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    alert: window.alert
  };
  vm.runInNewContext(code, context, { filename: "gd-course-mapping-debug.js" });
  return {
    api: context.window.GDCourseMappingDebug,
    elements,
    sessionStorage,
    fallbackCopied: () => fallbackCopied,
    alertCalled: () => alertCalled
  };
}

function pointArray(count) {
  return Array.from({ length: count }, (_, index) => ({ lat: -36.9 + index / 1000, lng: 174.7 + index / 1000 }));
}

function svgDataUrl(label) {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg"><text>${label}</text></svg>`);
}

async function main() {
  const env = loadDebug({ role: "admin", clipboard: "fail" });
  const api = env.api;
  assert(api, "debug API exports");

  const runA = api.startRun({ courseId: "cromwell", courseName: "Cromwell Golf Club" });
  const runB = api.startRun({ courseId: "cromwell", courseName: "Cromwell Golf Club" });
  assert.notStrictEqual(runA, runB, "retrying the same course creates a new run ID");

  const metaRun = api.startRun({
    courseId: "maungakiekie-golf-club",
    courseName: "Maungakiekie Golf Club",
    courseCentre: { lat: -36.9229754, lng: 174.7254871 },
    selectedAt: "2026-07-14T11:26:00.000Z",
    attemptToken: "attempt-1"
  });
  const meta = api.getRun(metaRun);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(meta.courseCentre)), { lat: -36.9229754, lng: 174.7254871 }, "run stores selected course centre");
  assert.strictEqual(meta.selectedAt, "2026-07-14T11:26:00.000Z", "run stores selectedAt");
  assert.strictEqual(meta.attemptToken, "attempt-1", "run stores attempt token");
  const otherRun = api.getOrStartRun({ courseId: "akarana-golf-club", courseName: "Akarana Golf Club" });
  assert.notStrictEqual(otherRun, metaRun, "different course identity does not reuse the active run");

  api.recordEvent(runB, { timestamp: "2026-07-14T11:26:04.000Z", source: "automapper", phase: "started", event: "automapper-started", summary: "AutoMapper started" });
  api.recordEvent(runB, { timestamp: "2026-07-14T11:26:02.000Z", source: "course-loader", phase: "started", event: "course-loader-started", summary: "Course loader started" });
  api.recordEvent(runB, { timestamp: "2026-07-14T11:26:03.000Z", source: "saved-map", phase: "skipped", event: "saved-map-not-found", summary: "Saved map not found" });
  const firing = api.copyFiringList(runB);
  assert(firing.indexOf("Course loader started") < firing.indexOf("Saved map not found"), "events remain chronological");
  assert(firing.indexOf("Saved map not found") < firing.indexOf("AutoMapper started"), "AutoMapper appears in combined firing list");

  api.recordEvent(runB, { source: "automapper", phase: "failed", event: "automapper-failed", summary: "AutoMapper failed", details: { inputGeometryCount: 94, token: "secret-token" } });
  api.recordEvent(runB, { source: "native-resolver", phase: "started", event: "native-resolver-started", summary: "Native resolver started" });
  api.recordEvent(runB, { source: "native-resolver", phase: "failed", event: "native-resolver-failed", summary: "Native resolver failed", confidence: 0.68, details: { shape: pointArray(20), imageDataUrl: "data:image/png;base64,AAAA" } });
  api.recordEvent(runB, { source: "manual-fallback", phase: "fallback", event: "manual-fallback-opened", summary: "Manual fallback opened" });
  api.attachCheckpoint(runB, { stage: "fairway-lines", createdAt: "2026-07-14T11:26:06.000Z", imageDataUrl: svgDataUrl("fairway-lines"), metadata: { candidateCount: 18 } });

  assert(api.copyFiringList(runB).includes("Native resolver"), "native resolver events appear in combined firing list");
  assert(api.copyFiringList(runB).includes("Manual fallback"), "manual fallback events appear in combined firing list");

  const autoText = api.copyAutoMapperFeedback(runB);
  assert(autoText.includes("AUTOMAPPER FEEDBACK"), "AutoMapper copy has AutoMapper header");
  assert(!autoText.includes("NATIVE RESOLVER FEEDBACK"), "AutoMapper copy contains AutoMapper data only");
  assert(!autoText.includes("secret-token"), "AutoMapper copy excludes tokens");

  const resolverText = api.copyResolverFeedback(runB);
  assert(resolverText.includes("NATIVE RESOLVER FEEDBACK"), "resolver copy has resolver header");
  assert(!resolverText.includes("AUTOMAPPER FEEDBACK"), "resolver copy contains resolver data only");

  const full = api.copyFullReport(runB);
  assert(full.includes("FIRING LIST"), "full report combines firing list");
  assert(full.includes("AUTOMAPPER FEEDBACK"), "full report combines AutoMapper feedback");
  assert(full.includes("NATIVE RESOLVER FEEDBACK"), "full report combines resolver feedback");
  assert(full.includes("CHECKPOINTS"), "full report combines checkpoint availability");
  assert(!full.includes("data:image"), "normal report excludes image data URLs");
  assert(!full.includes("\"lat\""), "normal report excludes giant raw geometry arrays");

  const visualRun = api.startRun({ courseId: "visual", courseName: "Visual Course" });
  api.attachCheckpoint(visualRun, {
    stage: "initial-snapshot",
    createdAt: "2026-07-14T11:27:01.000Z",
    imageDataUrl: svgDataUrl("initial"),
    metadata: {
      viewport: { center: { lat: -45.1, lng: 169.2 }, zoom: 16 },
      bounds: { south: -45.2, west: 169.1, north: -45.0, east: 169.3 },
      overlayCounts: { sourceFeatures: 90, acceptedGreens: 18, rejectedGreens: 1, fairways: 14, tees: 18, candidates: 0 },
      geometryIds: { acceptedGreens: ["way-201"], candidates: [] }
    }
  });
  api.attachCheckpoint(visualRun, {
    stage: "fairway-lines",
    createdAt: "2026-07-14T11:27:02.000Z",
    imageDataUrl: svgDataUrl("fairways"),
    metadata: {
      viewport: { center: { lat: -45.1, lng: 169.2 }, zoom: 16 },
      bounds: { south: -45.2, west: 169.1, north: -45.0, east: 169.3 },
      overlayCounts: { sourceFeatures: 90, acceptedGreens: 18, rejectedGreens: 1, fairways: 14, tees: 18, candidates: 18 },
      geometryIds: { acceptedGreens: ["way-201"], candidates: ["way-101", "way-102"] }
    }
  });
  api.attachCheckpoint(visualRun, {
    stage: "number-allocation",
    createdAt: "2026-07-14T11:27:03.000Z",
    imageDataUrl: svgDataUrl("numbers"),
    metadata: {
      viewport: { center: { lat: -45.1, lng: 169.2 }, zoom: 16 },
      bounds: { south: -45.2, west: 169.1, north: -45.0, east: 169.3 },
      overlayCounts: { sourceFeatures: 90, acceptedGreens: 18, rejectedGreens: 1, fairways: 14, tees: 18, candidates: 18 },
      geometryIds: { acceptedGreens: ["way-201"], candidates: ["way-101", "way-103"] }
    }
  });
  const visualHtml = api._test.checkpointsHtml(api.getRun(visualRun));
  assert.strictEqual((visualHtml.match(/<img alt=/g) || []).length, 3, "checkpoint SVG payload is rendered as image previews");
  assert(visualHtml.includes("Initial Snapshot"), "initial snapshot card renders");
  assert(visualHtml.includes("Fairway Lines"), "fairway lines card renders");
  assert(visualHtml.includes("Number Allocation"), "number allocation card renders");
  assert.notStrictEqual(api.getRun(visualRun).checkpoints[0].imageDataUrl, api.getRun(visualRun).checkpoints[1].imageDataUrl, "initial and fairway previews are distinct payloads");
  assert.notStrictEqual(api.getRun(visualRun).checkpoints[1].imageDataUrl, api.getRun(visualRun).checkpoints[2].imageDataUrl, "fairway and number previews are distinct payloads");
  assert(visualHtml.includes("features 90 / greens 18 / fairways 14 / tees 18 / lines 18"), "overlay counts render in checkpoint card");
  assert(visualHtml.includes("way-101"), "candidate IDs render in checkpoint card");
  assert(visualHtml.includes("S -45.2 W 169.1 N -45 E 169.3"), "bounds render in checkpoint card");
  assert(!visualHtml.includes("&lt;svg"), "SVG source is not rendered as escaped text");
  api.attachCheckpoint(visualRun, { stage: "number-allocation", createdAt: "2026-07-14T11:27:04.000Z", metadata: { overlayCounts: { sourceFeatures: 0, candidates: 0 } } });
  const missingPreviewHtml = api._test.checkpointsHtml(api.getRun(visualRun));
  assert(missingPreviewHtml.includes("No visual preview payload found"), "missing preview shows explicit error state");

  const persistedVisualStorage = env.sessionStorage;
  const restoredVisual = loadDebug({ role: "admin", sessionStorage: persistedVisualStorage });
  const restoredVisualHtml = restoredVisual.api._test.checkpointsHtml(restoredVisual.api.getRun(visualRun));
  assert(restoredVisualHtml.includes("<img"), "checkpoint SVG payload survives debug session restore");

  const quietRun = api.startRun({ courseId: "quiet", courseName: "Quiet Lifecycle" });
  api.recordEvent(quietRun, { source: "automapper", phase: "failed", event: "automapper-failed", summary: "AutoMapper failed" });
  const quietFull = api.copyFullReport(quietRun);
  assert(!quietFull.includes("Handoff warning"), "normal terminal stage events do not create handoff warnings");
  assert(!quietFull.includes("repair"), "diagnostics do not invent lifecycle repairs");

  const staleRun = api.startRun({ courseId: "cromwell", courseName: "Cromwell Golf Course", attemptToken: "cromwell-token-1234567890" });
  const activeMaungakiekie = {
    runId: "map-run-maungakiekie",
    courseId: "maungakiekie-golf-club",
    courseName: "Maungakiekie Golf Club",
    resolutionKey: "maungakiekie-golf-club:h1",
    attemptToken: "maungakiekie-token-0987654321"
  };
  api.recordStaleActivity({
    staleRunId: staleRun,
    stale: { courseId: "cromwell", courseName: "Cromwell Golf Course", resolutionKey: "cromwell:h1:center:-45.0381,169.2048:resolver", attemptToken: "cromwell-token-1234567890" },
    active: activeMaungakiekie,
    attemptedAction: "open-manual-fallback",
    rejectionReason: "active mapping attempt changed",
    callerFunction: "resolveCoursePlayHole",
    source: "native-resolver",
    event: "native-resolver-stale-result-rejected",
    summary: "Native resolver stale result rejected",
    lateByMs: 16900
  });
  const staleReport = api.copyFullReport(staleRun);
  assert(api.getRun(staleRun).status === "superseded", "stale run becomes superseded");
  assert(staleReport.includes("STALE ACTIVITY"), "full report includes stale activity section");
  assert(staleReport.includes("Cromwell Golf Course"), "stale report names stale course");
  assert(staleReport.includes("Maungakiekie Golf Club"), "stale report names active course");
  assert(staleReport.includes("resolveCoursePlayHole"), "stale report includes caller provenance");
  assert(staleReport.includes("...1234567890"), "stale report keeps useful token suffix");
  assert(!staleReport.includes("cromwell-token-1234567890"), "stale report redacts full stale token");
  api.recordStaleActivity({
    stale: { courseId: "orphan", courseName: "Orphan Course", resolutionKey: "orphan:h1", attemptToken: "orphan-token-abcdef" },
    active: activeMaungakiekie,
    attemptedAction: "open-manual-fallback",
    callerFunction: "legacy-callback",
    source: "manual-fallback"
  });
  assert(api.copyFullReport(staleRun).includes("orphan"), "orphan stale activity is retained for inspection");

  const unusual = api.startRun({ courseId: "odd", courseName: "Odd Order" });
  api.recordEvent(unusual, { source: "native-resolver", phase: "started", summary: "Native first" });
  api.recordEvent(unusual, { source: "automapper", phase: "started", summary: "AutoMapper second" });
  api.recordEvent(unusual, { source: "manual-fallback", phase: "fallback", summary: "Manual third" });
  assert(api.copyFullReport(unusual).includes("Observed: Native resolver -> AutoMapper -> Manual fallback"), "unusual firing order is displayed accurately");

  const stale = api.startRun({ courseId: "stale", courseName: "Stale Run" });
  const active = api.startRun({ courseId: "active", courseName: "Active Run" });
  api.recordEvent(stale, { source: "course-loader", phase: "superseded", summary: "Old run superseded" });
  const activeRun = api.getRun(active);
  assert(!activeRun.events.some((event) => event.summary === "Old run superseded"), "stale run events cannot attach to the active run accidentally");

  for (let i = 0; i < 14; i += 1) api.startRun({ courseId: `bounded-${i}`, courseName: `Bounded ${i}` });
  assert(api.getRecentRuns().length <= 10, "recent-run history is bounded");

  const copyOk = await api.copyDebugText("copy me");
  assert.strictEqual(copyOk, true, "clipboard fallback works when navigator.clipboard fails");
  assert.strictEqual(env.fallbackCopied(), true, "temporary textarea fallback was used");
  assert.strictEqual(env.alertCalled(), false, "copy success state does not use alert");

  const adminEnv = loadDebug({ role: "admin" });
  const devEnv = loadDebug({ role: "developer" });
  const playerEnv = loadDebug({ role: "player" });
  assert.strictEqual(adminEnv.api.canViewDebug(), true, "admin permission can view debug");
  assert.strictEqual(devEnv.api.canViewDebug(), true, "developer permission can view debug");
  assert.strictEqual(playerEnv.api.canViewDebug(), false, "normal players cannot view debug");

  const restoredStorage = env.sessionStorage;
  const restored = loadDebug({ role: "admin", sessionStorage: restoredStorage });
  const restoredRaw = restored.api.copyRawJson(runB);
  assert(!restoredRaw.includes("data:image/svg"), "page refresh restores only lightweight checkpoint metadata");

  const beforeLocalKeys = Object.keys(env.sessionStorage.data).length;
  api.recordEvent(runB, { source: "persistence", phase: "skipped", summary: "No production course data changed", details: { existingTrustedMap: true } });
  assert(Object.keys(env.sessionStorage.data).length >= beforeLocalKeys, "diagnostics use debug session mirror only");
  assert.strictEqual(typeof api.runNextTool, "undefined", "diagnostics do not control tool invocation");

  api.recordEvent(runB, { source: "manual-fallback", phase: "cancelled", summary: "Manual fallback cancelled" });
  assert(api.getRun(runB).status === "cancelled", "cancelled runs are labelled correctly");

  console.log("course-mapping-debug tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
