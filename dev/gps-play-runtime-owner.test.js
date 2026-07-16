const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const shellCss = fs.readFileSync(path.join(__dirname, "..", "styles", "gd-shell.css"), "utf8");

function scriptById(id) {
  const match = html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)<\\/script>`));
  assert(match, `script ${id} exists`);
  return match[1];
}

function styleById(id) {
  const match = html.match(new RegExp(`<style id="${id}">([\\s\\S]*?)<\\/style>`));
  assert(match, `style ${id} exists`);
  return match[1];
}

function sliceBetween(start, end) {
  const startIndex = html.indexOf(start);
  assert(startIndex >= 0, `${start} exists`);
  const endIndex = end ? html.indexOf(end, startIndex) : html.length;
  assert(endIndex > startIndex, `${end || "EOF"} follows ${start}`);
  return html.slice(startIndex, endIndex);
}

function assertContains(source, needle, message) {
  assert(source.includes(needle), message || `contains ${needle}`);
}

function assertNotContains(source, needle, message) {
  assert(!source.includes(needle), message || `does not contain ${needle}`);
}

function assertBefore(source, first, second, message) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert(firstIndex >= 0, `${first} exists`);
  assert(secondIndex >= 0, `${second} exists`);
  assert(firstIndex < secondIndex, message || `${first} appears before ${second}`);
}

const runtimeScript = scriptById("gdGpsPlayRuntimeOwnerV1");
const runtimeCss = styleById("gdGpsPlayRuntimeOwnerV1Css");
new Function(runtimeScript);

assertNotContains(html, '<script id="gdGpsSpringCleanOwnerV1">', "old Spring Clean script id is not the live owner");
assertNotContains(html, '<style id="gdGpsSpringCleanOwnerV1Css">', "old Spring Clean style id is not the live owner");
assertContains(runtimeScript, 'window.__gdGpsSpringCleanOwnerV1="renamed-to-gdGpsPlayRuntimeOwnerV1"', "old guard remains as a compatibility alias");
assertContains(runtimeScript, 'window.gdGpsPlayRuntimeOwner={id:"gdGpsPlayRuntimeOwnerV1"', "runtime owner publishes debug metadata");
assertContains(runtimeScript, 'cameraOwner:"v19-captured-surface"', "runtime owner does not claim camera ownership");
assertContains(html, 'data-owner="gps-play-runtime"', "captured shot overlay labels the runtime owner");
assertNotContains(html, 'data-owner="spring-clean"', "captured shot overlay no longer reports Spring Clean");
assertNotContains(html, 'source:"spring-clean"', "captured overlay debug source no longer reports Spring Clean");

const transition = sliceBetween("function gdBeginGpsHoleSwitchTransition", "function gdEndGpsHoleSwitchTransition");
assertContains(transition, 'window.gdClearManualStartRuntime((reason||"hole-switch")+"-transition"', "hole transition clears manual-start runtime");

const buildFrame = sliceBetween("function gdBuildHoleFrame", "function gdEnsureHoleObject");
assertContains(buildFrame, "var includeCurrentShot=opts.includeCurrentShot===true", "new pre-lock hole frames opt into shot state explicitly");
assertContains(buildFrame, "startPoint:includeCurrentShot?", "pre-lock frame does not inherit stale start point by default");
assertContains(buildFrame, "targetPoint:includeCurrentShot?", "pre-lock frame does not inherit stale target point by default");
assertContains(buildFrame, "green:{center:includeCurrentShot?", "pre-lock frame does not inherit stale green point by default");

const holeSwitch = sliceBetween("function clearHoleSwitchShotState", "function renderHoleFrame");
assertContains(holeSwitch, "window.gdClearManualStartRuntime", "GPS Play delegates manual-start cleanup to runtime owner");
assertContains(holeSwitch, "start=target=greenCentre=pin=null", "hole switch clears old shot globals");
assertContains(holeSwitch, "gdManualStartPlacementActive", "hole switch clears manual-start UI class");

const setActiveHole = sliceBetween("function setActiveHole", "window.gdSetActiveHoleFrame=setActiveHole");
assertBefore(setActiveHole, 'clearHoleSwitchShotState(h,(opts.source||"hole-switch")+"-pre-session")', "var par=parForHole(h)", "hole switch clears shot state before scorecard/session work");
assertBefore(setActiveHole, "clearHoleSwitchShotState", "gdEnsureHoleObject", "hole switch clears old state before creating the new hole object");

assertContains(runtimeScript, "function clearStandingPointRuntime", "runtime owner exposes a standing-point cleanup function");
assertContains(runtimeScript, "window.gdClearManualStartRuntime=clearStandingPointRuntime", "runtime owner exports the cleanup boundary");
assertContains(runtimeScript, "manualStartLockToken+=1", "manual-start cleanup invalidates pending lock callbacks");
assertContains(runtimeScript, "window.__gdManualStandingPlacementActiveUntil=0", "manual-start cleanup clears the active standing window");
assertContains(runtimeScript, "delete window.__gdLastStandingPoint", "manual-start cleanup clears stale standing-point memory");
assertContains(runtimeScript, '"gdStandingPointLat"', "manual-start cleanup clears standing-point datasets");
assertContains(runtimeScript, '"gdGreenFocusBallLat"', "manual-start cleanup clears green-focus ball datasets");
assertContains(runtimeScript, '"gdManualSurfaceEnd"', "manual-start cleanup clears surface-end diagnostics");

assertContains(runtimeCss, "body.shell-gps #shellHomeBtn", "GPS runtime keeps shell Home visible");
assertContains(runtimeCss, "body.shell-gps #shellTop #shellSettingsBtn", "GPS runtime keeps shell Settings visible");
assertNotContains(runtimeCss, "#shellHomeBtn{display:none!important", "GPS runtime does not hide the real Home button");
assertContains(runtimeCss, "#gdToolRailTab{position:fixed!important", "GPS runtime owns the tool tab position");
assertContains(runtimeCss, "z-index:2147483000!important", "GPS runtime lifts the real shell row above map layers");
assertContains(runtimeCss, "z-index:2147483002!important", "Settings sits above the tool tab");
assertNotContains(shellCss, 'content: "Home" !important', "GPS shell no longer paints a fake Home label over Settings");
assertNotContains(shellCss, 'content: "Back" !important', "GPS shell no longer paints a fake Back label over Back");
assertContains(shellCss, "body.shell-gps #shellTop", "external shell CSS reinforces the real shell controls");
assertContains(html, 'styles/gd-shell.css?v=real-shell-controls-20260716', "GPS shell stylesheet URL cache-busts removed fake labels");
assertContains(runtimeCss, "body.shell-gps #courseScreen:not(.hidden) .courseNav", "course picker does not paint duplicate Back/Home above the shell");
assertContains(runtimeCss, "body.shell-gps #courseScreen:not(.hidden),", "course picker wrapper does not block shell controls");
assertContains(runtimeCss, "body.shell-gps #courseScreen:not(.hidden) .courseCard", "course picker keeps cards/search interactive after wrapper pass-through");
assertContains(html, "body.gdMappedStartPromptActive #gdV62UndoDock{\n  opacity:1!important;\n  filter:none!important;\n  pointer-events:none!important;\n}", "mapped start prompt keeps the lock/shot dock visible");
assertContains(html, "body.gdMappedStartPromptActive #hint.gdMappedStartPill{\n  z-index:2540!important;\n  bottom:calc(148px + env(safe-area-inset-bottom))!important;", "mapped start pill sits above the lock/shot dock");

const lockAfterManualStart = sliceBetween("function lockAfterManualStart", "function manualStartPresentationSurfaceEvent");
assertContains(lockAfterManualStart, "var lockHole=currentHole()", "manual-start delayed lock captures the originating hole");
assertContains(lockAfterManualStart, "var lockToken=++manualStartLockToken", "manual-start delayed lock captures a token");
assertContains(lockAfterManualStart, "if(lockToken!==manualStartLockToken||Number(window.__gdManualStartLockToken)!==lockToken)return", "manual-start delayed lock rejects stale tokens");
assertContains(lockAfterManualStart, "if(currentHole()!==lockHole)return", "manual-start delayed lock rejects cross-hole callbacks");
assertContains(lockAfterManualStart, 'document.body.classList.contains("gdGpsHoleTransitioning")', "manual-start delayed lock does not repaint during hole transitions");

console.log("gps-play-runtime-owner tests passed");
