const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const owner = fs.readFileSync(path.join(root, "scripts", "gd-course-location.js"), "utf8");
const core = fs.readFileSync(path.join(root, "scripts", "gd-app-core.js"), "utf8");
/* The admin Course Database moved out of core in the app/studio split - it is
   studio-only now, so these assertions follow it rather than being deleted. */
const adminDb = fs.readFileSync(path.join(root, "scripts", "studio", "gd-admin-course-db.js"), "utf8");
const picker = fs.readFileSync(path.join(root, "scripts", "inline", "gd-course-picker-search-v2.js"), "utf8");
const library = fs.readFileSync(path.join(root, "scripts", "gd-course-library-pin-lock.js"), "utf8");
const resolver = fs.readFileSync(path.join(root, "scripts", "gd-course-geometry-resolver.js"), "utf8");
const courseMaps = fs.readFileSync(path.join(root, "functions", "course-maps.mjs"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "structural-smoke.yml"), "utf8");

function before(source, first, second, message) {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  assert(a >= 0, `${message}: missing ${first}`);
  assert(b >= 0, `${message}: missing ${second}`);
  assert(a < b, message);
}

assert.strictEqual((owner.match(/window\.GDCourseLocation=api/g) || []).length, 1, "exactly one Course Location owner is assigned");
for (const name of ["init", "normalize", "resolve", "get", "propose", "confirm", "update", "remove", "attachToCourse", "getState", "destroy"]) {
  assert(owner.includes(name), `owner includes ${name}`);
}

assert(owner.includes("const PICKER_PIN_STORE_KEY=\"gd_course_picker_course_pins_v1\""), "owner reads legacy picker pin store");
assert(owner.includes("const COURSE_LIBRARY_STORE_KEY=\"gd_user_course_library_v1\""), "owner writes existing local course library store");
assert(owner.includes("const PUBLISHED_STORE_KEY=\"gd_published_course_library_v1\""), "owner reads existing published course store");
assert(owner.includes("function pointFrom(input)"), "owner normalizes coordinate spellings");
assert(owner.includes("finitePoint(input.courseCentre)") && owner.includes("finitePoint(input.courseCenter)"), "owner accepts centre and center spellings");
assert(owner.includes("input.courseLat") && owner.includes("input.courseLng"), "owner accepts courseLat/courseLng");
assert(owner.includes("input.lat??input.latitude"), "owner accepts lat/lng and latitude/longitude");
assert(owner.includes("if(/manual|tap|click|map|green-focus|pin|pretend|simulated/.test(source))return false;"), "owner rejects simulated/manual/map-derived GPS proposals");
assert(owner.includes("confirmed:opts.confirmed===true"), "owner separates proposed from confirmed records");
assert(owner.includes("persistLegacyPin(base,record)") && owner.includes("persistLibraryCourse(base,record)"), "confirmation persists through owner only");
assert(owner.includes("holes:existing.holes||{}") && owner.includes("objects:existing.objects||{}"), "owner preserves hole geometry instead of owning it");

const forbiddenOwnerInternals = [
  "autoMapOsmCourse",
  "resolveCourseGeometryForAutoMapper",
  "GDGreenShapeEngine",
  "beginInteractiveGreenFallback",
  "gdClaude",
  "claude-hole",
  "enterGpsModule",
  "setMappedPlayMode"
];
for (const forbidden of forbiddenOwnerInternals) {
  assert(!owner.includes(forbidden), `course-location owner must not implement protected system: ${forbidden}`);
}

before(index, "scripts/gd-course-location.js?v=course-location-owner-20260719", "scripts/gd-course-library-pin-lock.js", "course-location owner loads before course library consumers");
before(index, "scripts/gd-course-location.js?v=course-location-owner-20260719", "scripts/inline/gd-course-picker-search-v2.js", "course-location owner loads before picker consumers");

assert(core.includes("owner&&typeof owner.get===\"function\""), "core stored pin lookup delegates to GDCourseLocation.get");
assert(core.includes("owner&&typeof owner.confirm===\"function\""), "core pin confirmation delegates to GDCourseLocation.confirm");
assert(core.includes("owner&&typeof owner.attachToCourse===\"function\""), "core selected-course identity delegates to GDCourseLocation.attachToCourse");
assert(core.includes('mark("confirmed-course-location");return false;'), "confirmed owner location can bypass the picker pin prompt");
assert(adminDb.includes("gdAdminCourseLocationMarkup(selected,payload)"), "Course Database/admin overview displays course-location status");
assert(index.includes('data-gd-surface="studio" src="scripts/studio/gd-admin-course-db.js'), "the admin Course Database loads as a studio-only script");
assert(adminDb.includes("window.gdAdminCourseLocationEdit=gdAdminCourseLocationEdit"), "Course Database/admin exposes edit location action");
assert(adminDb.includes("window.gdAdminCourseLocationRemove=gdAdminCourseLocationRemove"), "Course Database/admin exposes remove location action");

assert(picker.includes("window.GDCourseLocation.propose"), "picker GPS request creates proposal-only course-location context");
assert(picker.includes("owner.attachToCourse(applied,{requireConfirmed:false})"), "picker normalizes selected-course identity through owner");
assert(picker.includes("owner.resolve(course,{requireConfirmed:pinSeed||course?.courseLocationConfirmed===true})"), "mapping request receives owner-resolved centre");
assert(picker.includes("const usePinSeed=!course.gdDatabaseMapAvailable&&course.courseLocationConfirmed===true&&courseHasPoint(course);"), "scanner pin seed requires confirmed owner location");
assert(picker.includes("courseCentre:pinnedCentre||undefined"), "mapping controller receives explicit resolved course centre");

assert(library.includes("owner.attachToCourse({...snap,courseCentre:opts.courseCentre||opts.courseCenter||snap.courseCentre||snap.courseCenter},{requireConfirmed:false})"), "mapping snapshots attach owner-resolved course centre");
assert(library.includes("const resolved=owner&&typeof owner.resolve==='function'&&!isManualGpsCourse(c)?owner.resolve(c,{requireConfirmed:false}):null;"), "assumed-course matching consults owner before GPS fallback");
assert(library.includes("const resolved=owner&&typeof owner.get==='function'?owner.get(course):null;"), "Course Library finder reads owner-confirmed centre first");
assert(library.includes("owner.confirm(c,{lat,lng},{source:source||'course-library-finder'})"), "Course Library finder saves through owner");
/* The library's "clear this course's location" control went with the mapper UI
   (2026-07-28). Removing a whole course replaced it, and carries the same
   obligation: the owner holds the picker pin in a different store and caches the
   active centre, so a delete that skips it strands both. */
assert(library.includes("owner.remove(course,{source:'course-library-remove-course'})"), "Course Library course removal releases the location through owner");
assert(resolver.includes("toPoint(input.courseCentre)") && resolver.includes("toPoint(input.courseCenter)"), "native resolver remains a consumer of centre input only");

assert(courseMaps.includes("courseLocation: locationPoint ? {"), "cloud course-map sanitizer preserves owner metadata");
assert(courseMaps.includes("courseLat: finite(input.courseLat ?? (locationPoint && locationPoint.lat))"), "cloud course-map sanitizer publishes canonical centre columns");

assert(workflow.includes("node dev/course-location-owner.test.js"), "CI runs course-location owner test");
assert(workflow.includes("node dev/course-location-behavior.test.js"), "CI runs course-location behavior test");

console.log("course-location-behavior tests passed");
