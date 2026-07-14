const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const library = fs.readFileSync(path.join(root, "scripts", "gd-course-library-pin-lock.js"), "utf8");

for (const [label, source] of [["index.html", index], ["gd-course-library-pin-lock.js", library]]) {
  assert(!/-36\.9149|174\.7255/.test(source), `${label} must not contain the old Maungakiekie fallback coordinate`);
}

assert(index.includes("const GD_NEUTRAL_MAP_CENTER=[0,0];"), "map boots to a neutral technical center");
assert(index.includes("return null;\n}\nfunction gdAssumedCourseLabelForPicker"), "course picker returns no default point when location is unknown");
assert(index.includes("requestPickerGps();"), "course picker requests GPS for nearby suggestions");
assert(index.includes("const setCourseView=opts.setCourseView!==undefined?!!opts.setCourseView:hasCoursePoint;"), "selected search/course coordinates drive the map view");
assert(library.includes("return recentGpsPoint();"), "library session center falls back only to actual recent GPS");
assert(library.includes("lat:finder?.lat??saved.courseLat??null"), "course library open does not invent coordinates");

console.log("course-picker-location tests passed");
