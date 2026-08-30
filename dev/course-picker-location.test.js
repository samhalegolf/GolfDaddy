const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const appCore = fs.readFileSync(path.join(root, "scripts", "gd-app-core.js"), "utf8");
const pickerSearch = fs.readFileSync(path.join(root, "scripts", "inline", "gd-course-picker-search-v2.js"), "utf8");
const pickerBaseCss = fs.readFileSync(path.join(root, "styles", "inline", "gd-app-base.css"), "utf8");
const gpsRuntimeCss = fs.readFileSync(path.join(root, "styles", "inline", "gd-gps-play-runtime-owner-v1-css.css"), "utf8");
const brandRail = fs.readFileSync(path.join(root, "scripts", "inline", "gd-brand-icon-render.js"), "utf8");
const library = fs.readFileSync(path.join(root, "scripts", "gd-course-library-pin-lock.js"), "utf8");
const coursePickerMappingPrep = pickerSearch.slice(
  pickerSearch.indexOf("function prepareMappingSurface"),
  pickerSearch.indexOf("function enterGpsPlay")
);

for (const [label, source] of [["index.html", index], ["gd-course-library-pin-lock.js", library]]) {
  assert(!/-36\.9149|174\.7255/.test(source), `${label} must not contain the old Maungakiekie fallback coordinate`);
}

assert(appCore.includes("const GD_NEUTRAL_MAP_CENTER=[0,0];"), "map boots to a neutral technical center");
assert(appCore.includes("return null;\n}\nfunction gdAssumedCourseLabelForPicker"), "course picker returns no default point when location is unknown");
assert(pickerSearch.includes("requestPickerGps();"), "course picker requests GPS for nearby suggestions");
assert(pickerSearch.includes("window.gdCoursePickerRequestGps=function(){return api.requestLocation();};"), "home/play route can request picker GPS through the picker owner");
assert(pickerSearch.includes("window.gdCoursePickerCenterMapOnGps=function(point){return api.centerMapOnLocation(point);};"), "course picker can center the live map through the picker owner");
assert(pickerSearch.includes("map.setView([Number(point.lat),Number(point.lng)],zoom,{animate:false})"), "GPS fix recenters the map behind the course picker");
assert(pickerSearch.includes("const gps=recentGpsPoint();"), "course picker ranking uses actual recent GPS when available");
assert(pickerSearch.includes('if(/manual|tap|click|map|green-focus|pin/.test(source))return null;'), "course picker search ignores simulated/map-derived points as GPS");
assert(pickerSearch.includes("return distanceDelta;"), "GPS course ties prefer the closest course");
assert(pickerSearch.includes("const course=basePayload({"), "recent course rows are sanitized before re-entering the course picker flow");
assert(appCore.includes("const setCourseView=opts.setCourseView!==undefined?!!opts.setCourseView:hasCoursePoint;"), "selected search/course coordinates drive the map view");
assert(appCore.includes("if(!Number.isFinite(at)||at<=0||Date.now()-at>maxAgeMs)return null;"), "course picker requires a timestamped recent GPS fix");
assert(appCore.includes("function gdResetCoursePickerPresentationReadiness(payload,opts={})"), "new course selections clear stale captured presentation readiness");
assert(appCore.includes("if(!gdCoursePickerHasMappedPlayData(payload,1))return false;"), "course picker only opens mapped start when the selected course has mapped play data");
assert(pickerSearch.includes('document.body.dataset.gdCourseNeedsPin=result&&result.fallback?"active":result&&result.playable?"no":waiting?"waiting":"pending";'), "course picker records when the pin fallback owns unresolved courses");
/* "waiting" has to be its own value here. A course the server is still building has produced
   no result at all yet, and reporting that as "pending" made it indistinguishable from an
   attempt that finished and found nothing - which is the reading that used to send a player
   into manual mapping while their scan was still running. */
assert(pickerSearch.includes('const waiting=!!(result&&result.waiting);'), "a course still being prepared is a state of its own, not a finished empty attempt");
assert(appCore.includes("function gdCoursePickerNeedsCoursePin(payload)"), "course picker can detect when a no-GPS course pick needs a pin screen");
/* ---- a scan that is still running is not a scan that failed ----
 *
 * A first-time mapping job is enqueued as a side effect of the first package request and can
 * outlast the client's wait budget. When that happened the resolver armed the manual
 * green-tap fallback, which is terminal - so a job that finished a minute later could never be
 * used, and the course was permanently unopenable no matter how often the player pressed Play.
 * These three lines are the shape of the fix; losing any of them brings that back. */
