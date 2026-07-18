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
assert(pickerSearch.includes('if(/manual|tap|click|map|green-focus|pin/.test(source))return null;'), "course picker search ignores simulated/map-derived points as GPS");
assert(pickerSearch.includes("return distanceDelta;"), "GPS course ties prefer the closest course");
assert(appCore.includes("const setCourseView=opts.setCourseView!==undefined?!!opts.setCourseView:hasCoursePoint;"), "selected search/course coordinates drive the map view");
assert(appCore.includes("if(!Number.isFinite(at)||at<=0||Date.now()-at>maxAgeMs)return null;"), "course picker requires a timestamped recent GPS fix");
assert(appCore.includes("function gdResetCoursePickerPresentationReadiness(payload)"), "new course selections clear stale captured presentation readiness");
assert(appCore.includes("if(!gdCoursePickerHasMappedPlayData(payload,1))return false;"), "course picker only opens mapped start when the selected course has mapped play data");
assert(appCore.includes('document.body.dataset.gdCourseNeedsPin=result&&result.fallback?"active":result&&result.playable?"no":"pending";'), "course picker records when the pin fallback owns unresolved courses");
assert(appCore.includes("function gdCoursePickerNeedsCoursePin(payload)"), "course picker can detect when a no-GPS course pick needs a pin screen");
assert(appCore.includes("if(gdCoursePickerNeedsCoursePin(payload))return gdShowCoursePinScreen(payload);"), "no-GPS course picks show the pin screen before course play opens");
assert(appCore.includes('mark("needs-pin")'), "pin decision writes a DOM breadcrumb for live QA");
assert(appCore.includes("window.gdConfirmCoursePin=gdConfirmCoursePin"), "pin confirmation is exposed for the picker panel");
assert(pickerBaseCss.includes(".courseScreen{position:absolute;inset:0;z-index:7600;background:transparent"), "course picker overlay leaves the live map visible behind the controls");
assert(pickerBaseCss.includes(".gdCoursePinScreen"), "course picker includes the no-GPS pin prompt styling");
assert(pickerBaseCss.includes(".courseScreen.gdCoursePinMode #gdCourseResumeRound{display:none!important}"), "pin mode hides the stale resume-round panel");
assert(gpsRuntimeCss.includes("body.shell-gps.gdCoursePickerOpen #map"), "GPS runtime CSS keeps the map visible under the course picker");
assert(gpsRuntime.includes('document.body.dataset.gdGpsMapVisibilityState=pickerOpen()?"picker-live-map":"not-gps"'), "GPS runtime owner treats picker as a live-map state");
assert(gpsRuntime.includes('document.body.dataset.gdCourseNeedsPin==="choose-course-pin"'), "GPS wrapper does not start a resume round while the pin prompt is active");
assert(library.includes("return recentGpsPoint();"), "library session center falls back only to actual recent GPS");
assert(library.includes("lat:finder?.lat??saved.courseLat??null"), "course library open does not invent coordinates");
assert(library.includes("course?loadUserCourseData(userId(),courseId(course)):loadUserCourseData()"), "mapped checks load the explicit selected course instead of stale active course data");
assert(library.includes("const hasTrustedPlayData=requestedHolePlayable(course,expected);"), "settled course-open UI requires trusted mapped data for the requested hole");
assert(index.includes("gd-app-base.css?v=course-picker-live-gps-pin-20260718"), "base CSS cache-bust ships the pin prompt styling");
assert(index.includes("gd-app-core.js?v=course-picker-live-gps-pin-20260718"), "app core cache-bust ships the strict GPS pin guard");
assert(index.includes("gd-course-picker-search-v2.js?v=course-picker-live-gps-pin-20260718"), "course picker search cache-bust ships the strict GPS tie-breaker");
assert(index.includes("gd-course-library-pin-lock.js?v=course-picker-pin-fallback-20260718"), "course library cache-bust ships the pin fallback guard");
assert(index.includes("gd-gps-play-runtime-owner-v1.js?v=course-picker-pin-screen-20260718"), "GPS runtime cache-bust ships the pin prompt wrapper guard");

console.log("course-picker-location tests passed");
