/* The course search has one owner of what is on screen.
 *
 * Written from the 2026-09-09 audit (COURSE_SEARCH_AUDIT_2026-09-09.md). The
 * player-visible bugs were "the good ranking gets replaced a moment later" and
 * "the first tap does nothing". Both came from four renderers writing into the
 * same two nodes on their own timers, plus a silent async selection whose token
 * let a second tap cancel the first.
 *
 * Unlike course-picker-behavior.test.js this harness also loads the REAL
 * competing code: gd-app-core.js's document-capture click handler and its
 * Enter listener (lifted from source, not re-typed), so the test fails if
 * either starts winning again.
 *
 * Run: node dev/course-search-owner.test.js */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const pickerSource = fs.readFileSync(path.join(ROOT, "scripts", "inline", "gd-course-picker-search-v2.js"), "utf8");
const coreSource = fs.readFileSync(path.join(ROOT, "scripts", "gd-app-core.js"), "utf8");
const pinLockSource = fs.readFileSync(path.join(ROOT, "scripts", "gd-course-library-pin-lock.js"), "utf8");

function coreFn(signature) {
  const idx = coreSource.indexOf(signature);
  assert.notStrictEqual(idx, -1, "could not find in core: " + signature);
  let depth = 0, started = false;
  for (let i = idx; i < coreSource.length; i++) {
    if (coreSource[i] === "{") { depth++; started = true; }
    else if (coreSource[i] === "}") { depth--; if (started && depth === 0) return coreSource.slice(idx, i + 1); }
  }
  throw new Error("unbalanced braces after " + signature);
}
const coreEnterLine = (coreSource.match(/^document\.getElementById\("searchInput"\)\?\.addEventListener\("keydown".*$/m) || [])[0];
assert.ok(coreEnterLine, "core still binds Enter on #searchInput (lift it for the harness)");

/* ---------------------------------------------------------------- fake DOM */
class ClassList {
  constructor() { this.set = new Set(); }
  add(...n) { n.forEach((x) => this.set.add(x)); }
  remove(...n) { n.forEach((x) => this.set.delete(x)); }
  contains(n) { return this.set.has(n); }
  toggle(n, f) { const on = f === undefined ? !this.set.has(n) : !!f; if (on) this.set.add(n); else this.set.delete(n); return on; }
}
class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.parentNode = null;
    this.dataset = {}; this.style = {}; this.classList = new ClassList(); this.listeners = {};
    this.textContent = ""; this.value = ""; this.__innerHTML = ""; this.rebuilds = 0;
  }
  set id(v) { this._id = v; if (v) this.ownerDocument.elements[v] = this; }
  get id() { return this._id; }
  set className(v) { this._className = v; this.classList = new ClassList(); String(v || "").split(/\s+/).filter(Boolean).forEach((n) => this.classList.add(n)); }
  get className() { return this._className || ""; }
  set innerHTML(v) {
    this.__innerHTML = String(v || "");
    this.children.forEach((c) => { c.parentNode = null; });
    this.children = [];
    this.rebuilds++;
    if (this.id === "gdCourseAssumedOption") {
      for (const m of this.__innerHTML.matchAll(/data-course-index="(\d+)"/g)) {
        const child = this.ownerDocument.createElement("div"); child.className = "courseAssumedBlock"; child.dataset.courseIndex = m[1]; this.appendChild(child);
      }
    }
    /* A real DOM parses the row markup; the core's fallback payload reads .name. */
    const name = this.__innerHTML.match(/<div class="name">([^<]*)<\/div>/);
    if (name) { const n = this.ownerDocument.createElement("div"); n.className = "name"; n.textContent = name[1]; this.appendChild(n); }
    const play = this.__innerHTML.match(/<button class="play"[^>]*>([^<]*)<\/button>/);
    if (play) { const b = this.ownerDocument.createElement("button"); b.className = "play"; b.textContent = play[1]; this.appendChild(b); }
  }
  get innerHTML() { return this.__innerHTML; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  focus() {}
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  querySelectorAll(s) {
    const cls = { ".courseAssumedBlock": "courseAssumedBlock", "#courseScreen .course": "course", ".course": "course", ".name": "name", ".play": "play" }[s];
    return cls ? this.children.filter((c) => c.classList.contains(cls)) : [];
  }
  closest(selector) {
    const parts = selector.split(",").map((x) => x.trim()); let node = this;
    while (node) {
      for (const p of parts) {
        if (p === "#courseScreen .course" && node.classList && node.classList.contains("course")) return node;
        if ((p === "#gdCourseAssumedOption .courseAssumedBlock" || p === ".courseAssumedBlock") && node.classList && node.classList.contains("courseAssumedBlock")) return node;
      }
      node = node.parentNode;
    }
    return null;
  }
  addEventListener(t, h) { (this.listeners[t] = this.listeners[t] || []).push(h); }
}
function makeDocument() {
  const document = {
    elements: {}, readyState: "complete", documentElement: new ClassList(), listeners: {},
    createElement(t) { return new Element(t, document); },
    getElementById(id) { return this.elements[id] || null; },
    querySelectorAll() { return []; },
    addEventListener(t, h) { (this.listeners[t] = this.listeners[t] || []).push(h); }
  };
  document.body = document.createElement("body");
  for (const id of ["courseScreen", "gdCourseAssumedOption", "courseList", "countLine", "searchInput", "shellHome", "courseLine"]) {
    const el = document.createElement(id === "searchInput" ? "input" : "div"); el.id = id;
  }
  return document;
}