assert(library.includes("if(serverWait&&serverWait.timedOut&&serverWait.stillProcessing){"), "a wait that ran out on a LIVE job must extend, not fall back");
assert(library.includes("timedOut:true,stillProcessing:status==='processing'"), "the wait has to report WHICH way it ran out, or the branch above cannot tell");
assert(library.includes("'player-chose-basic-gps'"), "manual green-tapping while the server is still working is only ever reached by the player choosing it");
/* "A published map beats the pin prompt" used to be a branch in the gate. It is
   now the default for every course, mapped or not: the pin prompt is a repair
   reached only from a failed mapper verdict, so having a map is no longer a
   special case that needs its own escape hatch. */
assert(appCore.includes('if(payload&&payload.gdCourseFitTrusted===false){'), "only a failed mapper fit verdict may demand a pin");
assert(!appCore.includes('mark("stored-pin");return false;'), "stored pins prefill the pin screen but do not bypass it");
assert(!appCore.includes('mark("recent-live-gps");return false;'), "recent GPS does not bypass the no-database-map pin screen");
assert(appCore.includes("function gdCoursePickerCheckDatabaseThenOpen(payload)"), "course picker checks the database map before deciding whether to pin");
assert(!appCore.includes("published-course-visual"), "course visuals do not count as database maps for the picker pin gate");
assert(appCore.includes("if(!payload.gdDatabaseMapChecked&&!gdCoursePayloadIsManual(payload))return gdCoursePickerCheckDatabaseThenOpen(payload);"), "course picker gates non-manual course opens behind a database map check");
assert(appCore.includes("if(gdCoursePickerNeedsCoursePin(payload))return gdShowCoursePinScreen(payload);"), "no-GPS course picks show the pin screen before course play opens");
assert(appCore.includes('mark("trusted-search-pin")'), "pin decision writes a DOM breadcrumb for live QA");
assert(appCore.includes('mark("course-fit-"'), "the breadcrumb names which fit check demanded the pin");
assert(appCore.includes("const usePinSeed=!payload.gdDatabaseMapAvailable&&gdCoursePickerUsesPinSeed(payload);"), "database maps win over stored pin scanner seeds");
assert(pickerSearch.includes('reason:pinSeed?"course-picker-pin":"course-picker"'), "confirmed pins feed the course scanner as the mapping reason");
assert(pickerSearch.includes("courseCentre:pinnedCentre||undefined"), "confirmed pins feed the course scanner as the mapping centre");
assert(pickerSearch.includes("allowLocalSavedMap:course?.gdDatabaseMapAvailable===true"), "local saved maps cannot beat the picker pin flow without a confirmed database map");
assert(pickerSearch.includes("acceptPartialGeneratedMap:pinSeed"), "pin-seeded scans can open the generated first hole without waiting for a full database publish");
assert(pickerSearch.includes("window.GDCoursePicker=api"), "course picker has one explicit public owner");
assert(!appCore.includes("GDCoursePickerOwner"), "partial core picker owner is retired");
assert(pickerSearch.includes("function selectCourseForPlay(raw,opts={})"), "course picker owns selection-to-play orchestration");
assert(pickerSearch.includes("const controller=window.runCourseMappingAttempt||window.gdRunCourseMappingAttempt;"), "course picker invokes the mapping controller directly instead of the legacy resolver alias");
assert(!pickerSearch.includes("window.runCourseMappingAttempt||window.gdRunCourseMappingAttempt||window.gdResolveCoursePlayHole"), "course picker does not restore the legacy resolver alias as an owner");
assert(pickerSearch.includes("prepareMappingSurface(course,opts);"), "course picker closes picker/pin UI before handing one request to the mapping controller");
assert(!coursePickerMappingPrep.includes("gdEnsureGpsCourseSurface();"), "course picker does not enter GPS Play before mapping returns a playable result");
assert(pickerSearch.includes("setMappingStatus(result);"), "course picker receives mapping success/failure from the controller");
assert(pickerSearch.includes("if(result&&result.playable)enterGpsPlay(course,result,opts);"), "course picker enters GPS Play only after a playable mapping result");
assert(appCore.includes('return window.GDCoursePicker.selectCourse(payload,Object.assign({source:"core-compat-kick"},opts||{}));'), "legacy automap kickoff delegates back to the course picker owner");
assert(appCore.includes("if(payload?.gdDatabaseMapAvailable===true)gdScheduleCourseVisualPullForPlay(payload);"), "course visual pulls only follow confirmed database maps");
assert(appCore.includes("window.gdConfirmCoursePin=gdConfirmCoursePin"), "pin confirmation is exposed for the picker panel");
assert(pickerBaseCss.includes(".courseScreen{position:absolute;inset:0;z-index:7600;background:transparent"), "course picker overlay leaves the live map visible behind the controls");
assert(pickerBaseCss.includes(".gdCoursePinScreen"), "course picker includes the no-GPS pin prompt styling");
assert(pickerBaseCss.includes(".courseScreen.gdCoursePinMode #gdCourseResumeRound{display:none!important}"), "pin mode hides the stale resume-round panel");
assert(gpsRuntimeCss.includes("body.shell-gps.gdCoursePickerOpen #map"), "GPS runtime CSS keeps the map visible under the course picker");
assert(!index.includes('class="rightRail" id="gdAppRightRail"'), "right rail is no longer static boot markup that can flash over the picker");
assert(brandRail.includes("function railAllowed()"), "brand rail script owns rail creation instead of static HTML");
assert(brandRail.includes("removeRightRail();"), "brand rail script deletes the rail while picker/home surfaces own the screen");
assert(brandRail.includes("gdAuthLocked") && brandRail.includes("gdProfileOpen"), "brand rail script does not keep a hidden rail on auth/profile screens");
assert(library.includes("return recentGpsPoint();"), "library session center falls back only to actual recent GPS");
/* This asserted the literal `lat:finder?.lat??saved.courseLat??null`. The locals were later
   renamed - finder -> centre, saved -> snap - and a third fallback was added, so the literal
   stopped matching while the behaviour it guards never changed. CI is PR-only, so nothing
   caught it and every branch went red on an assertion about nobody's code.

   The invariant was never the spelling of the chain. It is that each coordinate falls back to
   null: a course with no known position must come back with no position, never a plausible
   default that would drop a player on the wrong continent. Assert that, so a rename is free
   and a hardcoded default is not. */
