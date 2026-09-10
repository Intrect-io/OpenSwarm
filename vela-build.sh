#!/usr/bin/env bash
# vela-build.sh — build OpenSwarm daemon image from a git SHA
#
# Usage:
#   ./vela-build.sh <sha>          # build image tagged openswarm:vela-<date>-<arch>
#   ./vela-build.sh <sha> --push   # build and push to registry
#
# Builds from origin/main only (PR SHAs need a separate fetch step).
# Tag format: openswarm:vela-YYYYMMDD-HHMM-amd64
#
# Design: https://linear.app/intrect/issue/AGT-4182

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
DEPLOY_DIR="${OPENSWARM_DEPLOY_DIR:-${HOME}/openswarm-deploy}"
REPO_DIR="${OPENSWARM_BUILD_REPO_DIR:-${DEPLOY_DIR}/repo}"
IMAGE_PREFIX="openswarm:vela"
PLATFORM="${OPENSWARM_BUILD_PLATFORM:-linux/amd64}"
DOCKERFILE="${OPENSWARM_DOCKERFILE:-${REPO_DIR}/Dockerfile}"

# ── Helpers ─────────────────────────────────────────────────────────────────

die() {
  echo "ERROR $*" >&2
  exit 1
}

usage() {
  echo "Usage: $0 <sha> [--push]" >&2
  exit 1
}

# ── Parse args ──────────────────────────────────────────────────────────────

SHA="${1:-}"
PUSH=false
if [[ -z "${SHA}" ]]; then
  usage
fi
shift
if [[ "${1:-}" == "--push" ]]; then
  PUSH=true
fi

# Validate SHA format (hex, 40 chars)
if ! [[ "${SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  die "invalid SHA: ${SHA} (expected 40-char hex)"
fi

# ── Ensure repo clone ───────────────────────────────────────────────────────

REPO_URL="$(git -C "${DEPLOY_DIR}" remote get-url origin 2>/dev/null || true)"
if [[ -z "${REPO_URL}" ]]; then
  REPO_URL="${OPENSWARM_REPO_URL:-https://github.com/intrect/OpenSwarm.git}"
fi

if [[ ! -d "${REPO_DIR}/.git" ]]; then
  echo "cloning repository into ${REPO_DIR} ..."
  mkdir -p "$(dirname "${REPO_DIR}")"
  git clone --filter=blob:none --no-checkout "${REPO_URL}" "${REPO_DIR}"
fi

# ── Fetch + checkout the target SHA ─────────────────────────────────────────
# Partial clone with --no-checkout leaves an empty tree; docker build needs the
# files. Fetch the commit, then force-checkout so the build context matches SHA.

echo "fetching SHA ${SHA} ..."
git -C "${REPO_DIR}" fetch --depth=1 origin "${SHA}" 2>&1 || \
  die "git fetch failed for SHA ${SHA}"

if ! git -C "${REPO_DIR}" cat-file -e "${SHA}^{commit}" 2>/dev/null; then
  die "SHA ${SHA} is not a valid commit"
fi

echo "checking out ${SHA} ..."
git -C "${REPO_DIR}" checkout --force "${SHA}" 2>&1 || \
  die "git checkout failed for SHA ${SHA}"

if [[ ! -f "${DOCKERFILE}" ]]; then
  die "Dockerfile not found at ${DOCKERFILE} after checkout"
fi

# ── Generate image tag ──────────────────────────────────────────────────────

TIMESTAMP="$(TZ=UTC date +%Y%m%d-%H%M)"
ARCH="amd64"
IMAGE_TAG="${IMAGE_PREFIX}-${TIMESTAMP}-${ARCH}"
echo "image tag: ${IMAGE_TAG}"

# ── Build ───────────────────────────────────────────────────────────────────

echo "building ${IMAGE_TAG} from SHA ${SHA} ..."
docker build \
  --platform "${PLATFORM}" \
  --tag "${IMAGE_TAG}" \
  --file "${DOCKERFILE}" \
  --build-arg "GIT_SHA=${SHA}" \
  "${REPO_DIR}" 2>&1 || die "docker build failed for ${IMAGE_TAG}"

echo "build succeeded: ${IMAGE_TAG}"

# ── Push (optional) ─────────────────────────────────────────────────────────

if [[ "${PUSH}" == "true" ]]; then
  echo "pushing ${IMAGE_TAG} ..."
  docker push "${IMAGE_TAG}" 2>&1 || die "docker push failed for ${IMAGE_TAG}"
  echo "push succeeded: ${IMAGE_TAG}"
fi

# ── Output (last line consumed by vela-autodeploy.sh) ───────────────────────

echo "${IMAGE_TAG}"
