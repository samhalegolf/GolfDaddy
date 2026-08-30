#!/usr/bin/env node
/*
 * Runs as npm's `postversion` hook, after `npm version` has bumped
 * package.json, committed and tagged.
 *
 * It prints nothing the build needs - the version already flows automatically
 * into both platforms (ios/App/stamp-version.sh and resolveVersionName() in
 * android/app/build.gradle both read package.json; both build numbers come from
 * the commit count). This exists so the two numbers can be READ before an
 * archive rather than discovered at upload time, which is where a wrong one
 * costs a whole build.
 *
 * The commit count is taken after the version commit, so the build number shown
 * here is the one the archive will actually carry.
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
const build = read("git rev-list --count HEAD", "unknown");
const tag = read("git describe --tags --abbrev=0", `v${version}`);

console.log(`
  Clarity Caddy ${version}   build ${build}   tag ${tag}

  Both stores see version ${version}. Build ${build} must be higher than your
  last upload - check App Store Connect / Play Console if unsure.

  iOS       npm run native:ios      then Archive and Distribute in Xcode
  Android   npm run native:release:aab

  Push the tag so the release is recoverable:
      git push --follow-tags

  Re-archiving the SAME commit repeats build ${build} and the upload will be
  refused. Commit the fix first, or override:
      IOS_BUILD_NUMBER=${build === "unknown" ? "N" : Number(build) + 1} npm run native:ios
`);
