const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const shell = fs.readFileSync(path.join(root, "scripts", "gd-shell.js"), "utf8");
const routeAudit = fs.readFileSync(path.join(root, "scripts", "gd-route-audit.js"), "utf8");
const picker = fs.readFileSync(path.join(root, "scripts", "inline", "gd-course-picker-search-v2.js"), "utf8");
const runtime = fs.readFileSync(path.join(root, "scripts", "inline", "gd-gps-play-runtime-owner-v1.js"), "utf8");

function assertContains(source, needle, message) {
  assert(source.includes(needle), message || `contains ${needle}`);
}

function assertNotContains(source, needle, message) {
  assert(!source.includes(needle), message || `does not contain ${needle}`);
}

function assertBefore(source, first, second, message) {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  assert(a >= 0, `${first} exists`);
  assert(b >= 0, `${second} exists`);
  assert(a < b, message || `${first} appears before ${second}`);
}

function loadedScripts() {
  const scripts = [];
  const re = /<script\b([^>]*)>/gi;
  let match;
  while ((match = re.exec(html))) {
    const src = (match[1].match(/\bsrc=["']([^"']+)["']/i) || [])[1];
    if (src) scripts.push(src.split("?")[0]);
  }
  return scripts.filter((src) => src.startsWith("scripts/"));
}

function exactClassWriterLines(source, className) {
  const pattern = new RegExp(`classList\\.(?:add|remove|toggle)\\([^\\n)]*["']${className}["']`);
  return source.split(/\n/).map((line, index) => ({ line, index: index + 1 })).filter((item) => pattern.test(item.line));
}

assertContains(html, 'scripts/gd-shell.js?v=shell-owner-20260719', "index loads the Shell owner");
assertBefore(html, "scripts/gd-app-core.js", "scripts/gd-shell.js", "Shell loads after legacy core globals exist");
assertBefore(html, "scripts/gd-shell.js", "scripts/gd-route-audit.js", "Shell loads before route audit can expose aliases");

assert.strictEqual((shell.match(/window\.GDShell=api/g) || []).length, 1, "one GDShell assignment");
[
  "init",
  "showHome",
  "openCoursePicker",
  "closeCoursePicker",
  "enterGps",
  "leaveGps",
  "openModule",
  "closeModule",
  "back",
  "home",
  "getState",
  "destroy"
].forEach((name) => assertContains(shell, `${name}:`, `GDShell exposes ${name}`));

["shell-home", "shell-gps", "shell-module", "gdGpsActive", "gps-active", "gdCoursePickerOpen"].forEach((className) => {
  const offenders = [];
  loadedScripts().forEach((src) => {
    const file = path.join(root, src);
    if (!fs.existsSync(file)) return;
    if (src === "scripts/gd-shell.js") return;
    const source = fs.readFileSync(file, "utf8");
    exactClassWriterLines(source, className).forEach((item) => offenders.push(`${src}:${item.index}:${item.line.trim()}`));
  });
  assert.deepStrictEqual(offenders, [], `${className} is written only by GDShell`);
});

loadedScripts().forEach((src) => {
  const file = path.join(root, src);
  if (!fs.existsSync(file) || src === "scripts/gd-shell.js") return;
  const source = fs.readFileSync(file, "utf8");
  const writesLabel = /shellRouteLabel[\s\S]{0,120}\.textContent|\.textContent[\s\S]{0,120}shellRouteLabel/.test(source);
  assert.strictEqual(writesLabel, false, `${src} does not write shellRouteLabel`);
});

assertContains(picker, "window.GDShell.openCoursePicker", "Course Picker delegates picker opening to Shell");
assertContains(picker, "window.GDShell.closeCoursePicker", "Course Picker delegates picker closing to Shell");
assertContains(runtime, "window.GDShell?.openCoursePicker", "GPS runtime delegates Back-to-picker route to Shell");
assertContains(runtime, "window.GDShell?.enterGps", "GPS runtime delegates GPS route classes to Shell");
assertContains(routeAudit, "window.GDShell?.openModule", "module routes delegate presentation to Shell");
assertContains(routeAudit, "gdCanonicalShellBack:function(){return window.GDShell?.back", "legacy canonical Back delegates to Shell");
assertContains(routeAudit, "gdCanonicalShellHome:function(){return window.GDShell?.home", "legacy canonical Home delegates to Shell");

assertNotContains(routeAudit, 'shellNavigationOwner:"gdCanonicalRouteAuditV1"', "route audit is not declared as shell owner");
assertContains(shell, "document.body.classList.toggle(\"shell-home\",home)", "Shell derives Home compatibility class");
assertContains(shell, "document.body.classList.toggle(\"gdCoursePickerOpen\",picker)", "Shell derives picker compatibility class");

console.log("shell-owner tests passed");
