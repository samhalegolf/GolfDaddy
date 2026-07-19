const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "scripts", "gd-course-location.js"), "utf8");

function storage() {
  const data = {};
  return {
    data,
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    removeItem(key) { delete data[key]; }
  };
}

const localStorage = storage();
const window = {
  dispatchEvent() {},
  GolfDaddyAccounts: { current() { return { accountId: "acct-1" }; } }
};
const context = {
  window,
  localStorage,
  console,
  CustomEvent: function CustomEvent(type, init) { return { type, detail: init && init.detail }; },
  activePlayerProfile() { return { id: "player-1", name: "Player One", accountId: "acct-1" }; }
};
context.globalThis = context;

vm.runInNewContext(source, context, { filename: "gd-course-location.js" });

assert(window.GDCourseLocation, "GDCourseLocation owner is exposed");
for (const name of ["init", "normalize", "resolve", "get", "propose", "confirm", "update", "remove", "attachToCourse", "getState", "destroy"]) {
  assert.strictEqual(typeof window.GDCourseLocation[name], "function", `GDCourseLocation exposes ${name}`);
}

const course = { courseId: "akarana-golf-club", courseName: "Akarana Golf Club" };
assert.strictEqual(window.GDCourseLocation.get(course), null, "built-in/search centres are not silently confirmed");

const gpsProposal = window.GDCourseLocation.propose(course, { lat: -36.917, lng: 174.74, source: "course-picker", simulated: false }, { source: "course-picker-gps-proposal", realGpsOnly: true });
assert(gpsProposal && gpsProposal.confirmed === false, "real picker GPS is proposal-only");
assert.strictEqual(window.GDCourseLocation.propose(course, { lat: -36.91, lng: 174.73, source: "tap-where-standing", simulated: true }, { realGpsOnly: true }), null, "simulated/manual proposals are rejected as GPS");

const confirmed = window.GDCourseLocation.confirm(course, { lat: -36.91749, lng: 174.74004 }, { source: "course-picker-pin" });
assert(confirmed && confirmed.confirmed, "explicit confirmation creates confirmed course-location truth");
assert.deepStrictEqual(JSON.parse(JSON.stringify(confirmed.centre)), { lat: -36.91749, lng: 174.74004 });

const attached = window.GDCourseLocation.attachToCourse(course, { requireConfirmed: true });
assert.strictEqual(attached.courseLocationConfirmed, true, "confirmed state attaches to selected-course identity");
assert.deepStrictEqual(JSON.parse(JSON.stringify(attached.courseCentre)), { lat: -36.91749, lng: 174.74004 }, "canonical centre attaches for mapping");
assert.strictEqual(attached.gdTrustedCoursePin, true, "confirmed owner location remains trusted for scanner seed");

const pinStore = JSON.parse(localStorage.data.gd_course_picker_course_pins_v1);
assert(pinStore["akarana-golf-club"], "legacy picker pin store remains compatibility-backed");
assert.strictEqual(pinStore["akarana-golf-club"].confirmed, true);

const libraryStore = JSON.parse(localStorage.data.gd_user_course_library_v1);
const savedCourse = Object.values(libraryStore.courses)[0];
assert(savedCourse.courseLocation.confirmed, "course library record stores canonical courseLocation");
assert.strictEqual(savedCourse.finderLat, -36.91749, "course library finder fields stay compatible");
assert.deepStrictEqual(savedCourse.objects, {}, "course-location owner does not write hole geometry");
assert.deepStrictEqual(savedCourse.holes, {}, "course-location owner does not write hole labels");

assert.strictEqual(window.GDCourseLocation.remove(course), true, "owner supports deleting a confirmed course location");
const removedPins = JSON.parse(localStorage.data.gd_course_picker_course_pins_v1);
assert(!removedPins["akarana-golf-club"], "remove clears legacy picker pin");
const removedStore = JSON.parse(localStorage.data.gd_user_course_library_v1);
const removedCourse = Object.values(removedStore.courses)[0];
assert.strictEqual(removedCourse.finderLat, undefined, "remove clears finder latitude");
assert.strictEqual(removedCourse.courseLocation, undefined, "remove clears canonical location");

console.log("course-location-owner tests passed");
