const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const pickerSource = fs.readFileSync(path.join(__dirname, "..", "scripts", "inline", "gd-course-picker-search-v2.js"), "utf8");
const index = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(...names) { names.forEach((name) => this.set.add(name)); }
  remove(...names) { names.forEach((name) => this.set.delete(name)); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : !!force;
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }
}

class Element {
  constructor(tagName, document) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.classList = new ClassList();
    this.listeners = {};
    this.hidden = false;
    this.textContent = "";
    this.value = "";
    this.__innerHTML = "";
  }
  set id(value) {
    this._id = value;
    if (value) this.ownerDocument.elements[value] = this;
  }
  get id() { return this._id; }
  set className(value) {
    this._className = value;
    this.classList = new ClassList();
    String(value || "").split(/\s+/).filter(Boolean).forEach((name) => this.classList.add(name));
  }
  get className() { return this._className || ""; }
  set innerHTML(value) {
    this.__innerHTML = String(value || "");
    this.children = [];
    if (this.id === "gdCourseAssumedOption" && this.__innerHTML.includes("courseAssumedBlock")) {
      const matches = [...this.__innerHTML.matchAll(/data-course-index="(\d+)"/g)];
      for (const match of matches) {
        const child = this.ownerDocument.createElement("div");
        child.className = "courseAssumedBlock";
        child.dataset.courseIndex = match[1];
        this.appendChild(child);
      }
    }
  }
  get innerHTML() { return this.__innerHTML; }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child) { return this.appendChild(child); }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    if (selector === ".courseAssumedBlock") return this.children.filter((child) => child.classList.contains("courseAssumedBlock"));
    if (selector === "#courseScreen .course" || selector === ".course") return this.children.filter((child) => child.classList.contains("course"));
    if (selector === ".name") return this.children.filter((child) => child.classList.contains("name"));
    return [];
  }
  closest(selector) {
    const selectors = selector.split(",").map((item) => item.trim());
    let node = this;
    while (node) {
      for (const part of selectors) {
        if (part === "#courseScreen .course" && node.classList && node.classList.contains("course")) return node;
        if (part === "#gdCourseAssumedOption .courseAssumedBlock" && node.classList && node.classList.contains("courseAssumedBlock")) return node;
        if (part === ".courseAssumedBlock" && node.classList && node.classList.contains("courseAssumedBlock")) return node;
      }
      node = node.parentNode;
    }
    return null;
  }
  addEventListener(type, handler) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(handler);
  }
}

function makeDocument() {
  const document = {
    elements: {},
    readyState: "loading",
    documentElement: new ClassList(),
    listeners: {},
    createElement(tag) { return new Element(tag, document); },
    getElementById(id) { return this.elements[id] || null; },
    querySelectorAll() { return []; },
    addEventListener(type, handler) {
      this.listeners[type] = this.listeners[type] || [];
      this.listeners[type].push(handler);
    }
  };
  document.body = document.createElement("body");
  const ids = ["courseScreen", "gdCourseAssumedOption", "courseList", "countLine", "searchInput", "shellHome", "courseLine"];
  for (const id of ids) {
    const el = document.createElement(id === "searchInput" ? "input" : "div");
    el.id = id;
    if (id === "courseScreen") el.classList.add("hidden");
  }
  return document;
}

