/*
 * Clarity Studio ownership shell, locked.
 *
 * The new Studio shell (registry/router/shell/info-view + the five Courses pages) must load
 * only on the studio surface, must never leak into the app build, and must not disturb the
 * legacy #developerPanel contract that dev/boot-smoke.test.js and
 * dev/course-location-behavior.test.js already pin. This file also validates the ownership
 * registry's internal consistency (connections resolve, code paths exist) since nothing else
 * checks a plain data file for correctness.
 *
 * Pure text/static checks against source + the built dist, no browser — mirrors
 * dev/surface-split.test.js's style. Live-execution checks (globals actually callable, panel
 * actually renders) are covered by dev/boot-smoke.test.js and this branch's manual browser pass
 * (see docs/reports/CLARITY_STUDIO_WIRING_COMPARISON.md), not duplicated here.
 *
 * Run: node dev/studio-wiring.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function build(args) {
  execFileSync("node", ["scripts/clarity-deploy-build.js"].concat(args || []), { cwd: ROOT, stdio: "pipe" });
}
function read(relative) { return fs.readFileSync(path.join(DIST, relative), "utf8"); }

const STUDIO_SCRIPTS = [
  "scripts/studio/studio-registry.js",
  "scripts/studio/studio-router.js",
  "scripts/studio/studio-info-view.js",
  "scripts/studio/studio-shell.js",
  "scripts/studio/overview/overview-page.js",
  "scripts/studio/courses/course-database/course-database-page.js",
  "scripts/studio/courses/course-mapping/course-mapping-page.js",
  "scripts/studio/courses/map-viewport/map-viewport-page.js",
  "scripts/studio/courses/course-visuals/course-visuals-page.js",
  "scripts/studio/courses/publishing/course-publishing-page.js",
  "scripts/studio/courses/mapping-diagnostics/mapping-diagnostics-page.js",
  "scripts/studio/shot-system/practice-data/practice-data-page.js",
  "scripts/studio/shot-system/course-data/course-data-page.js",
  "scripts/studio/commerce/commerce-page.js",
  "scripts/studio/players-coaches/players-coaches-page.js",
  "scripts/studio/system/system-dev-panel-host.js",
  "scripts/studio/system/storage/storage-page.js",
  "scripts/studio/system/feature-controls/feature-controls-page.js",
  "scripts/studio/system/diagnostics/launch-monitor-diagnostics-page.js",
  "scripts/studio/gps-play/shot-planning/shot-planning-page.js"
];
const STUDIO_CSS = "scripts/studio/studio-shell.css";

const source = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

test("every new Studio shell file exists on disk", () => {
  STUDIO_SCRIPTS.concat([STUDIO_CSS]).forEach((rel) => {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), "missing file: " + rel);
  });
});

test("every new Studio shell script tag is marked data-gd-surface=\"studio\" in source", () => {
  STUDIO_SCRIPTS.forEach((rel) => {
    const re = new RegExp('data-gd-surface="studio"[^>]*src="' + rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    assert.ok(re.test(source), "not marked studio-only in index.html: " + rel);
  });
  assert.ok(
    new RegExp('data-gd-surface="studio"[^>]*href="' + STUDIO_CSS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(source),
    "studio-shell.css link is not marked studio-only in index.html"
  );
});

test("the new Studio shell container is marked data-gd-surface=\"studio\"", () => {
  assert.ok(/data-gd-surface="studio"[^>]*id="gdStudioShellRoot"/.test(source), "#gdStudioShellRoot is missing or not studio-marked");
});

build();
const appHtml = read("index.html");
const studioHtml = read(path.join("studio", "index.html"));

test("the app build loads none of the new Studio shell files", () => {
  STUDIO_SCRIPTS.concat([STUDIO_CSS]).forEach((rel) => {
    assert.ok(!appHtml.includes(rel), "Studio-only file leaked into the app build: " + rel);
  });
  assert.ok(!/id="gdStudioShellRoot"/.test(appHtml), "#gdStudioShellRoot leaked into the app build");
});

test("the studio build loads every new Studio shell file", () => {
  STUDIO_SCRIPTS.concat([STUDIO_CSS]).forEach((rel) => {
    assert.ok(studioHtml.includes(rel), "Studio shell file missing from the studio build: " + rel);
  });
  assert.ok(/id="gdStudioShellRoot"/.test(studioHtml), "#gdStudioShellRoot missing from the studio build");
});

test("the legacy #developerPanel Course Database contract is unchanged", () => {
  const adminDb = fs.readFileSync(path.join(ROOT, "scripts", "studio", "gd-admin-course-db.js"), "utf8");
  const legacyExports = [
    "window.gdRenderAdminCourseDatabase=gdRenderAdminCourseDatabase",
    "window.gdAdminCourseDbOpen=gdAdminCourseDbOpen",
    "window.gdAdminCourseDbShowGeometry=gdAdminCourseDbShowGeometry",
    "window.gdAdminCourseDbShowDebug=gdAdminCourseDbShowDebug",
    "window.gdAdminCourseLocationEdit=gdAdminCourseLocationEdit",
    "window.gdAdminCourseLocationRemove=gdAdminCourseLocationRemove",
    "window.gdAdminCourseDebugRefresh=gdAdminCourseDebugRefresh"
  ];
  legacyExports.forEach((snippet) => {
    assert.ok(adminDb.includes(snippet), "gd-admin-course-db.js no longer exports: " + snippet);
  });
  assert.ok(adminDb.includes('function gdRenderAdminCourseDatabase()'), "gdRenderAdminCourseDatabase signature changed — this branch is meant to leave it untouched");
});

test("the legacy course-play debug contract is unchanged", () => {
  const playDebug = fs.readFileSync(path.join(ROOT, "scripts", "studio", "gd-course-play-debug.js"), "utf8");
  [
    "window.gdRenderCoursePlayPipelineDebug",
    "window.gdSetCoursePlayDebug",
    "window.gdClearCoursePlayPipelineDebug",
    "window.gdRenderCoursePlayMonitor",
    "window.gdToggleCoursePlayMonitorCollapsed"
  ].forEach((snippet) => {
    assert.ok(playDebug.includes(snippet), "gd-course-play-debug.js no longer exports: " + snippet);
  });
});

test("the legacy mapping debug contract is unchanged", () => {
  const mappingDebug = fs.readFileSync(path.join(ROOT, "scripts", "gd-course-mapping-debug.js"), "utf8");
  assert.ok(mappingDebug.includes('function renderAdminPanel()'), "GDCourseMappingDebug.renderAdminPanel signature changed — this branch is meant to leave it untouched");
  assert.ok(mappingDebug.includes('document.getElementById("gdCourseMappingDebugPanel")'), "GDCourseMappingDebug no longer targets #gdCourseMappingDebugPanel");
});

test("#developerPanel and its fixed Course Database ids are unchanged and still singular", () => {
  ["id=\"developerPanel\"", "id=\"gdAdminDatabasePanel\"", "id=\"gdAdminCourseDbSummary\"", "id=\"gdAdminCourseDbList\"", "id=\"gdAdminCourseDbDetail\"", "id=\"gdAdminCourseDbSearch\""].forEach((needle) => {
    const count = source.split(needle).length - 1;
    assert.strictEqual(count, 1, "expected exactly one " + needle + " in source index.html, found " + count);
  });
});

test("openDeveloperPanel's app-build no-op guard is unchanged", () => {
  const core = fs.readFileSync(path.join(ROOT, "scripts", "gd-app-core.js"), "utf8");
  assert.ok(
    core.includes('if(!document.getElementById("developerPanel"))return false;'),
    "openDeveloperPanel's #developerPanel existence guard changed — this is what makes a stray admin route a safe no-op on the app build"
  );
});

function loadRegistry() {
  const code = fs.readFileSync(path.join(ROOT, "scripts", "studio", "studio-registry.js"), "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "studio-registry.js" });
  assert.ok(sandbox.window.GDStudioRegistry, "studio-registry.js did not set window.GDStudioRegistry");
  return sandbox.window.GDStudioRegistry;
}

test("the ownership registry loads and every connection target resolves", () => {
  const registry = loadRegistry();
  const all = registry.all();
  assert.ok(all.length > 20, "registry looks suspiciously small: " + all.length + " records");
  all.forEach((record) => {
    (record.connections || []).forEach((conn) => {
      assert.ok(registry.get(conn.target), "record \"" + record.id + "\" has a connection to unknown id \"" + conn.target + "\"");
    });
    if (record.parent) {
      assert.ok(registry.get(record.parent), "record \"" + record.id + "\" has an unknown parent \"" + record.parent + "\"");
    }
  });
});

test("every registry code[].path exists on disk", () => {
  const registry = loadRegistry();
  registry.all().forEach((record) => {
    (record.code || []).forEach((c) => {
      assert.ok(fs.existsSync(path.join(ROOT, c.path)), "record \"" + record.id + "\" points at a missing file: " + c.path);
    });
  });
});

test("Course Database, Course Mapping, Course Visuals, Publishing, and Mapping Diagnostics each register an ownership record", () => {
  const registry = loadRegistry();
  ["course-database", "course-mapping", "course-visuals", "publishing", "mapping-diagnostics"].forEach((id) => {
    const record = registry.get(id);
    assert.ok(record, "missing registry record: " + id);
    assert.ok(record.function && record.function.length > 10, "record \"" + id + "\" has no real function description");
  });
});

test("the nav tree only references real registry ids", () => {
  const registry = loadRegistry();
  registry.navTree.forEach((entry) => {
    assert.ok(registry.get(entry.id), "nav tree references unknown id: " + entry.id);
    (entry.children || []).forEach((childId) => {
      assert.ok(registry.get(childId), "nav tree references unknown child id: " + childId);
    });
  });
});

let failed = 0;
tests.forEach((entry) => {
  try {
    entry.fn();
    console.log("  ok  " + entry.name);
  } catch (error) {
    failed += 1;
    console.error("  FAIL  " + entry.name + "\n        " + (error && error.message));
  }
});
if (failed) process.exit(1);
console.log("studio-wiring passed: " + tests.length + " checks");
