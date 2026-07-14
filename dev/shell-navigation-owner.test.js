const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function scriptById(id) {
  const match = html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)<\\/script>`));
  assert(match, `script ${id} exists`);
  return match[1];
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

function allInlineScriptsParse() {
  const failures = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let count = 0;
  let match;
  while ((match = re.exec(html))) {
    const attrs = match[1] || "";
    if (/\bsrc\s*=/.test(attrs)) continue;
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || "text/javascript";
    if (!/^(text\/javascript|application\/javascript|module)$/i.test(type)) continue;
    const id = (attrs.match(/\bid\s*=\s*["']([^"']+)/i) || [])[1] || `inline-${count + 1}`;
    try {
      new Function(match[2]);
      count += 1;
    } catch (error) {
      failures.push(`${id}: ${error.message}`);
    }
  }
  assert.deepStrictEqual(failures, [], "all inline scripts parse");
  return count;
}

const inlineCount = allInlineScriptsParse();
assert(inlineCount >= 40, "expected the app shell inline scripts to be checked");

const canonical = scriptById("gdCanonicalRouteAuditV1");
const runtime = scriptById("gdGpsPlayRuntimeOwnerV1");
new Function(canonical);
new Function(runtime);

const oldEnterMatches = canonical.match(/const oldEnterGps=window\.enterGpsModule/g) || [];
assert.strictEqual(oldEnterMatches.length, 1, "canonical shell owner declares oldEnterGps only once");

assertContains(canonical, "function shellBackClick(event)", "canonical owner defines the shell Back click command");
assertContains(canonical, "function shellBackPointer(event)", "canonical owner defines the shell Back pointer command");
assertContains(canonical, "gdShellBackClick:shellBackClick", "canonical owner exports gdShellBackClick for inline shell markup");
assertContains(canonical, "gdShellBackPointer:shellBackPointer", "canonical owner exports gdShellBackPointer for inline shell markup");
assertContains(canonical, "gdCanonicalShellBack:backStable", "canonical owner exports canonical Back");
assertContains(canonical, "gdCanonicalShellHome:cleanForHome", "canonical owner exports canonical Home");

assertContains(html, 'onclick="return gdShellBackClick(event)"', "shell Back button uses the global Back command");
assertContains(html, 'onpointerdown="return gdShellBackPointer(event)"', "shell Back button uses the global pointer command");
assertContains(html, 'onclick="showShellHome()"', "shell Home button uses the global Home command");

assertContains(runtime, 'shellNavigationOwner:"gdCanonicalRouteAuditV1"', "GPS runtime declares canonical shell navigation owner");
assertContains(runtime, "function canonicalShellNavActive()", "GPS runtime can detect canonical shell owner");
assertContains(runtime, "if(!canonicalShellNavActive()){", "GPS runtime only falls back to shell nav ownership when canonical owner is missing");
assertBefore(runtime, "if(!canonicalShellNavActive()){", "window.gdCanonicalShellHome=home", "GPS runtime does not overwrite canonical Home outside the fallback guard");
assertBefore(runtime, "if(!canonicalShellNavActive()){", "window.gdCanonicalShellBack=back", "GPS runtime does not overwrite canonical Back outside the fallback guard");
assertContains(runtime, "if(canonicalShellNavActive())return;", "GPS runtime does not capture Back/Home pointer events when canonical owner is active");
assertNotContains(runtime, "window.gdShellBackClick=function(event){return back(event)};\n\t    window.gdShellBackPointer", "GPS runtime does not unconditionally own shell Back globals");

console.log("shell-navigation-owner tests passed");
