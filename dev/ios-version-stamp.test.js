/*
 * iOS version comes from package.json and a strictly increasing build number.
 *
 * CFBundleVersion was hardcoded to 1 and CFBundleShortVersionString to 1.0.
 * App Store Connect rejects an upload whose build number does not exceed the
 * last one, so the first submission would have gone through and every one after
 * it would have been refused - a failure you only discover at upload time, after
 * a full archive. Android already derived both from package.json and the commit
 * count; this brings iOS to parity.
 *
 * The values are stamped onto the BUILT Info.plist by an Xcode build phase, not
 * written into project.pbxproj. Writing a commit-count build number into a
 * tracked file dirties the tree on every commit, and committing that change
 * advances the count again - a loop with no fixed point.
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
const stampPath = path.join(IOS, "stamp-version.sh");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test("Info.plist takes its version from build settings, not literals", () => {
  assert.ok(
    /<key>CFBundleShortVersionString<\/key>\s*<string>\$\(MARKETING_VERSION\)<\/string>/.test(infoPlist),
    "CFBundleShortVersionString is not $(MARKETING_VERSION) — the stamp would be overwritten"
  );
  assert.ok(
    /<key>CFBundleVersion<\/key>\s*<string>\$\(CURRENT_PROJECT_VERSION\)<\/string>/.test(infoPlist),
    "CFBundleVersion is not $(CURRENT_PROJECT_VERSION)"
  );
});

test("the stamp script exists and is executable", () => {
  assert.ok(fs.existsSync(stampPath), "ios/App/stamp-version.sh is missing");
  assert.ok(fs.statSync(stampPath).mode & 0o111, "stamp-version.sh is not executable — Xcode would fail the phase");
});

test("the stamp derives both values rather than hardcoding them", () => {
  const script = fs.readFileSync(stampPath, "utf8");
  assert.ok(/package\.json/.test(script), "marketing version is not read from package.json");
  assert.ok(/git rev-list --count HEAD/.test(script), "build number is not derived from the commit count");
  assert.ok(/IOS_BUILD_NUMBER/.test(script), "no CI override, unlike ANDROID_VERSION_CODE on the Android side");
  assert.ok(
    /TARGET_BUILD_DIR.*INFOPLIST_PATH/.test(script),
    "the script does not target the built Info.plist"
  );
});

test("the build phase is wired into the App target", () => {
  assert.ok(/isa = PBXShellScriptBuildPhase/.test(pbxproj), "no shell script build phase in the project");
  assert.ok(/name = "Stamp version"/.test(pbxproj), "the 'Stamp version' phase is not in the project");
  assert.ok(
    /stamp-version\.sh/.test(pbxproj),
    "the phase does not invoke stamp-version.sh"
  );
  const target = /\/\* App \*\/ = \{\s*isa = PBXNativeTarget;[\s\S]*?buildPhases = \(([\s\S]*?)\);/.exec(pbxproj);
  assert.ok(target, "could not find the App native target");
  assert.ok(/Stamp version/.test(target[1]), "the phase exists but is not attached to the App target");
  /* Ordering: Xcode re-runs ProcessInfoPlistFile on incremental builds and
     overwrites an unordered stamp. Declaring the built plist as an input is what
     forces the script to run after it. Verified by building twice. */
  const phase = /isa = PBXShellScriptBuildPhase;[\s\S]*?\};/.exec(pbxproj)[0];
  assert.ok(
    /inputPaths = \(\s*"\$\(TARGET_BUILD_DIR\)\/\$\(INFOPLIST_PATH\)",/.test(phase),
    "the built Info.plist is not declared as an input — incremental builds would silently keep the stale version"
  );
});

test("no version number is hardcoded where it would drift", () => {
  /* The pbxproj defaults stay as a fallback, but nothing should read them: the
     stamp always overwrites. This just pins that the marketing default has not
     been edited into something that looks authoritative. */
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.version, "package.json has no version for iOS to read");
  assert.ok(
    !/MARKETING_VERSION = 0\.1\.0;/.test(pbxproj),
    "package.json's version was copied into project.pbxproj — it will drift; the stamp is the source of truth"
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
if (failed) process.exit(1);
console.log("ios-version-stamp passed: " + tests.length + " checks");
