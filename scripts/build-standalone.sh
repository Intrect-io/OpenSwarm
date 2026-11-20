#!/usr/bin/env bash
# Build a self-contained OpenSwarm bundle for the host platform.
#
#   bash scripts/build-standalone.sh             # bundle directory only
#   bash scripts/build-standalone.sh --tarball   # also .tar.gz + .sha256 (CI)
#
# Output: dist-standalone/openswarm-<version>-<os>-<arch>/
#   bin/openswarm   launcher; runs only the bundled node, never one on PATH
#   node/           official Node.js runtime (NODE_VERSION below), SHA-256 pinned
#   app/            the npm package contents (what `npm pack` ships) plus its
#                   production node_modules, installed by the bundled node so
#                   native modules (better-sqlite3, @lancedb/lancedb, ...) match
#                   its ABI
#   VERSION         package version
#   COMMIT          git commit the bundle was built from
#   BUILD-INFO.json platform, node version, build time
#
# The bundle runs without a system Node.js, npm or Docker. Native modules are
# platform-specific, so a bundle is built on the platform it targets (CI runs
# one job per platform); there is no cross-building.
#
# Staging happens only under dist-standalone/ (git-ignored). Nothing is staged
# in /tmp, which is tmpfs (RAM) on some hosts.
#
# Env:
#   OPENSWARM_STANDALONE_CACHE  where downloaded Node archives are kept
#                               (default: ${XDG_CACHE_HOME:-~/.cache}/openswarm-standalone)

set -euo pipefail

NODE_VERSION="22.23.5"

# SHA-256 of the official archives, copied from
# https://nodejs.org/dist/v22.23.5/SHASUMS256.txt (2026-11-11 security release).
# Pinned here so a tampered mirror or a swapped SHASUMS file cannot pass.
node_sha256() {
  case "$1" in
    linux-x64) echo "c54118104acc524633b5abe106bbf44a53126ec8b4e5fa105cb92b5d7de8a1a1" ;;
    linux-arm64) echo "8bd3dc69eee8f3f226315a80d7d1d4faccf217a4c8fae500168ac2e38f3bdba3" ;;
    darwin-arm64) echo "e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d" ;;
    darwin-x64) echo "c53383238206b9ae4db23c5d8a63645e2e753bec8ab51a49cc81939aa64e9422" ;;
    *) return 1 ;;
  esac
}

die() { echo "build-standalone: $*" >&2; exit 1; }
log() { echo "build-standalone: $*"; }

TARBALL=0
for arg in "$@"; do
  case "$arg" in
    --tarball) TARBALL=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "unknown argument: $arg" ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO_ROOT"

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "unsupported OS: $(uname -s) (linux and darwin are supported)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported CPU: $(uname -m) (x64 and arm64 are supported)" ;;
esac
PLATFORM="${OS}-${ARCH}"
EXPECTED_SHA="$(node_sha256 "$PLATFORM")" || die "no pinned Node.js archive for $PLATFORM"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

command -v node >/dev/null 2>&1 || die "building needs a host node (for tsc); the bundle itself does not"
command -v npm >/dev/null 2>&1 || die "building needs a host npm"

VERSION="$(node -p "require('./package.json').version")"
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
NAME="openswarm-${VERSION}-${PLATFORM}"
OUT_ROOT="$REPO_ROOT/dist-standalone"
TARGET="$OUT_ROOT/$NAME"
STAGE="$OUT_ROOT/.stage-$NAME-$$"
mkdir -p "$OUT_ROOT"

cleanup() { [ -d "$STAGE" ] && rm -rf "$STAGE"; return 0; }
trap cleanup EXIT

# --- 1. Compile the package (host toolchain) ---------------------------------
if [ ! -d node_modules ]; then
  log "installing build dependencies (npm ci)"
  npm ci --prefer-offline --no-audit --no-fund
fi
log "compiling (npm run build)"
npm run build --silent

# --- 2. Node.js runtime, pinned by SHA-256 -----------------------------------
CACHE_DIR="${OPENSWARM_STANDALONE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/openswarm-standalone}"
mkdir -p "$CACHE_DIR"
ARCHIVE="node-v${NODE_VERSION}-${PLATFORM}.tar.gz"
CACHED="$CACHE_DIR/$ARCHIVE"
if [ ! -f "$CACHED" ] || [ "$(sha256_of "$CACHED")" != "$EXPECTED_SHA" ]; then
  log "downloading Node.js v${NODE_VERSION} (${PLATFORM})"
  PART="$CACHED.part.$$"
  curl -fsSL --retry 3 --retry-delay 2 -o "$PART" "https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVE}"
  GOT="$(sha256_of "$PART")"
  if [ "$GOT" != "$EXPECTED_SHA" ]; then
    rm -f "$PART"
    die "SHA-256 mismatch for $ARCHIVE: expected $EXPECTED_SHA, got $GOT"
  fi
  mv "$PART" "$CACHED"
fi

mkdir -p "$STAGE"
tar -xzf "$CACHED" -C "$STAGE"
mv "$STAGE/node-v${NODE_VERSION}-${PLATFORM}" "$STAGE/node"
BUNDLED_NODE="$STAGE/node/bin/node"
[ "$("$BUNDLED_NODE" --version)" = "v${NODE_VERSION}" ] || die "bundled node does not report v${NODE_VERSION}"

