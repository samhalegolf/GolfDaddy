const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const shellSource = fs.readFileSync(path.join(__dirname, "..", "scripts", "gd-shell.js"), "utf8");

class ClassList {
  constructor() { this.set = new Set(); }
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
    this.classList = new ClassList();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.textContent = "";
    this.onclick = null;
    this.onpointerdown = null;
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
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeAttribute(name) {
    if (name === "hidden") this.hidden = false;
  }
  setAttribute(name, value) {
    this[name] = String(value);
  }
  querySelectorAll(selector) {
    return this.ownerDocument.querySelectorAll(selector);
  }
}

function makeDocument() {
  const document = {
    elements: {},
    readyState: "loading",
    listeners: {},
    createElement(tag) { return new Element(tag, document); },
    getElementById(id) { return this.elements[id] || null; },
    addEventListener(type, handler) {
      this.listeners[type] = this.listeners[type] || [];
      this.listeners[type].push(handler);
    },
    querySelectorAll(selector) {
      const all = Object.values(this.elements);
      if (selector === ".modulePanel.open,.panel.open") {
        return all.filter((el) => (el.classList.contains("modulePanel") || el.classList.contains("panel")) && el.classList.contains("open"));
      }
      return [];
    }
  };
  document.body = document.createElement("body");
  document.body.id = "body";
  [
    "shellHome",
    "courseScreen",
    "shellTop",
    "shellDock",
    "shellBackBtn",
    "shellHomeBtn",
    "shellProfileReturnBtn",
    "shellSettingsBtn",
    "shellRouteLabel",
    "profilePanel",
    "bagPanel",
    "settingsPanel",
    "developerPanel",
    "dataHubPanel",
    "gdProfileV67",
    "gdCoursePinScreen",
    "hint",
    "app"
  ].forEach((id) => {
    const el = document.createElement(id.endsWith("Btn") ? "button" : "div");
    el.id = id;
    if (["profilePanel", "bagPanel", "settingsPanel", "developerPanel", "dataHubPanel"].includes(id)) el.className = "modulePanel";
    if (id === "courseScreen" || id === "gdCoursePinScreen" || id === "gdProfileV67") el.classList.add("hidden");
    document.body.appendChild(el);
  });
  return document;
}

function createHarness() {
  const document = makeDocument();
  const calls = { gpsLeave: 0, settings: 0, profileReturn: 0 };
  const window = {
    document,
    console,
    CustomEvent: function CustomEvent(type, init) { return { type, detail: init && init.detail }; },
    dispatchEvent() {},
    setTimeout(fn) { fn(); return 1; },
    clearTimeout() {},
    map: { invalidateSize() {} },
    ClarityRouter: { remember() {} },
    ClaritySession: { sync() {} },
    GolfDaddyAccounts: { returnToOwnProfile() {} },
    GDGpsPlayRuntime: { leave() { calls.gpsLeave++; } },
    openSettings() { calls.settings++; return false; },
    gdReturnToProfileWorkspace() { calls.profileReturn++; return false; }
  };
  const context = vm.createContext(Object.assign(window, { window, globalThis: window }));
  vm.runInContext(shellSource, context, { filename: "gd-shell.js" });
  return { window, document, calls };
}

function visible(el) {
  return !!el && !el.classList.contains("hidden") && el.style.display !== "none" && el.style.visibility !== "hidden";
}

function assertOneSurface(document, expected) {
  const surfaces = {
    home: visible(document.getElementById("shellHome")),
    picker: visible(document.getElementById("courseScreen")),
    profile: visible(document.getElementById("gdProfileV67")),
    profilePanel: document.getElementById("profilePanel").classList.contains("open"),
    bag: document.getElementById("bagPanel").classList.contains("open"),
    settings: document.getElementById("settingsPanel").classList.contains("open"),
    admin: document.getElementById("developerPanel").classList.contains("open"),
    dataHub: document.getElementById("dataHubPanel").classList.contains("open")
  };
  surfaces.gps = document.body.classList.contains("shell-gps") && !surfaces.picker && !surfaces.profile && !surfaces.profilePanel && !surfaces.bag && !surfaces.settings && !surfaces.admin && !surfaces.dataHub;
  const active = Object.keys(surfaces).filter((key) => surfaces[key]);
  assert.deepStrictEqual(active, [expected], `only ${expected} is visible`);
}

const env = createHarness();
const { window, document, calls } = env;
const shell = window.GDShell;

shell.init();
assert.strictEqual(shell.getState().route, "home", "boot starts at Home route");
assert(document.body.classList.contains("shell-home"), "Home compatibility class is active");
assertOneSurface(document, "home");
assert.strictEqual(document.getElementById("shellRouteLabel").textContent, "Home", "Home route label is owned by Shell");

shell.openCoursePicker({ source: "test-play", returnTarget: "home" });
assert.strictEqual(shell.getState().route, "course-picker", "Play opens Course Picker route");
assert.strictEqual(shell.getState().gpsActive, false, "Course Picker is not GPS Play state");
assert(document.body.classList.contains("gdCoursePickerOpen"), "picker compatibility class is derived");
assertOneSurface(document, "picker");

shell.back();
assert.strictEqual(shell.getState().route, "home", "Back from picker returns Home");
assertOneSurface(document, "home");

shell.enterGps({ source: "playable-course" });
assert.strictEqual(shell.getState().route, "gps", "valid course enters GPS route");
assert(document.body.classList.contains("shell-gps"), "GPS compatibility class is active");
assert(!document.body.classList.contains("gdCoursePickerOpen"), "GPS route clears picker class");
assertOneSurface(document, "gps");

shell.openModule("profile", { fromGps: true });
assert.strictEqual(shell.getState().route, "module", "profile opens module route");
assert.strictEqual(shell.getState().module, "profile", "profile module identity is tracked");
assertOneSurface(document, "profilePanel");

shell.openModule("settings", { fromGps: true });
assertOneSurface(document, "settings");
assert(!document.getElementById("profilePanel").classList.contains("open"), "opening a second module closes the first");
assert.strictEqual(document.getElementById("shellRouteLabel").textContent, "Settings", "module route label matches active module");

shell.back();
assert.strictEqual(shell.getState().route, "gps", "Back from GPS-returning module returns GPS");
assert(document.body.classList.contains("shell-gps"), "Back to GPS restores GPS shell class");
assertOneSurface(document, "gps");

shell.home();
assert.strictEqual(shell.getState().route, "home", "Home command returns Home");
assert.strictEqual(calls.gpsLeave, 1, "Home from GPS calls GPS runtime leave hook once");
assertOneSurface(document, "home");

document.getElementById("shellSettingsBtn").onclick({ preventDefault() {}, stopPropagation() {} });
assert.strictEqual(calls.settings, 1, "Settings button delegates content to settings owner");

document.getElementById("shellProfileReturnBtn").onclick({ preventDefault() {}, stopPropagation() {} });
assert.strictEqual(calls.profileReturn, 1, "profile-return button delegates profile workspace action");

console.log("shell-behavior tests passed");
