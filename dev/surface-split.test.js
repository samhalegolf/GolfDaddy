/*
 * The app/studio surface split, locked.
 *
 * One source index.html builds two surfaces: the phone app (studio-marked
 * elements stripped) and the browser studio at /studio/ (everything). The value
 * of the split is entirely in what the app build does NOT contain, and that is
 * invisible - nothing in the running app looks wrong when an admin module quietly
 * comes back into the load order. These assertions make it visible.
 *
 * Boot correctness for both surfaces is `npm run test:boot`; this file checks the
 * build's structural contract.
 *
 * Run: node dev/surface-split.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function build(args) {
  execFileSync("node", ["scripts/clarity-deploy-build.js"].concat(args || []), { cwd: ROOT, stdio: "pipe" });
}

function read(relative) { return fs.readFileSync(path.join(DIST, relative), "utf8"); }
function refs(html) {
  const out = new Set();
  const re = /(?:src|href)="((?:scripts|styles)\/[^"?]+\.(?:js|css))/g;
  let match;
  while ((match = re.exec(html))) out.add(match[1]);
  return out;
}
/* Assets on tags marked data-gd-surface="app" — present in the app build, gone
   from the studio build. */
function appOnlyRefs(html) {
  const out = [];
  const re = /data-gd-surface="app"[^>]*?(?:src|href)="((?:scripts|styles)\/[^"?]+\.(?:js|css))/g;
  let match;
  while ((match = re.exec(html))) out.push(match[1]);
  return out;
}

const source = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

test("the source index.html is the studio superset", () => {
  assert.ok(
    /data-gd-surface="studio"/.test(source),
    "no data-gd-surface=\"studio\" markers in index.html — the split has nothing to strip, so the app build ships the admin surface"
  );
});

build();
const appHtml = read("index.html");
const studioHtml = read(path.join("studio", "index.html"));

test("both surfaces are emitted by the default build", () => {
  assert.ok(appHtml.length > 10000, "app index.html is suspiciously small");
  assert.ok(studioHtml.length > appHtml.length, "studio index should be the larger superset");
});

test("each surface declares which one it is", () => {
  assert.ok(/<html data-gd-target="app"/.test(appHtml), "app index is missing data-gd-target=\"app\"");
  assert.ok(/<html data-gd-target="studio"/.test(studioHtml), "studio index is missing data-gd-target=\"studio\"");
});

test("the app surface carries no studio markers or admin panel", () => {
  assert.ok(!/data-gd-surface="studio"/.test(appHtml), "studio-marked elements survived into the app build");
  assert.ok(!/id="developerPanel"/.test(appHtml), "#developerPanel (Admin Settings) is in the app build");
  assert.ok(!/gd-course-mapping-debug/.test(appHtml), "the mapping debug module is in the app build");
});

test("the studio surface keeps everything the app strips", () => {
  assert.ok(/id="developerPanel"/.test(studioHtml), "#developerPanel is missing from the studio build");
  assert.ok(/gd-course-mapping-debug/.test(studioHtml), "the mapping debug module is missing from the studio build");
  /* The studio is the source minus the app-only elements, not a strict superset:
     the marking runs both ways since the visual engine split, where the phone
     loads a cut-down client and the studio loads the full authoring engine. */
  const appOnly = new Set(appOnlyRefs(source));
  const missing = [...refs(source)].filter((ref) => !refs(studioHtml).has(ref) && !appOnly.has(ref));
  assert.deepStrictEqual(missing, [], "studio dropped assets that are not app-only: " + missing.join(", "));
});

test("app-only assets are stripped from the studio, and vice versa", () => {
  const appOnly = appOnlyRefs(source);
  assert.ok(appOnly.length > 0, "no data-gd-surface=\"app\" assets found — this test would pass vacuously");
  appOnly.forEach((ref) => {
    assert.ok(refs(appHtml).has(ref), "app-only asset missing from the app build: " + ref);
    assert.ok(!refs(studioHtml).has(ref), "app-only asset leaked into the studio build: " + ref);
  });
  /* The two visual engines both define GDCourseVisualEngine, so a surface that
     loaded both would silently run whichever won the load order. */
  const enginesInApp = Number(/gd-course-visual-client\.js/.test(appHtml)) + Number(/gd-course-visual-engine\.js/.test(appHtml));
  const enginesInStudio = Number(/gd-course-visual-client\.js/.test(studioHtml)) + Number(/gd-course-visual-engine\.js/.test(studioHtml));
  assert.strictEqual(enginesInApp, 1, "the app build must load exactly one course visual engine");
  assert.strictEqual(enginesInStudio, 1, "the studio build must load exactly one course visual engine");
});

test("the studio resolves its shared assets from site root", () => {
  /* /studio/index.html loads the same /scripts and /styles as the app. Without
     <base href="/"> every relative src would resolve under /studio/ and 404. */
  assert.ok(/<base href="\/">/.test(studioHtml), "studio index has no <base href=\"/\"> — its relative asset paths would 404");
});

test("stripping removes whole elements, not just their opening tags", () => {
  const balance = (html) => (html.match(/<div/g) || []).length - (html.match(/<\/div>/g) || []).length;
  assert.strictEqual(
    balance(appHtml), balance(source),
    "div nesting changed — a studio element was cut without its children or its closing tag"
  );
});

test("--app-only prunes studio-only files instead of shipping them dark", () => {
  /* npx cap sync copies all of dist into the native project, so a file that is
     merely unreferenced still lands inside the APK/IPA. */
  build(["--app-only"]);
  assert.ok(!fs.existsSync(path.join(DIST, "studio")), "--app-only still emitted a studio directory");
  assert.ok(
    !fs.existsSync(path.join(DIST, "scripts", "gd-course-mapping-debug.js")),
    "a studio-only script file survived --app-only and would ship inside the native bundle"
  );
  const appOnlyHtml = read("index.html");
  refs(appOnlyHtml).forEach((ref) => {
    assert.ok(fs.existsSync(path.join(DIST, ref)), "pruned a file the app build still loads: " + ref);
  });
  /* A directory the prune emptied still rides into the APK and the .app, where
     an empty scripts/studio/ reads as "the studio code is in here". */
  assert.ok(
    !fs.existsSync(path.join(DIST, "scripts", "studio")),
    "scripts/studio/ survived --app-only as an empty directory and would ship in the native bundle"
  );
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
/* Leave dist in the shape the Netlify build produces, not the --app-only shape,
   so a following test or a manual serve sees both surfaces. */
build();
if (failed) process.exit(1);
console.log("surface-split passed: " + tests.length + " checks");
