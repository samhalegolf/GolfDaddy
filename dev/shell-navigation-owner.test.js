const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const shell = fs.readFileSync(path.join(root, "scripts", "gd-shell.js"), "utf8");
const routeAudit = fs.readFileSync(path.join(root, "scripts", "gd-route-audit.js"), "utf8");
const runtime = fs.readFileSync(path.join(root, "scripts", "inline", "gd-gps-play-runtime-owner-v1.js"), "utf8");

function assertContains(source, needle, message) {
  assert(source.includes(needle), message || `contains ${needle}`);
}

function assertBefore(source, first, second, message) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert(firstIndex >= 0, `${first} exists`);
  assert(secondIndex >= 0, `${second} exists`);
  assert(firstIndex < secondIndex, message || `${first} appears before ${second}`);
}

new Function(shell);
new Function(routeAudit);
new Function(runtime);

assertContains(html, 'scripts/gd-shell.js?v=shell-owner-20260719', "page loads explicit Shell owner");
assertBefore(html, "scripts/gd-shell.js", "scripts/gd-route-audit.js", "Shell owner loads before route audit compatibility code");

assertContains(shell, "window.GDShell=api", "Shell owner exposes GDShell");
assertContains(shell, "window.gdShellBackClick=function(event)", "Shell owner exports Back click compatibility");
assertContains(shell, "window.gdShellBackPointer=function(event)", "Shell owner exports Back pointer compatibility");
assertContains(shell, "window.gdCanonicalShellHome=function()", "Shell owner exports canonical Home compatibility");
assertContains(shell, "window.gdCanonicalShellBack=function()", "Shell owner exports canonical Back compatibility");

assertContains(routeAudit, "gdCanonicalShellBack:function(){return window.GDShell?.back", "route audit Back alias delegates to Shell");
assertContains(routeAudit, "gdCanonicalShellHome:function(){return window.GDShell?.home", "route audit Home alias delegates to Shell");
assertContains(routeAudit, "safe(()=>window.GDShell?.init?.());", "route audit asks Shell to own top-bar button wiring");

assertContains(runtime, "function canonicalShellNavActive()", "GPS runtime still detects canonical shell navigation");
assertContains(runtime, "if(!canonicalShellNavActive()){", "GPS runtime shell wiring remains fallback-only");
assertContains(runtime, "window.GDShell?.openCoursePicker", "GPS runtime delegates picker route presentation to Shell");

console.log("shell-navigation-owner tests passed");
