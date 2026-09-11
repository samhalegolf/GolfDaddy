#!/bin/sh
# Bumps CURRENT_PROJECT_VERSION (the CFBundleVersion "build number") in
# App.xcodeproj/project.pbxproj by one, in every configuration of every target
# at once - the watch app must carry the SAME build number as the phone app or
# App Store Connect rejects the upload.
#
# Called by stamp-build-number.sh --bump from the Clarity Caddy Watch target's
# "Stamp build number" phase, on Archive only, so it runs once per archive and
# the number it writes is the number every bundle in that archive is stamped
# with. Plain builds and runs never touch it. Run by hand from anywhere:
#
#   ios/App/bump-build-number.sh          # next number
#   ios/App/bump-build-number.sh 900      # set an explicit number
#
# The project file is the single source of truth here - not the commit count,
# which is what the unused stamp-version.sh proposed - so what Xcode's General
# tab shows is always what the last archive was stamped with.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
PBXPROJ="$HERE/App.xcodeproj/project.pbxproj"
if [ ! -f "$PBXPROJ" ]; then
  echo "error: no project file at $PBXPROJ" >&2
  exit 1
fi

CURRENT="$(sed -n 's/^[[:space:]]*CURRENT_PROJECT_VERSION = \([0-9][0-9]*\);.*/\1/p' "$PBXPROJ" | sort -n | tail -1)"
case "$CURRENT" in
  ''|*[!0-9]*) echo "error: could not read a numeric CURRENT_PROJECT_VERSION from $PBXPROJ" >&2; exit 1 ;;
esac

if [ "${1:-}" != "" ]; then
  NEXT="$1"
  case "$NEXT" in
    ''|*[!0-9]*) echo "error: build number must be a whole number, got '$NEXT'" >&2; exit 1 ;;
  esac
else
  NEXT=$((CURRENT + 1))
fi

# Every occurrence, whatever its old value: a target that drifted behind the
# others is brought back into line rather than left one step behind forever.
sed -i '' "s/^\([[:space:]]*CURRENT_PROJECT_VERSION = \)[0-9][0-9]*;/\1${NEXT};/" "$PBXPROJ"

WRITTEN="$(grep -c "CURRENT_PROJECT_VERSION = ${NEXT};" "$PBXPROJ")"
echo "Clarity Caddy iOS: build number $CURRENT -> $NEXT ($WRITTEN build configurations)"
