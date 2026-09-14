/*
 * iOS build number: one number, in project.pbxproj, stamped onto the BUILT
 * Info.plist of every target.
 *
 * CFBundleVersion must strictly increase for every App Store Connect upload,
 * and the watch app must carry the SAME number as the phone app or the upload
 * is rejected. The number lives in CURRENT_PROJECT_VERSION and is bumped BY
 * HAND with ios/App/bump-build-number.sh before an Archive: bumping it from a
 * build phase made Xcode reload the project mid-build and cancel the archive.
 *
 * The "Stamp build number" phase then writes the number that is in the
 * project file RIGHT NOW into each target's built Info.plist, because Xcode
 * resolves $(CURRENT_PROJECT_VERSION) before the build starts and would
 * otherwise carry the pre-bump value.
 *
 * An earlier design derived the number from the git commit count via a
 * stamp-version.sh phase. That script was never wired into the project and
 * has been removed; this suite describes what actually builds.
 *
 * Run: node dev/ios-version-stamp.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const IOS = path.join(ROOT, "ios", "App");
const pbxproj = fs.readFileSync(path.join(IOS, "App.xcodeproj", "project.pbxproj"), "utf8");
const infoPlist = fs.readFileSync(path.join(IOS, "App", "Info.plist"), "utf8");
const stampPath = path.join(IOS, "stamp-build-number.sh");
const bumpPath = path.join(IOS, "bump-build-number.sh");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function executable(file) {
  return fs.existsSync(file) && !!(fs.statSync(file).mode & 0o111);
}

/* The buildPhases list of the native target whose comment is `name`. */
function buildPhasesOf(name) {
  const re = new RegExp("\\/\\* " + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\*\\/ = \\{\\s*isa = PBXNativeTarget;[\\s\\S]*?buildPhases = \\(([\\s\\S]*?)\\);");
  const match = re.exec(pbxproj);
  assert.ok(match, "could not find the " + name + " native target");
  return match[1].split("\n").map((line) => line.trim()).filter(Boolean);
}

test("Info.plist takes its version from build settings, not literals", () => {
  assert.ok(
    /<key>CFBundleShortVersionString<\/key>\s*<string>\$\(MARKETING_VERSION\)<\/string>/.test(infoPlist),
    "CFBundleShortVersionString is not $(MARKETING_VERSION)"
  );
  assert.ok(
    /<key>CFBundleVersion<\/key>\s*<string>\$\(CURRENT_PROJECT_VERSION\)<\/string>/.test(infoPlist),
    "CFBundleVersion is not $(CURRENT_PROJECT_VERSION) — the stamp would be fighting a literal"
  );
});

test("the stamp and bump scripts exist and are executable", () => {
  assert.ok(executable(stampPath), "ios/App/stamp-build-number.sh is missing or not executable — Xcode would fail the phase");
  assert.ok(executable(bumpPath), "ios/App/bump-build-number.sh is missing or not executable");
  assert.ok(!fs.existsSync(path.join(IOS, "stamp-version.sh")), "stamp-version.sh is the abandoned commit-count design and must not come back");
});

test("the stamp writes the project file's number onto the built Info.plist", () => {
  const script = fs.readFileSync(stampPath, "utf8");
  assert.ok(/CURRENT_PROJECT_VERSION/.test(script), "the number is not read from project.pbxproj");
  assert.ok(/TARGET_BUILD_DIR.*INFOPLIST_PATH/.test(script), "the script does not target the built Info.plist");
  assert.ok(/CFBundleVersion/.test(script), "the script does not set CFBundleVersion");
  assert.ok(!/git rev-list/.test(script), "the build number must not come from the commit count — it is bumped by hand in the project file");
});

test("every native target ends with a Stamp build number phase running the script", () => {
  const phases = pbxproj.match(/isa = PBXShellScriptBuildPhase;[\s\S]*?\};/g) || [];
  assert.ok(phases.length >= 2, "expected a shell script phase per target (App and watch), found " + phases.length);
  phases.forEach((phase) => {
    assert.ok(/name = "Stamp build number";/.test(phase), "a shell script phase is not the Stamp build number phase");
    assert.ok(/stamp-build-number\.sh/.test(phase), "the phase does not invoke stamp-build-number.sh");
    /* Xcode caches script phases with declared inputs and outputs; this one
       must run on every build or a bump is not stamped until something else
       changes. */
    assert.ok(/alwaysOutOfDate = 1;/.test(phase), "the phase must be marked always out of date");
  });
  ["App", "Clarity Caddy Watch"].forEach((target) => {
    const list = buildPhasesOf(target);
    assert.ok(/Stamp build number/.test(list[list.length - 1]),
      target + ": Stamp build number must be the LAST phase, after the product is assembled and before it is embedded and signed by the target above");
  });
});

test("the phone and watch targets carry one build number", () => {
  const numbers = [...new Set((pbxproj.match(/CURRENT_PROJECT_VERSION = (\d+);/g) || []).map((m) => Number(m.match(/\d+/)[0])))];
  assert.strictEqual(numbers.length, 1, "CURRENT_PROJECT_VERSION differs between configurations or targets: " + numbers.join(", ") + " — App Store Connect rejects a watch app whose build number differs from the phone app");
  assert.ok(numbers[0] > 0, "CURRENT_PROJECT_VERSION must be a positive integer");
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
console.log("ios-version-stamp passed: " + tests.length + " checks");
