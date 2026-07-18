const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const appCore = fs.readFileSync(path.join(root, "scripts", "gd-app-core.js"), "utf8");
const pickerSearch = fs.readFileSync(path.join(root, "scripts", "inline", "gd-course-picker-search-v2.js"), "utf8");
const pickerBaseCss = fs.readFileSync(path.join(root, "styles", "inline", "gd-app-base.css"), "utf8");
const gpsRuntimeCss = fs.readFileSync(path.join(root, "styles", "inline", "gd-gps-play-runtime-owner-v1-css.css"), "utf8");
const gpsRuntime = fs.readFileSync(path.join(root, "scripts", "inline", "gd-gps-play-runtime-owner-v1.js"), "utf8");
const library = fs.readFileSync(path.join(root, "scripts", "gd-course-library-pin-lock.js"), "utf8");

for (const [label, source] of [["index.html", index], ["gd-course-library-pin-lock.js", library]]) {
  assert(!/-36\.9149|174\.7255/.test(source), `${label} must not contain the old Maungakiekie fallback coordinate`);
}

assert(appCore.includes("const GD_NEUTRAL_MAP_CENTER=[0,0];"), "map boots to a neutral technical center");
assert(appCore.includes("return null;\n}\nfunction gdAssumedCourseLabelForPicker"), "course picker returns no default point when location is unknown");
assert(pickerSearch.includes("requestPickerGps();"), "course picker requests GPS for nearby suggestions");
assert(pickerSearch.includes("window.gdCoursePickerRequestGps=requestPickerGps"), "home/play route can request picker GPS from a user click");
assert(pickerSearch.includes("window.gdCoursePickerCenterMapOnGps=centerPickerMapOnGps"), "course picker can center the live map on the latest GPS fix");
assert(pickerSearch.includes("map.setView([Number(point.lat),Number(point.lng)],zoom,{animate:false})"), "GPS fix recenters the map behind the course picker");
assert(pickerSearch.includes("const gps=recentGpsPoint();"), "course picker ranking uses actual recent GPS when available");
assert(pickerSearch.includes("return distanceDelta;"), "GPS course ties prefer the closest course");
assert(appCore.includes("const setCourseView=opts.setCourseView!==undefined?!!opts.setCourseView:hasCoursePoint;"), "selected search/course coordinates drive the map view");
assert(pickerBaseCss.includes(".courseScreen{position:absolute;inset:0;z-index:7600;background:transparent"), "course picker overlay leaves the live map visible behind the controls");
assert(gpsRuntimeCss.includes("body.shell-gps.gdCoursePickerOpen #map"), "GPS runtime CSS keeps the map visible under the course picker");
assert(gpsRuntime.includes('document.body.dataset.gdGpsMapVisibilityState=pickerOpen()?"picker-live-map":"not-gps"'), "GPS runtime owner treats picker as a live-map state");
assert(library.includes("return recentGpsPoint();"), "library session center falls back only to actual recent GPS");
assert(library.includes("lat:finder?.lat??saved.courseLat??null"), "course library open does not invent coordinates");

console.log("course-picker-location tests passed");