# --- 3. Package contents + production dependencies ---------------------------
log "packing the npm package"
PACKED="$(npm pack --silent --pack-destination "$STAGE" | tail -n 1)"
[ -f "$STAGE/$PACKED" ] || die "npm pack produced no tarball"
tar -xzf "$STAGE/$PACKED" -C "$STAGE"
rm -f "$STAGE/$PACKED"
mv "$STAGE/package" "$STAGE/app"
cp package-lock.json "$STAGE/app/package-lock.json"

log "installing production dependencies with the bundled node"
(
  cd "$STAGE/app"
  # The bundled node first on PATH: npm's shim, install scripts and node-gyp
  # all resolve `node` from PATH, and the native modules they fetch or build
  # must match the bundled runtime's ABI, not the host's.
  #
  # ONNXRUNTIME_NODE_INSTALL=skip: onnxruntime-node's postinstall otherwise
  # downloads the CUDA and TensorRT execution providers (~316 MB on
  # linux-x64). OpenSwarm embeds on the CPU provider, which ships in the
  # package itself.
  PATH="$STAGE/node/bin:$PATH" \
  ONNXRUNTIME_NODE_INSTALL=skip \
  npm_config_update_notifier=false \
  npm_config_fund=false \
  npm_config_audit=false \
    "$STAGE/node/bin/npm" ci --omit=dev --prefer-offline --no-audit --no-fund --loglevel=error
)

# Headers and man pages were only needed while installing.
rm -rf "$STAGE/node/include" "$STAGE/node/share"

# onnxruntime-node ships prebuilt bindings for every OS and CPU and loads
# bin/napi-v*/<process.platform>/<process.arch>/ only; the others are dead
# weight in a single-platform bundle.
ORT_BIN="$STAGE/app/node_modules/onnxruntime-node/bin"
if [ -d "$ORT_BIN" ]; then
  for napi in "$ORT_BIN"/napi-v*; do
    [ -d "$napi" ] || continue
    for os_dir in "$napi"/*; do
      [ -d "$os_dir" ] || continue
      if [ "$(basename "$os_dir")" != "$OS" ]; then rm -rf "$os_dir"; continue; fi
      for arch_dir in "$os_dir"/*; do
        [ -d "$arch_dir" ] && [ "$(basename "$arch_dir")" != "$ARCH" ] && rm -rf "$arch_dir"
      done
    done
  done
  [ -e "$ORT_BIN/napi-v6/$OS/$ARCH/onnxruntime_binding.node" ] || die "onnxruntime-node has no binding for $PLATFORM after pruning"
fi

# --- 4. Launcher and metadata -------------------------------------------------
mkdir -p "$STAGE/bin"
cat > "$STAGE/bin/openswarm" <<'LAUNCHER'
#!/bin/sh
# OpenSwarm standalone launcher. Runs the bundled Node.js only; a `node` on
# PATH is never used to start OpenSwarm.
set -e
self="$0"
while [ -h "$self" ]; do
  link="$(readlink "$self")"
  case "$link" in
    /*) self="$link" ;;
    *) self="$(dirname "$self")/$link" ;;
  esac
done
root="$(cd "$(dirname "$self")/.." && pwd -P)"
# Child processes that spawn `node`/`npx` get the bundled runtime too.
PATH="$root/node/bin:$PATH"
export PATH
# The npm self-update (`npm install -g @intrect/openswarm@latest`) would write
# into this bundle's runtime; a bundle is updated by installing a newer bundle.
OPENSWARM_NO_AUTO_UPDATE="${OPENSWARM_NO_AUTO_UPDATE:-1}"
NO_UPDATE_NOTIFIER="${NO_UPDATE_NOTIFIER:-1}"
OPENSWARM_STANDALONE=1
export OPENSWARM_NO_AUTO_UPDATE NO_UPDATE_NOTIFIER OPENSWARM_STANDALONE
exec "$root/node/bin/node" "$root/app/dist/cli.js" "$@"
LAUNCHER
chmod 0755 "$STAGE/bin/openswarm"

printf '%s\n' "$VERSION" > "$STAGE/VERSION"
printf '%s\n' "$COMMIT" > "$STAGE/COMMIT"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
"$BUNDLED_NODE" -e '
  const [version, commit, platform, node, builtAt] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({ name: "openswarm", version, commit, platform, node, builtAt }, null, 2) + "\n");
' "$VERSION" "$COMMIT" "$PLATFORM" "v$NODE_VERSION" "$BUILT_AT" > "$STAGE/BUILD-INFO.json"

# --- 5. Publish the staged bundle --------------------------------------------
[ -d "$TARGET" ] && rm -rf "$TARGET"
mv "$STAGE" "$TARGET"
log "bundle: $TARGET"

if [ "$TARBALL" = 1 ]; then
  TGZ="$OUT_ROOT/$NAME.tar.gz"
  tar -czf "$TGZ" -C "$OUT_ROOT" "$NAME"
  (cd "$OUT_ROOT" && printf '%s  %s\n' "$(sha256_of "$NAME.tar.gz")" "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
  log "tarball: $TGZ"
fi
