#!/usr/bin/env bash
#
# Package the built .app into a distributable .dmg using hdiutil only.
# This avoids Tauri's bundle_dmg.sh, which drives Finder via AppleScript and
# fails without "control Finder" Automation permission (error -1743).
#
# Usage: npm run dmg   (run `npm run tauri build` first to produce the .app)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/src-tauri/target/release/bundle/macos/Ralph Loop Junkie.app"

if [ ! -d "$APP" ]; then
  echo "error: app bundle not found at:" >&2
  echo "  $APP" >&2
  echo "Run 'npm run tauri build' first." >&2
  exit 1
fi

VERSION="$(node -p "require('$ROOT/package.json').version")"
OUTDIR="$ROOT/src-tauri/target/release/bundle/dmg"
OUT="$OUTDIR/Ralph Loop Junkie_${VERSION}.dmg"

mkdir -p "$OUTDIR"

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

cp -R "$APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"

rm -f "$OUT"
hdiutil create \
  -volname "Ralph Loop Junkie" \
  -srcfolder "$STAGING" \
  -ov -format UDZO \
  "$OUT" >/dev/null

echo "Created: $OUT"