/* ---------------------------------------------------------------- world */
const AK = { lat: -36.9174953, lng: 174.7400425 };
const MK = { lat: -36.9229754, lng: 174.7254871 };
function fetchFor(net) {
  return function (url) {
    url = String(url);
    if (url.includes("nominatim")) {
      net.nominatim++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve([
        { name: "Akarana Golf Club", display_name: "Akarana Golf Club, Mount Roskill, Auckland, New Zealand", lat: String(AK.lat + 0.0012), lon: String(AK.lng + 0.001), type: "golf_course", class: "leisure", address: { state: "Auckland", country: "New Zealand", country_code: "nz" } }
      ]) });
    }
    if (url.includes("course-maps")) {
      net.courseMaps++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ courses: {
        akarana: { id: "akarana-golf-club", courseName: "Akarana Golf Club", courseLat: AK.lat, courseLng: AK.lng, region: "Auckland", country: "New Zealand", holes: { 1: {} } },
        maunga: { id: "maungakiekie-golf-club", courseName: "Maungakiekie Golf Club", courseLat: MK.lat, courseLng: MK.lng, holes: { 1: {} } }
      } }) });
    }
    if (url.includes("courses-near")) {
      net.coursesNear++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ partial: false, courses: [
        { name: "Akarana Golf Club", courseId: "akarana-golf-club", lat: AK.lat, lng: AK.lng, hasMap: true, distanceM: 180 },
        { name: "Maungakiekie Golf Club", courseId: "maungakiekie-golf-club", lat: MK.lat, lng: MK.lng, hasMap: true, distanceM: 1500 },
        { name: "Chamberlain Park Golf Course", lat: -36.88, lng: 174.72, hasMap: false, distanceM: 4300 },
        { name: "Remuera Golf Club", lat: -36.89, lng: 174.80, hasMap: false, distanceM: 6100 }
      ] }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
  };
}

