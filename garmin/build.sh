#!/usr/bin/env bash
#
# Clarity Caddy — Garmin Connect IQ build / package script.
#
#   ./build.sh check      verify SDK + key + devices are in place, build nothing
#   ./build.sh build      compile a debug .prg for one device (default: approachs62)
#   ./build.sh package    produce the signed .iq for the Connect IQ store
#
# Requires the Connect IQ SDK on PATH (or CIQ_SDK set to the SDK root).
# Install via the Connect IQ SDK Manager, then download every device listed
# in manifest.xml — the compiler fails on a product it has no definition for.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

KEY="${CIQ_KEY:-$HOME/.garmin/clarity_caddy_developer_key}"
OUT="$HERE/build"
DEVICE="${CIQ_DEVICE:-approachs62}"

# ---------------------------------------------------------------- locate SDK

if [[ -n "${CIQ_SDK:-}" ]]; then
  MONKEYC="$CIQ_SDK/bin/monkeyc"
elif command -v monkeyc >/dev/null 2>&1; then
  MONKEYC="$(command -v monkeyc)"
else
  # SDK Manager's default install location on macOS
  CURRENT="$HOME/Library/Application Support/Garmin/ConnectIQ/current-sdk.cfg"
  if [[ -f "$CURRENT" ]]; then
    MONKEYC="$(cat "$CURRENT")/bin/monkeyc"
  else
    echo "ERROR: Connect IQ SDK not found."
    echo "  Install the SDK Manager: https://developer.garmin.com/connect-iq/sdk/"
    echo "  Then either add its bin/ to PATH or set CIQ_SDK=/path/to/sdk"
    exit 1
  fi
fi

[[ -x "$MONKEYC" ]] || { echo "ERROR: monkeyc not executable at $MONKEYC"; exit 1; }
SDK_ROOT="$(cd "$(dirname "$MONKEYC")/.." && pwd)"

# ------------------------------------------------------------- developer key

ensure_key() {
  if [[ -f "$KEY" ]]; then return; fi
  echo "No developer key at $KEY — generating one."
  echo "KEEP THIS FILE AND BACK IT UP. Garmin ties your published app to it;"
  echo "losing it means you cannot ship an update to the same store listing."
  mkdir -p "$(dirname "$KEY")"
  # Connect IQ wants a 4096-bit RSA private key in PKCS#8 DER form.
  openssl genrsa -out "$KEY.pem" 4096 2>/dev/null
  openssl pkcs8 -topk8 -inform PEM -outform DER -in "$KEY.pem" -out "$KEY" -nocrypt
  rm -f "$KEY.pem"
  chmod 600 "$KEY"
  echo "Created $KEY"
}

# ------------------------------------------------------------------- targets

manifest_products() {
  grep -o 'iq:product id="[^"]*"' manifest.xml | cut -d'"' -f2
}

installed_devices() {
  local dir="$HOME/Library/Application Support/Garmin/ConnectIQ/Devices"
  [[ -d "$dir" ]] && ls "$dir" || true
}

# --------------------------------------------------------------------- verbs

cmd_check() {
  echo "SDK:    $SDK_ROOT"
  echo "Key:    $KEY $([[ -f "$KEY" ]] && echo '(present)' || echo '(MISSING — run build or package to create)')"
  echo
  echo "Devices required by manifest.xml:"
  local have missing=0
  have="$(installed_devices)"
  while read -r p; do
    if grep -qx "$p" <<<"$have"; then
      echo "  ok       $p"
    else
      echo "  MISSING  $p   <- download it in the SDK Manager"
      missing=1
    fi
  done < <(manifest_products)
  [[ $missing -eq 0 ]] || { echo; echo "Download the missing devices before packaging."; exit 1; }
}

cmd_build() {
  ensure_key
  mkdir -p "$OUT"
  echo "Building $DEVICE (debug)..."
  "$MONKEYC" \
    --jungles monkey.jungle \
    --device "$DEVICE" \
    --output "$OUT/ClarityCaddy-$DEVICE.prg" \
    --private-key "$KEY" \
    --warn
  echo "Wrote $OUT/ClarityCaddy-$DEVICE.prg"
  echo "Run it with:  \"$SDK_ROOT/bin/connectiq\" &  then  \"$SDK_ROOT/bin/monkeydo\" \"$OUT/ClarityCaddy-$DEVICE.prg\" $DEVICE"
}

cmd_package() {
  ensure_key
  cmd_check
  mkdir -p "$OUT"
  echo
  echo "Packaging release .iq for all manifest products..."
  "$MONKEYC" \
    --jungles monkey.jungle \
    --output "$OUT/ClarityCaddy.iq" \
    --private-key "$KEY" \
    --package-app \
    --release \
    --warn
  echo
  echo "Wrote $OUT/ClarityCaddy.iq"
  echo "Upload this file at https://apps.garmin.com/developer/dashboard"
}

case "${1:-check}" in
  check)   cmd_check ;;
  build)   cmd_build ;;
  package) cmd_package ;;
  *)       echo "usage: $0 {check|build|package}"; exit 2 ;;
esac
