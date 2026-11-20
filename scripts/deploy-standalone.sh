#!/usr/bin/env bash
# Build the standalone bundle from this checkout and install it on this host.
#
#   bash scripts/deploy-standalone.sh
#
# Installs into ${OPENSWARM_STANDALONE_HOME:-$HOME/.local/share/openswarm-standalone}:
#   releases/<version>-<shortsha>/   one installed bundle per deploy
#   current -> releases/<...>        swapped atomically (rename over the link)
# The newest 3 releases are kept; older ones are removed (never the target of
# `current`).
#
# Scope. This installs files and nothing else. It never touches ~/.local/bin
# (the operator's own `openswarm`), ~/.openswarm or ~/.config/openswarm, any
# docker container, or a running daemon; it starts no process that outlives
# it. Proving the installed bundle works is scripts/smoke-standalone.sh.
#
# Memory. The build (tsc + npm ci) runs inside a systemd user scope capped at
# OPENSWARM_DEPLOY_MEMORY_MAX (default 6G) when systemd-run is available, so a
# deploy cannot push the host into OOM.

set -euo pipefail

die() { echo "deploy-standalone: $*" >&2; exit 1; }
log() { echo "deploy-standalone: $*"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO_ROOT"

INSTALL_ROOT="${OPENSWARM_STANDALONE_HOME:-$HOME/.local/share/openswarm-standalone}"
KEEP=3
MEMORY_MAX="${OPENSWARM_DEPLOY_MEMORY_MAX:-6G}"

# --- 1. Build ------------------------------------------------------------------
# A login shell started by a scheduler may lack XDG_RUNTIME_DIR, which
# `systemd-run --user` needs to find the user bus.
if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [ "$(uname -s)" = Linux ] && command -v systemd-run >/dev/null 2>&1 \
  && systemd-run --user --scope -q -p MemoryMax=64M true >/dev/null 2>&1; then
  log "building under systemd-run MemoryMax=$MEMORY_MAX"
  systemd-run --user --scope -q -p "MemoryMax=$MEMORY_MAX" nice -n 10 bash scripts/build-standalone.sh
else
  log "building (no systemd user scope available; running uncapped)"
  bash scripts/build-standalone.sh
fi

VERSION="$(node -p "require('./package.json').version")"
case "$(uname -s)" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) die "unsupported OS" ;; esac
case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "unsupported CPU" ;; esac
BUILT="$REPO_ROOT/dist-standalone/openswarm-${VERSION}-${OS}-${ARCH}"
[ -x "$BUILT/bin/openswarm" ] || die "build produced no bundle at $BUILT"
SHORT="$(cut -c1-12 < "$BUILT/COMMIT")"
RELEASE="${VERSION}-${SHORT}"

# --- 2. Install ----------------------------------------------------------------
mkdir -p "$INSTALL_ROOT/releases"
DEST="$INSTALL_ROOT/releases/$RELEASE"
INCOMING="$INSTALL_ROOT/releases/.incoming-$RELEASE-$$"
trap '[ -d "$INCOMING" ] && rm -rf "$INCOMING"; true' EXIT
# Copy rather than move: the install root may be on another filesystem, and a
# half-copied release must never be what `current` points at.
cp -a "$BUILT" "$INCOMING"
if [ -d "$DEST" ]; then
  # Redeploy of the same commit: replace it, keeping `current` valid until the
  # swap below (the old directory is renamed away first, then dropped).
  OLD="$INSTALL_ROOT/releases/.replaced-$RELEASE-$$"
  mv "$DEST" "$OLD"
  mv "$INCOMING" "$DEST"
  rm -rf "$OLD"
else
  mv "$INCOMING" "$DEST"
fi

# Atomic swap: make a new link beside `current`, then rename it over.
LINK_TMP="$INSTALL_ROOT/.current-$$"
ln -sfn "releases/$RELEASE" "$LINK_TMP"
if mv -T "$LINK_TMP" "$INSTALL_ROOT/current" 2>/dev/null; then :
else
  # BSD mv has no -T; -h/-f replaces the link itself rather than its target.
  mv -fh "$LINK_TMP" "$INSTALL_ROOT/current"
fi
log "installed $RELEASE -> $INSTALL_ROOT/current"

# --- 3. Prune ------------------------------------------------------------------
CURRENT_TARGET="$(basename "$(readlink "$INSTALL_ROOT/current")")"
# Newest first by modification time; keep $KEEP, never the current one.
ls -1t "$INSTALL_ROOT/releases" | grep -v '^\.' | tail -n +"$((KEEP + 1))" | while read -r old; do
  [ "$old" = "$CURRENT_TARGET" ] && continue
  rm -rf "${INSTALL_ROOT:?}/releases/$old"
  log "pruned release $old"
done

# The build output in the checkout is no longer needed once installed.
rm -rf "$BUILT"
log "done: $(cat "$INSTALL_ROOT/current/VERSION") ($(cat "$INSTALL_ROOT/current/COMMIT" | cut -c1-12))"