function createHarness(options = {}) {
  const document = makeDocument();
  const net = { nominatim: 0, courseMaps: 0, coursesNear: 0, dbChecks: 0, loadingShown: [], loadingHidden: 0 };
  const storage = new Map();
  const window = {};
  Object.assign(window, {
    document, console, setTimeout: (fn) => { fn(); return 1; }, clearTimeout() {},
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    getComputedStyle: () => ({ display: "flex", visibility: "" }),
    localStorage: { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { geolocation: { getCurrentPosition() {} } },
    map: { setView() {}, getZoom() { return 16; }, invalidateSize() {}, getCenter() { return { lat: 0, lng: 0 }; } },
    location: { href: "" },
    gdGpsState: options.gpsState || {},
    ClarityPermissions: { canUse: () => Promise.resolve({ allowed: true }) },
    GolfDaddyCourseLibrary: { knownCourseCandidates() { return options.knownCourses || []; }, mappingCourseSnapshot(c) { return c; } },
    GDCoursePickerCoreBridge: {
      normalizeCourse(c) { return Object.assign({}, c); }, applyStoredPin(c) { return Object.assign({}, c); },
      isManual(c) { return /^manual gps$/i.test(String(c && (c.name || c.courseName) || "")); },
      hasPoint(c) { return Number.isFinite(Number(c && c.lat)) && Number.isFinite(Number(c && c.lng)); },
      payloadFromSelectionElement(element) {
        const row = element && element.closest && element.closest("#gdCourseAssumedOption .courseAssumedBlock,#courseScreen .course");
        if (!row) return null;
        if (row.__gdCoursePayload) return Object.assign({}, row.__gdCoursePayload);
        const name = (row.querySelector(".name") && row.querySelector(".name").textContent) || row.dataset.gdCourseName || "Manual GPS";
        return { name, lat: null, lng: null, courseId: row.dataset.gdCourseId || "" };
      },
      databaseMapAvailable() { net.dbChecks++; return new Promise(() => {}); /* slow manifest fetch that never returns */ },
      needsCoursePin() { return false; }, showPin() { return false; }, hidePin() {},
      hasMappedPlayData() { return false; }, prepareMappingSurface() {}, openManualCourse() { return false; }
    },
    runCourseMappingAttempt() { return new Promise(() => {}); },
    gdEnsureResumeRoundPicker() { return null; },
    gdClearMappedStartPromptChrome() {},
    gdOpenChangeCourse() { return false; },
    GDCourseLoading: { show(name, sub) { net.loadingShown.push({ name, sub }); }, update() {}, hide() { net.loadingHidden++; } },
    fetch: fetchFor(net)
  });
  const context = vm.createContext(Object.assign(window, { window, globalThis: window }));
  vm.runInContext(pickerSource, context, { filename: "gd-course-picker-search-v2.js" });
  /* The competing code, lifted from gd-app-core.js as it is today. */
  vm.runInContext(coreFn("function gdWireCoursePickerPlay(){") + "\ngdWireCoursePickerPlay();\n" + coreEnterLine, context, { filename: "gd-app-core.js (lifted)" });
  return { window, document, net };
}
function click(env, target) {
  let stopped = false;
  const event = { target, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() { stopped = true; } };
  for (const h of env.document.listeners.click || []) { h(event); if (stopped) return "core-capture"; }
  for (const h of env.document.getElementById("courseScreen").listeners.click || []) h(event);
  return "owner";
}
function pressEnter(env) {
  for (const h of env.document.getElementById("searchInput").listeners.keydown || []) h({ key: "Enter" });
}
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const rows = (env) => env.document.getElementById("courseList").children.filter((c) => c.classList.contains("course"));
const rowNames = (env) => rows(env).map((c) => c.__gdFacilityPayload ? "[facility] " + c.querySelector(".name").textContent : c.__gdAreaPayload ? "[area] " + c.querySelector(".name").textContent : c.__gdCoursePayload.name);
const dividers = (env) => env.document.getElementById("courseList").children.filter((c) => c.classList.contains("courseListDivider"));
const countText = (env) => env.document.getElementById("countLine").textContent;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("Enter runs one search and one Nominatim request, with the core listener still bound", async () => {
  const env = createHarness();
  env.window.GDCoursePicker.open({ source: "home-play", returnTarget: "home" });
  await settle();
  env.document.getElementById("searchInput").value = "akarana";
  pressEnter(env);
  await settle();
  assert.strictEqual(env.document.getElementById("searchInput").listeners.keydown.length, 2, "both Enter listeners are really bound in this harness");
  assert.strictEqual(env.net.nominatim, 1, "one Enter press, one Nominatim request");
});

test("the ranked result stays on top; the neighbourhood is added below it, never in place of it", async () => {
  const env = createHarness();
  env.window.GDCoursePicker.open({ source: "home-play" });
  await settle();
  env.document.getElementById("searchInput").value = "akarana";
  env.window.GDCoursePicker.search();
  await settle(8);
  const tapped = rows(env).find((r) => r.__gdCoursePayload && r.__gdCoursePayload.name === "Akarana Golf Club");
  assert.ok(tapped, "the ranked render put the match on screen");
  await settle();
  assert.strictEqual(env.net.coursesNear, 1, "one place, so the neighbourhood was asked for");
  const names = rowNames(env);
  assert.strictEqual(names[0], "Akarana Golf Club", "the query match is still first");
  assert.deepStrictEqual(names.slice(1), ["Maungakiekie Golf Club", "Chamberlain Park Golf Course", "Remuera Golf Club"], "nearby courses follow, deduped against the result");
  assert.strictEqual(dividers(env).length, 1, "a divider separates what was searched for from what is merely near it");
  assert.ok(/Also near Auckland, New Zealand/.test(dividers(env)[0].textContent), "and says which place it means");
  assert.strictEqual(countText(env), "1 found", "the count line keeps counting the search, not the neighbourhood");
  assert.strictEqual(tapped.parentNode, env.document.getElementById("courseList"), "the row the player may already be touching was not torn down when the neighbourhood arrived");
});

test("opening the picker and searching does not churn the nearby block", async () => {
  const env = createHarness();
  const option = env.document.getElementById("gdCourseAssumedOption");
  env.window.GDCoursePicker.open({ source: "home-play" });
  await settle();
  const afterOpen = option.rebuilds;
  assert.ok(afterOpen <= 2, "open() rebuilt the nearby block " + afterOpen + " times; it was seven");
  env.document.getElementById("searchInput").value = "akarana";
  env.window.GDCoursePicker.search();
  await settle();
  assert.strictEqual(option.rebuilds, afterOpen, "a search does not rebuild the nearby block at all");
  /* The pin-lock's after-every-click refresh, as it now calls in. */
  assert.ok(/window\.GDCoursePicker\.refreshAssumed\(candidate\);return;/.test(pinLockSource), "pin-lock asks the owner instead of writing the list");
  env.window.GDCoursePicker.refreshAssumed({ name: "Akarana Golf Club", assumedCandidate: true, lat: AK.lat, lng: AK.lng });
  env.window.gdRefreshCourseAssumedOption({ name: "Assumed course -36.92, 174.74", assumedCandidate: true });
  assert.strictEqual(option.rebuilds, afterOpen, "the click-driven candidate refresh is a no-op when nothing changed");
});

test("a tap is acknowledged at once and a repeat tap on the same course is a no-op", async () => {
  const env = createHarness();
  env.window.GDCoursePicker.renderCourses([{ name: "Akarana Golf Club", courseId: "akarana-golf-club", lat: AK.lat, lng: AK.lng }]);
  const row = rows(env)[0];
  assert.strictEqual(click(env, row), "owner", "the owner's own listener handles the row, not the core capture");
  await settle(2);
  assert.ok(row.classList.contains("selecting"), "the row shows it was taken");
  assert.strictEqual(row.querySelector(".play").textContent, "Play", "the button does not relabel itself - the loading screen is the acknowledgement");
  assert.deepStrictEqual(env.net.loadingShown, [{ name: "Akarana Golf Club", sub: "Opening…" }], "the loading screen went up on the tap, before the database check answered");
  assert.strictEqual(env.net.loadingHidden, 0, "and stays up while the check is in flight");
  assert.strictEqual(countText(env), "Opening Akarana Golf Club…");
  const token = env.window.GDCoursePicker.getState().activeToken;
  click(env, row);
  await settle(2);
  assert.strictEqual(env.net.dbChecks, 1, "the second tap did not start a second check");
  assert.strictEqual(env.window.GDCoursePicker.getState().activeToken, token, "and did not replace the first tap's token, so its answer is not discarded");
});

test("a facility 'Choose' row opens the chooser instead of mapping the facility label", async () => {
  const env = createHarness();
  env.window.GDCoursePicker.renderCourses([
    { name: "Te Arai Links - North Course", courseId: "te-arai-north", facilityKey: "te-arai", lat: -36.16, lng: 174.63, source: "database-course", hasDatabaseMap: true },
    { name: "Te Arai Links - South Course", courseId: "te-arai-south", facilityKey: "te-arai", lat: -36.17, lng: 174.64, source: "database-course", hasDatabaseMap: true }
  ]);
  const facility = rows(env).find((r) => r.__gdFacilityPayload);
  assert.ok(facility, "a facility row was offered");
  assert.strictEqual(click(env, facility), "owner");
  await settle(2);
  assert.deepStrictEqual(rowNames(env), ["Te Arai Links - North Course", "Te Arai Links - South Course"], "the chooser lists the members");
  assert.strictEqual(countText(env), "2 courses");
  assert.strictEqual(env.net.dbChecks, 0, "nothing was selected");
  assert.ok(!env.window.__gdLiveCoursePickerSelection, "and no selection was recorded");
});

test("with a query, an exact name beats a nearer partial match even when GPS is on", async () => {
  const env = createHarness({
    gpsState: { lastFix: { lat: -36.9300, lng: 174.7420, source: "course-picker", simulated: false }, lastFixAt: Date.now(), permissionKnown: true, permissionGranted: true },
    knownCourses: [
      { name: "Akarana Park Pitch And Putt", courseId: "akarana-park", lat: -36.9302, lng: 174.7421 },
      { name: "Akarana Golf Club", courseId: "akarana-golf-club", lat: AK.lat, lng: AK.lng }
    ]
  });
  env.window.GDCoursePicker.renderCourses([]);
  env.document.getElementById("searchInput").value = "Akarana Golf Club";
  env.window.GDCoursePicker.search();
  await settle(4);
  assert.strictEqual(rowNames(env)[0], "Akarana Golf Club", "the course the player named is first, not the one they are standing next to");
});

test("the legacy core handlers stand down when the owner is loaded", () => {
  const wire = coreFn("function gdWireCoursePickerPlay(){");
  assert.ok(/if\(window\.GDCoursePicker\)return;/.test(wire), "the capture click handler defers to the owner");
  assert.ok(/e\.key==="Enter"&&!window\.GDCoursePicker/.test(coreEnterLine), "the core Enter listener defers to the owner");
  assert.ok(!/onclick="gdConfirmAssumedCourse/.test(fs.readFileSync(path.join(ROOT, "index.html"), "utf8")), "the static nearby block has no second inline click path");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (error) { failed++; console.log("  FAIL " + t.name + "\n       " + (error && error.message)); }
  }
  if (failed) { console.log("course-search-owner: " + failed + " failed"); process.exit(1); }
  console.log("course-search-owner passed: " + tests.length + " checks");
})();
