#!/bin/sh
# Stamps the built app's version, so iOS matches what Android already does:
# the marketing version comes from package.json and the build number strictly
# increases on its own.
#
# Run as an Xcode "Stamp version" build phase, NOT as a repo edit. The build
# number is derived from the commit count, so writing it back into
# project.pbxproj would dirty the working tree on every commit - and committing
# that change would advance the count again, forever. Stamping the built product
# leaves the repo clean and works the same from Xcode, xcodebuild and CI.
#
# CFBundleVersion must strictly increase for every App Store Connect upload, and
# the old hardcoded 1 meant exactly one upload would ever be accepted.
#
# IOS_BUILD_NUMBER overrides the count, mirroring ANDROID_VERSION_CODE in
# android/app/build.gradle.
set -e

PLIST="${TARGET_BUILD_DIR}/${INFOPLIST_PATH}"
if [ ! -f "$PLIST" ]; then
  echo "warning: no built Info.plist at $PLIST - version not stamped"
  exit 0
fi

REPO_ROOT="${SRCROOT}/../.."
PACKAGE_JSON="${REPO_ROOT}/package.json"

# Marketing version from package.json, so app, web build and repo cannot drift.
MARKETING="1.0"
if [ -f "$PACKAGE_JSON" ]; then
  PARSED=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PACKAGE_JSON" | head -1)
  [ -n "$PARSED" ] && MARKETING="$PARSED"
fi

# Build number from the commit count, matching resolveVersionCode() on Android.
BUILD="1"
if [ -n "$IOS_BUILD_NUMBER" ]; then
  BUILD="$IOS_BUILD_NUMBER"
elif COUNTED=$(cd "$REPO_ROOT" && git rev-list --count HEAD 2>/dev/null); then
  case "$COUNTED" in
    ''|*[!0-9]*) ;;
    *) [ "$COUNTED" -gt 0 ] && BUILD="$COUNTED" ;;
  esac
fi

/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $MARKETING" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD" "$PLIST"
echo "Clarity Caddy iOS: CFBundleShortVersionString $MARKETING, CFBundleVersion $BUILD"
