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
  assert.strictEqual(env.debugStarts.length, 1, "pipeline wait starts one debug run");
  assert.strictEqual(env.debugStarts[0].courseId, "maungakiekie-golf-club", "run starts with selected course id");
  assert(/^pipeline:maungakiekie-golf-club:h1:/.test(env.debugStarts[0].attemptToken), "run token uses selected course key");
  assert.strictEqual(env.window.__gdCourseMappingDebugActiveAttempt.resolutionKey, "maungakiekie-golf-club:h1", "active attempt stores selected resolution key");

  env.advance(7501);
  env.api.syncGpsPipelineState("interval", 1);
  assert(env.fallbackOpts(), "pipeline timeout opens fallback");
  assert.strictEqual(env.fallbackOpts().resolutionKey, "maungakiekie-golf-club:h1", "fallback uses selected resolution key");
  assert.strictEqual(env.fallbackOpts().attemptToken, env.debugStarts[0].attemptToken, "fallback reuses timestamped pipeline attempt token");
  assert(env.debugEvents.some((row) => row.event && row.event.event === "pipeline-timeout"), "timeout is recorded on the debug run");

  env.window.gdAutoMapOsmCourse = () => Promise.resolve({ saved: 2, holes: 18 });
  env.api.installCourseLibraryAdapter();
  const staleAttempt = {
    runId: "map-run-cromwell",
    debugRunId: "map-run-cromwell",
    courseId: "cromwell",
    courseName: "Cromwell Golf Course",
    hole: 1,
    resolutionKey: "cromwell:h1:center:-45.0381,169.2048:resolver",
    attemptToken: "cromwell-token"
  };
  env.window.__gdCourseMappingDebugActiveAttempt = {
    runId: "map-run-maungakiekie",
    debugRunId: "map-run-maungakiekie",
    courseId: "maungakiekie-golf-club",
    courseName: "Maungakiekie Golf Club",
    hole: 1,
    resolutionKey: "maungakiekie-golf-club:h1",
    attemptToken: "maungakiekie-token"
  };
  await env.window.gdAutoMapOsmCourse({
    course: { courseId: "cromwell", courseName: "Cromwell Golf Course" },
    debugRunId: staleAttempt.runId,
    attemptToken: staleAttempt.attemptToken,
    resolutionKey: staleAttempt.resolutionKey,
    debugAttemptContext: staleAttempt
  });
  assert(env.staleRecords.some((row) => row.attemptedAction === "ingest-automapper-output"), "stale AutoMapper ingest is rejected");
  assert(env.api.getDebugTimeline().some((row) => row.type === "automapper-stale-ingest-rejected"), "pipeline records stale automapper rejection");

  console.log("course-play-pipeline-debug tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
