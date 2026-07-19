const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const core = fs.readFileSync(path.join(root, "scripts", "gd-app-core.js"), "utf8");
const runtime = fs.readFileSync(path.join(root, "scripts", "inline", "gd-gps-play-runtime-owner-v1.js"), "utf8");
const caddie = fs.readFileSync(path.join(root, "scripts", "inline", "gd-caddie-gps-patches-v1.js"), "utf8");
const beta = fs.readFileSync(path.join(root, "scripts", "inline", "gd-gps-beta-mode-shell.js"), "utf8");
const picker = fs.readFileSync(path.join(root, "scripts", "inline", "gd-course-picker-search-v2.js"), "utf8");

function assertContains(source, needle, message) {
  assert(source.includes(needle), message || `contains ${needle}`);
}

function assertNotContains(source, needle, message) {
  assert(!source.includes(needle), message || `does not contain ${needle}`);
}

assertContains(runtime, 'owns:["gps-location-lifecycle"', "GPS runtime metadata owns location lifecycle");
assertContains(runtime, "window.GDGpsLocationLifecycle={", "GPS runtime publishes one lifecycle API");
assertContains(runtime, "window.initGPS=initGpsLocation", "initGPS is owned by the runtime lifecycle");
assertContains(runtime, "window.refreshGPS=refreshGpsLocation", "refreshGPS is owned by the runtime lifecycle");
assertContains(runtime, "window.gdGpsLocateNow=window.GDGpsLocationLifecycle.locate", "GPS locate button routes through the lifecycle owner");
assertContains(runtime, "window.gdGpsRememberFix=rememberGpsPosition", "runtime owns GPS fix memory");
assertContains(runtime, "window.gdRememberLiveGpsOnly=rememberLiveGpsOnly", "runtime owns live GPS marker/cache updates");
assertContains(runtime, "window.updateGpsInsideLockedFrame=updateGpsInsideLockedFrameOwner", "runtime owns locked-frame GPS updates");
assertContains(runtime, "window.startWatch=startLocationWatch", "runtime owns watch startup");
assertContains(runtime, "window.stopGpsWatch=stopLocationWatch", "runtime owns watch cleanup");
assertContains(runtime, "if(safe(function(){return !!gpsWatch},false)||!navigator.geolocation)return null", "watch startup is single-active-watch guarded");
assertContains(runtime, "navigator.geolocation.clearWatch(watch)", "watch cleanup clears the active watch id");
assertContains(runtime, "window.__gdGpsLocationRequestActive", "GPS requests are de-duplicated by the owner");
assertContains(runtime, "simulated:false", "runtime marks remembered live GPS fixes as real observations");

assertNotContains(core, "function initGPS()", "app core no longer owns GPS init");
assertNotContains(core, "function startWatch()", "app core no longer owns geolocation watch startup");
assertNotContains(core, "function refreshGPS()", "app core no longer owns GPS refresh");
assertNotContains(core, "function gdRememberLiveGpsOnly", "app core no longer owns live GPS fix memory");
assertContains(core, "GPS watch/location lifecycle is owned by scripts/inline/gd-gps-play-runtime-owner-v1.js", "core documents the owner boundary");

assertNotContains(caddie, "gd-inline-clarity-caddie-v-next-patch-gps-locate", "old caddie GPS locate override section was removed");
assertNotContains(caddie, "gd-inline-clarity-caddie-patch-location-permission-fix", "old caddie GPS permission override section was removed");
assertNotContains(caddie, "navigator.geolocation.__gdFixCachePatched", "caddie patches no longer monkey-patch geolocation");
assertNotContains(caddie, "window.refreshGPS=function(){ requestGpsRobust", "caddie patches no longer own refreshGPS");
assertNotContains(caddie, "window.gdGpsLocateNow = function(){ requestGpsRobust", "caddie patches no longer own gdGpsLocateNow");

assertContains(beta, "window.refreshGPS=function(){enterLiveGps()}", "beta shell still has its pre-owner legacy refresh assignment before runtime takes ownership");
assertContains(picker, "function requestPickerGps()", "course picker keeps its picker-scoped one-shot GPS request");
assertContains(picker, "source:\"course-picker\",simulated:false", "course picker writes real picker observations, not course-location pins");
assertContains(picker, "if(/manual|tap|click|map|green-focus|pin/.test(source))return null", "course picker still rejects manual/simulated fixes");

console.log("gps-location-lifecycle-owner tests passed");
