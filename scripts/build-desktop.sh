#!/bin/bash
# OpenSwarm desktop shell macOS build script (INT-3388 M2).
#
# The desktop app is a thin Tauri shell attaching to the launchd-managed
# OpenSwarm daemon (com.intrect.openswarm, http://127.0.0.1:3847). It bundles
# no backend — install the daemon separately with `npm run service:install`.
#
# Prerequisites:
#   - Rust + cargo-tauri: cargo install tauri-cli --locked
#
# Usage:
#   bash scripts/build-desktop.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/desktop"

APP_NAME="OpenSwarm"

echo "=== ${APP_NAME} desktop shell build ==="
echo "    config: desktop/tauri.conf.json"
echo ""

cargo tauri build \
    --target aarch64-apple-darwin \
    2>&1 | grep -E "Compiling|Finished|error\[|Bundling|tauri"

BUNDLE_DIR="$REPO_ROOT/desktop/target/aarch64-apple-darwin/release/bundle"
DMG_PATH=$(find "$BUNDLE_DIR/dmg" -name "*.dmg" 2>/dev/null | head -1)
APP_PATH=$(find "$BUNDLE_DIR/macos" -maxdepth 1 -name "*.app" 2>/dev/null | head -1)

if [ -z "$DMG_PATH" ] && [ -z "$APP_PATH" ]; then
    echo ""
    echo "ERROR: no .app/.dmg produced — check the build log above." >&2
    exit 1
fi

echo ""
echo "=== Build complete ==="
[ -n "$APP_PATH" ] && ls -d "$APP_PATH"
[ -n "$DMG_PATH" ] && ls -lh "$DMG_PATH"
echo ""
echo "Install: drag ${APP_NAME}.app into /Applications."
echo "The shell connects to the daemon at http://127.0.0.1:3847 (tray > Settings to change)."