const openCoords = library.match(/courseCentre:[^,]+,[\s\S]{0,300}?lng:[^\n]*/);
assert(openCoords, "course library open still normalises coordinates in one place");
assert((openCoords[0].match(/\?\?null/g) || []).length >= 4,
  "course library open does not invent coordinates: every lat/lng must fall back to null");
assert(!/\?\?\s*-?[0-9]/.test(openCoords[0]),
  "course library open does not invent coordinates: no numeric default may terminate a coordinate chain");
assert(library.includes("course?loadUserCourseData(userId(),courseId(course)):loadUserCourseData()"), "mapped checks load the explicit selected course instead of stale active course data");
assert(library.includes("const hasTrustedPlayData=requestedHolePlayable(course,expected);"), "settled course-open UI requires trusted mapped data for the requested hole");
assert(library.includes("async function publishedCourseMapAvailability(course,opts={})"), "course library exposes a DB-map-only availability check for the picker");
assert(library.includes("function courseDataMapReadiness(course,hole,wholeCourse)"), "database map availability checks the published course data directly");
assert(library.includes("saved-map-ignored-without-database-map"), "course scanner ignores local saved maps when the picker did not confirm a database map");
assert(library.includes("mode:syncMode"), "generated course scans post to the database as a create-or-append upload");
assert(pickerSearch.includes('const COURSE_MAPS_API="/api/course-maps";'), "course picker searches the shared course-map database");
assert(pickerSearch.includes("function loadDatabaseCourses(opts={})"), "course picker hydrates database courses behind the search UI");
assert(pickerSearch.includes('source:"database-course"'), "database courses are tagged when merged into picker results");
assert(pickerSearch.includes("hasDatabaseMap=true"), "database course results keep a database-map flag for picker ranking");
assert(index.includes("gd-app-base.css?v="), "base CSS cache-bust ships the pin prompt styling");
assert(index.includes("gd-app-permissions.js?v="), "local app permissions owner ships before app core");
assert(index.includes("gd-app-core.js?v="), "app core cache-bust ships the picker bridge");
assert(index.includes("gd-flag-pin.js?v="), "flag/pin owner still ships the flagTool boot-crash fix");
assert(index.includes("gd-brand-icon-render.js?v="), "brand rail cache-bust ships dynamic rail ownership + flag handler rebind");
assert(index.includes("gd-course-picker-search-v2.js?v="), "course picker owner cache-bust ships database course hydration and selection ownership");
assert(index.includes("gd-course-library-pin-lock.js?v="), "course library cache-bust ships generated scan upload");

console.log("course-picker-location tests passed");