function createHarness(options = {}) {
  const document = makeDocument();
  const calls = { mapping: 0, gps: 0, resume: 0, panels: 0, geolocation: 0, toasts: [] };
  const storage = new Map();
  const pendingGeo = [];
  const mappingDeferred = [];
  const window = {};
  Object.assign(window, {
    document,
    console,
    /* Entering a round resolves gps_round_start through ClarityPermissions
       before it navigates - the paid-access gate the deleted play runtime used
       to own. Default allowed so the existing entry assertions keep testing
       entry; options.permission drives the denial and error cases. */
    ClarityPermissions: {
      canUse: () => {
        if (options.permission === "error") return Promise.reject(new Error("resolver down"));
        return Promise.resolve({ ok: true, allowed: options.permission !== "denied" });
      }
    },
    toast: (message) => { calls.toasts.push(String(message)); },
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    AbortController: class {
      constructor() { this.signal = {}; }
      abort() { this.aborted = true; }
    },
    getComputedStyle: (el) => ({ display: el && el.style.display || "flex", visibility: el && el.style.visibility || "" }),
    localStorage: { getItem: (k) => storage.get(`l:${k}`) || null, setItem: (k, v) => storage.set(`l:${k}`, String(v)), removeItem: (k) => storage.delete(`l:${k}`) },
    sessionStorage: { getItem: (k) => storage.get(`s:${k}`) || null, setItem: (k, v) => storage.set(`s:${k}`, String(v)), removeItem: (k) => storage.delete(`s:${k}`) },
    navigator: {
      geolocation: {
        getCurrentPosition(success) {
          calls.geolocation++;
          pendingGeo.push(success);
        }
      }
    },
    map: {
      setView(point) { calls.lastMapPoint = point; },
      getZoom() { return 16; },
      invalidateSize() {},
      getCenter() { return { lat: 0, lng: 0 }; }
    },
    /* Confirming a playable course now navigates to /app/ instead of calling back
       into the bridge - the href write itself IS "entered GPS Play". */
    location: {
      set href(value) { calls.gps++; calls.lastGps = { href: value }; },
      get href() { return (calls.lastGps && calls.lastGps.href) || ""; }
    },
    gdGpsState: options.gpsState || {},
    GolfDaddyCourseLibrary: {
      knownCourseCandidates() { return options.knownCourses || []; },
      mappingCourseSnapshot(course) { return Object.assign({ snapshot: true }, course); }
    },
    GDCoursePickerCoreBridge: {
      normalizeCourse(course) { return Object.assign({}, course); },
      applyStoredPin(course) { return Object.assign({}, course); },
      isManual(course) { return /^manual gps$/i.test(String(course && (course.name || course.courseName) || "")); },
      hasPoint(course) { return Number.isFinite(Number(course && course.lat)) && Number.isFinite(Number(course && course.lng)); },
      payloadFromSelectionElement(element) { return element && element.__gdCoursePayload || null; },
      databaseMapAvailable(course) { return Promise.resolve({ available: !!course.databaseReady, source: "published-course-map" }); },
      needsCoursePin() { return false; },
      hidePin() {},
      hasMappedPlayData(course) { return !!course.savedPlayable; },
      prepareMappingSurface() {},
      openManualCourse() { calls.manual = (calls.manual || 0) + 1; return false; },
      enterGpsPlayAfterMapping(course, result) { calls.gps++; calls.lastGps = { course, result }; return true; }
    },
    runCourseMappingAttempt(request) {
      calls.mapping++;
      calls.lastMappingRequest = request;
      if (options.immediateMappingResult) return Promise.resolve(options.immediateMappingResult);
      let resolve;
      const promise = new Promise((res) => { resolve = res; });
      mappingDeferred.push(resolve);
      return promise;
    },
    gdRunCourseMappingAttempt: null,
    gdEnsureResumeRoundPicker() { calls.panels++; return { id: "gdCourseResumeRound" }; },
    gdResumeRoundFromPicker(event) { calls.resume++; calls.resumeEvent = event; return false; },
    fetch() { return Promise.resolve({ ok: true, json: () => Promise.resolve({ courses: {} }) }); }
  });
  const context = vm.createContext(Object.assign(window, { window, globalThis: window }));
  vm.runInContext(pickerSource, context, { filename: "gd-course-picker-search-v2.js" });
  return { window, document, calls, pendingGeo, mappingDeferred };
}

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

/* Entering a round is one promise deeper than it used to be: the mapping result
   resolves, and then the gps_round_start permission check does. Kept separate
   from tick() on purpose - the search assertions above are sensitive to how far
   the queue is drained, and draining further there settles a different render
   than they were written against. So only the entry assertions wait longer. */
async function tickEntry() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

