#!/usr/bin/env node
/*
 * Runs as npm's `postversion` hook, after `npm version` has bumped
 * package.json, committed and tagged.
 *
 * It prints nothing the build needs. Android reads package.json for its
 * versionName and the commit count for its versionCode (resolveVersionName /
 * resolveVersionCode in android/app/build.gradle). iOS does NOT: its marketing
 * version and build number live in ios/App/App.xcodeproj/project.pbxproj and
 * the build number is bumped by hand with ios/App/bump-build-number.sh before
 * an Archive. This exists so the numbers can be READ before a release rather
 * than discovered at upload time, which is where a wrong one costs a whole
 * build.
 */
const { execSync } = require("node:child_process");
const pkg = require("../package.json");

const read = (cmd, fallback) => {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return fallback;
  }
};

const version = pkg.version;
const androidBuild = read("git rev-list --count HEAD", "unknown");
const tag = read("git describe --tags --abbrev=0", `v${version}`);

const pbxproj = (() => {
  try { return require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "ios", "App", "App.xcodeproj", "project.pbxproj"), "utf8"); }
  catch { return ""; }
})();
const iosVersion = (pbxproj.match(/MARKETING_VERSION = ([^;]+);/) || [])[1] || "unknown";
const iosBuild = (pbxproj.match(/CURRENT_PROJECT_VERSION = (\d+);/) || [])[1] || "unknown";

console.log(`
  Clarity Caddy ${version}   tag ${tag}

  Android   version ${version}   build ${androidBuild} (commit count)
            npm run native:release:aab
            Re-archiving the SAME commit repeats build ${androidBuild} and Play will
            refuse it. Commit first, or override with ANDROID_VERSION_CODE.

  iOS       version ${iosVersion}   build ${iosBuild} (project.pbxproj)
            ${iosVersion === version ? "" : "MARKETING_VERSION does not match package.json - update it in Xcode.\n            "}Run ios/App/bump-build-number.sh BEFORE pressing Archive, then
            npm run native:ios and Archive and Distribute in Xcode.

  Push the tag so the release is recoverable:
      git push --follow-tags
`);
