#!/bin/sh
# "Stamp build number" - the last build phase in the App, Clarity Caddy Watch
# and Clarity Caddy Watch Extension targets.
#
# Two jobs:
#   --bump  On an Archive (and only then - ACTION is "install"), add one to
#           CURRENT_PROJECT_VERSION in project.pbxproj via bump-build-number.sh.
#           Passed by exactly ONE target: the Watch Extension, because it is the
#           leaf of the dependency chain (App -> Watch -> Extension) and so the
#           first of the three to reach this phase. If the watch targets are
#           ever removed, move the --bump to the App target's phase.
#   always  Write the number that is in project.pbxproj RIGHT NOW into this
#           target's built Info.plist. $(CURRENT_PROJECT_VERSION) cannot be
#           used for this: Xcode resolves build settings before the build
#           starts, so after a bump it still holds the old number.
#
# Each target stamps its OWN product, before the target above embeds and signs
# it - editing a nested bundle's Info.plist after "Embed Watch Content" has
# signed it would break that signature. On an ordinary build (Run, Test,
# Profile) nothing is bumped and the stamp matches the build setting, so this
# is a no-op.
#
# A scheme Archive pre-action was tried first and does not work: under
# xcodebuild the "pre-action" runs AFTER the build, so the archive always
# carried the number from before the bump.
set -eu

PBXPROJ="${PROJECT_FILE_PATH}/project.pbxproj"

if [ "${1:-}" = "--bump" ] && [ "${ACTION:-}" = "install" ]; then
  "${SRCROOT}/bump-build-number.sh"
fi

PLIST="${TARGET_BUILD_DIR}/${INFOPLIST_PATH}"
if [ ! -f "$PLIST" ]; then
  echo "warning: no built Info.plist at $PLIST - build number not stamped"
  exit 0
fi

NUMBER="$(sed -n 's/^[[:space:]]*CURRENT_PROJECT_VERSION = \([0-9][0-9]*\);.*/\1/p' "$PBXPROJ" | sort -n | tail -1)"
case "$NUMBER" in
  ''|*[!0-9]*) echo "warning: could not read CURRENT_PROJECT_VERSION from $PBXPROJ - build number not stamped"; exit 0 ;;
esac

HAVE="$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$PLIST" 2>/dev/null || echo "")"
if [ "$HAVE" = "$NUMBER" ]; then
  echo "Clarity Caddy iOS: ${PRODUCT_NAME} already at build ${NUMBER}"
  exit 0
fi
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $NUMBER" "$PLIST"
echo "Clarity Caddy iOS: ${PRODUCT_NAME} build ${HAVE:-?} -> ${NUMBER}"