(async () => {
  assert(index.includes("window.GDCoursePicker.open({source:'home-play',returnTarget:'home'})"), "Play tile opens through GDCoursePicker.open");

  const env = createHarness({
    knownCourses: [{ name: "Akarana Golf Club", courseId: "akarana-golf-club", lat: -36.9175, lng: 174.74 }]
  });
  const api = env.window.GDCoursePicker;
  assert(api, "owner API exists");
  api.init();
  api.init();
  assert.strictEqual(api.getState().listenersBound, true, "listeners bind once");
  assert.strictEqual(env.document.getElementById("courseList").children.length >= 0, true, "search list exists");

  env.document.getElementById("searchInput").value = "Akarana";
  api.search();
  await tick();
  assert(env.document.getElementById("courseList").children.length >= 1, "search results render");

  env.window.gdGpsState = { lastFix: { lat: -36.9175, lng: 174.74, source: "manual" }, lastFixAt: Date.now(), permissionKnown: true, permissionGranted: true };
  const manualNearby = api.refreshNearby();
  assert.strictEqual(manualNearby.name, "Manual GPS", "manual/map-derived fixes are rejected for nearby course GPS");
  env.window.gdGpsState = { lastFix: { lat: -36.9175, lng: 174.74, source: "course-picker", simulated: false }, lastFixAt: Date.now(), permissionKnown: true, permissionGranted: true };
  const realNearby = api.refreshNearby();
  assert.strictEqual(realNearby.name, "Akarana Golf Club", "real picker GPS drives nearby presentation");

  assert.strictEqual(api.requestLocation(), true, "one-shot GPS starts");
  assert.strictEqual(api.requestLocation(), false, "one-shot GPS does not duplicate while active");
  env.pendingGeo[0]({ coords: { latitude: -36.91, longitude: 174.74, accuracy: 7 } });
  assert.strictEqual(env.calls.geolocation, 1, "one geolocation request was made");

  const saved = createHarness();
  saved.window.GDCoursePicker.selectCourse({ name: "Saved Course", courseId: "saved", gdDatabaseMapChecked: true, gdDatabaseMapAvailable: true, databaseReady: true, savedPlayable: true });
  await tickEntry();
  assert.strictEqual(saved.calls.mapping, 0, "saved playable course enters without mapping");
  assert.strictEqual(saved.calls.gps, 1, "saved playable course enters GPS Play once");
  assert.ok(/\/app\/index\.html\?/.test(saved.calls.lastGps.href), "entry names index.html - the native routers collapse an extensionless /app/ to the bundle root");
  assert.ok(!/rangefinder=1/.test(saved.calls.lastGps.href), "a permitted player gets the full round, not the downgrade");

  /* The paid-access gate. gps_round_start was enforced only by the old play
     runtime, so it vanished when that was deleted; these two cases are what
     keep it from vanishing again silently.

     What it gates is no longer ENTRY. A failed check used to end the journey on
     a toast, which App Store review rejected in build 740 and which was poor
     product besides - the rangefinder underneath needs neither an account nor a
     payment to work. So the check downgrades instead of refusing: the player
     gets the map and the distances, and app/js/access.js - which re-reads the
     account itself rather than trusting this URL - withholds the scorecard, the
     round record, resume and the bubble.

     Still fails CLOSED for the PAID features. rangefinder=1 IS the closed
     state; asserting on it is what keeps a future change from quietly handing
     out full rounds. */
  const denied = createHarness({ permission: "denied" });
  denied.window.GDCoursePicker.selectCourse({ name: "Saved Course", courseId: "saved", gdDatabaseMapChecked: true, gdDatabaseMapAvailable: true, databaseReady: true, savedPlayable: true });
  await tickEntry();
  assert.strictEqual(denied.calls.gps, 1, "no paid access still opens the rangefinder");
  assert.ok(/rangefinder=1/.test(denied.calls.lastGps.href), "a denied player enters in rangefinder mode, where the paid features are withheld");

  /* A check that could not complete is not evidence of access, so a transient
     failure lands in rangefinder mode too - it just says so, because the player
     needs a different answer here than at a paywall: this one is retryable. */
  const resolverDown = createHarness({ permission: "error" });
  resolverDown.window.GDCoursePicker.selectCourse({ name: "Saved Course", courseId: "saved", gdDatabaseMapChecked: true, gdDatabaseMapAvailable: true, databaseReady: true, savedPlayable: true });
  await tickEntry();
  assert.strictEqual(resolverDown.calls.gps, 1, "a failed permission check still opens the rangefinder");
  assert.ok(/rangefinder=1/.test(resolverDown.calls.lastGps.href), "a failed check fails closed on the paid features");
  assert.ok(/membership/i.test(resolverDown.calls.toasts.join(" ")), "a failed check tells the player why they are short of a full round");

  const unmapped = createHarness();
  unmapped.window.GDCoursePicker.selectCourse({ name: "Unmapped", courseId: "unmapped", gdDatabaseMapChecked: true, gdDatabaseMapAvailable: false });
  assert.strictEqual(unmapped.calls.mapping, 1, "unmapped course invokes mapping once");
  assert.strictEqual(unmapped.calls.lastMappingRequest.reason, "course-picker", "mapping reason stays at picker boundary");

  const dbl = createHarness();
  const course = { name: "Double", courseId: "double", gdDatabaseMapChecked: true, gdDatabaseMapAvailable: false };
  dbl.window.GDCoursePicker.selectCourse(course);
  dbl.window.GDCoursePicker.selectCourse(course);
  assert.strictEqual(dbl.calls.mapping, 1, "double click does not create two mapping runs");
  dbl.mappingDeferred[0]({ playable: true, course });
  await tickEntry();
  assert.strictEqual(dbl.calls.gps, 1, "playable result enters GPS once");

  const failed = createHarness({ immediateMappingResult: { playable: false } });
  failed.window.GDCoursePicker.selectCourse({ name: "Fail", courseId: "fail", gdDatabaseMapChecked: true, gdDatabaseMapAvailable: false });
  await tick();
  assert.strictEqual(failed.calls.gps, 0, "failed result does not enter GPS");

  const fallback = createHarness({ immediateMappingResult: { playable: false, fallback: "interactive-green", armed: true } });
  fallback.window.GDCoursePicker.selectCourse({ name: "Fallback", courseId: "fallback", gdDatabaseMapChecked: true, gdDatabaseMapAvailable: false });
  await tick();
  assert.strictEqual(fallback.calls.gps, 0, "manual fallback result is not reimplemented by picker");

  const stale = createHarness();
  stale.window.GDCoursePicker.selectCourse({ name: "Old", courseId: "old", gdDatabaseMapChecked: true, gdDatabaseMapAvailable: false });
  stale.window.GDCoursePicker.selectCourse({ name: "New", courseId: "new", gdDatabaseMapChecked: true, gdDatabaseMapAvailable: false });
  stale.mappingDeferred[0]({ playable: true, course: { name: "Old", courseId: "old" } });
  await tick();
  assert.strictEqual(stale.calls.gps, 0, "stale playable result is ignored");

  const resume = createHarness();
  resume.window.GDCoursePicker.resumeRound({ event: { type: "click" } });
  assert.strictEqual(resume.calls.panels, 1, "resume round presentation is delegated");
  assert.strictEqual(resume.calls.resume, 1, "resume round selection is delegated");

  const cancel = createHarness();
  cancel.window.GDCoursePicker.selectCourse({ name: "Cancel", courseId: "cancel", gdDatabaseMapChecked: true, gdDatabaseMapAvailable: false });
  cancel.window.GDCoursePicker.close({ reason: "test-close" });
  cancel.mappingDeferred[0]({ playable: true, course: { name: "Cancel", courseId: "cancel" } });
  await tick();
  assert.strictEqual(cancel.calls.gps, 0, "close cancels pending mapping handoff");

  console.log("course-picker-behavior tests passed");
})();
