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

function classList(initial = []) {
  const set = new Set(initial);
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

function loadPipeline() {
  const realDate = Date;
  let fakeNow = 1784018580000;
  function FakeDate(...args) {
    return args.length ? new realDate(...args) : new realDate(fakeNow);
  }
  FakeDate.now = () => fakeNow;
  FakeDate.parse = realDate.parse;
  FakeDate.UTC = realDate.UTC;
  FakeDate.prototype = realDate.prototype;

  const localStorage = storage();
  const sessionStorage = storage({ gd_active_playing_hole: "1" });
  const debugStarts = [];
  const debugEvents = [];
  const staleRecords = [];
  let fallbackOpts = null;
  const body = {
    dataset: {},
    classList: classList(["gps-active"]),
    appendChild(node) { node.parentNode = body; }
  };
  const document = {
    body,
    getElementById() { return null; },
    createElement() {
      return {
        id: "",
        textContent: "",
        setAttribute() {},
        parentNode: null
      };
    }
  };
  const selectedCourse = {
    courseId: "maungakiekie-golf-club",
    courseName: "Maungakiekie Golf Club",
    name: "Maungakiekie Golf Club",
    courseCentre: { lat: -36.9229754, lng: 174.7254871 }
  };
  const window = {
    document,
    localStorage,
    sessionStorage,
    gdActiveCourse: selectedCourse,
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
    dispatchEvent() {},
    GolfDaddyCourseLibrary: {
      mappingCourseSnapshot() { return Object.assign({}, selectedCourse); },
      activateMappingAttempt(entry) { window.__gdCourseMappingDebugActiveAttempt = entry; return entry; },
      activeMappingDebugAttempt() { return window.__gdCourseMappingDebugActiveAttempt || null; },
      isCurrentMappingAttempt(attempt) {
        const active = window.__gdCourseMappingDebugActiveAttempt || {};
        return !!attempt && active.runId === (attempt.runId || attempt.debugRunId) && active.attemptToken === attempt.attemptToken;
      }
    },
    GDCourseMappingDebug: {
      startRun(input) {
        debugStarts.push(input);
        return "debug-run-1";
      },
      recordEvent(runId, event) {
        debugEvents.push({ runId, event });
        return event;
      },
      recordStaleActivity(input) {
        staleRecords.push(input);
        return input;
      }
    },
    gdBeginInteractiveGreenFallback(course, hole, reason, opts) {
      fallbackOpts = Object.assign({ course, hole, reason }, opts || {});
      window.__gdCoursePlayInteractiveFallbackActive = {
        course,
        hole,
        key: opts && opts.resolutionKey,
        attemptToken: opts && opts.attemptToken,
        debugRunId: opts && opts.debugRunId
      };
      return true;
    }
  };
  window.ClarityCaddieCourseLibrary = window.GolfDaddyCourseLibrary;

  const context = {
    window,
    document,
    localStorage,
    sessionStorage,
    console,
    Date: FakeDate,
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    CustomEvent: window.CustomEvent
  };
  const code = fs.readFileSync(path.join(__dirname, "..", "scripts", "gd-course-play-pipeline.js"), "utf8");
  vm.runInNewContext(code, context, { filename: "gd-course-play-pipeline.js" });
  return {
    api: context.window.GDCoursePlayPipeline,
    window: context.window,
    localStorage,
    debugStarts,
    debugEvents,
    staleRecords,
    fallbackOpts: () => fallbackOpts,
    advance(ms) { fakeNow += ms; }
  };
}

async function main() {
  const env = loadPipeline();
  assert(env.api, "pipeline API exports");

  env.api.syncGpsPipelineState("course-picker", 1);
  assert.strictEqual(env.debugStarts.length, 0, "pipeline does not start mapping debug runs");
  assert.strictEqual(env.window.__gdCourseMappingDebugActiveAttempt, undefined, "pipeline does not publish active mapping attempts");

  env.advance(7501);
  env.api.syncGpsPipelineState("interval", 1);
  assert.strictEqual(env.fallbackOpts(), null, "pipeline timeout does not open fallback");
  assert(env.api.getDebugTimeline().some((row) => row.type === "gps-play-pipeline-waiting-for-mapping-controller"), "pipeline records controller-owned fallback wait");

  const originalAutoMap = () => Promise.resolve({ saved: 2, holes: 18 });
  env.window.gdAutoMapOsmCourse = originalAutoMap;
  env.api.installCourseLibraryAdapter();
  assert.strictEqual(env.window.gdAutoMapOsmCourse, originalAutoMap, "pipeline adapter does not wrap AutoMapper");
  assert(env.api.getDebugTimeline().some((row) => row.type === "course-library-adapter-passive"), "pipeline records passive adapter mode");
  assert.strictEqual(env.staleRecords.length, 0, "pipeline adapter does not own stale AutoMapper ingestion");

  const tileHeavyManifest = {
    key: "gd_captured_hole_frame_v19_maungakiekie:h1",
    originPx: { x: 100, y: 200 },
    imageWidth: 4096,
    imageHeight: 4096,
    captureZoom: 18,
    anchorPins: { tee: { lat: -36.924, lng: 174.725 }, green: { lat: -36.923, lng: 174.726 }, route: [] },
    tiles: Array.from({ length: 700 }, (_, index) => ({ x: index, y: index, z: 18, tileX: index, tileY: index, url: `https://tiles.example/${index}.jpg` }))
  };
  env.api.registerCoursePlayFrame(env.window.gdActiveCourse, 1, tileHeavyManifest, { manifestKey: tileHeavyManifest.key, status: "generated" });
  const frameIndex = JSON.parse(env.localStorage.data.gd_course_play_frame_index_v1);
  const frame = frameIndex.frames["maungakiekie-golf-club:h1"];
  assert.strictEqual(frame.tileCount, 700, "frame index preserves tile count");
  assert.strictEqual(frame.tileMetadata.length, 0, "frame index does not duplicate every tile URL");

  console.log("course-play-pipeline-debug tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
