#!/usr/bin/env bash
# vela-autodeploy.sh — autodeploy lane for OpenSwarm daemon on rtx
#
# Cron every 20 min, flock-guarded. Merged main → build → deploy → verify.
# Deployed at ~/openswarm-deploy on rtx (override with OPENSWARM_DEPLOY_DIR).
#
# Usage:
#   ./vela-autodeploy.sh            # normal run (cron)
#   ./vela-autodeploy.sh --dry-run  # print decisions; no compose/image/sha mutations
#
# Design: https://linear.app/intrect/issue/AGT-4182

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Config (env overrides exist so the checklist is testable off-host) ──────
DEPLOY_DIR="${OPENSWARM_DEPLOY_DIR:-${HOME}/openswarm-deploy}"
COMPOSE_FILE="${OPENSWARM_COMPOSE_FILE:-${DEPLOY_DIR}/docker-compose.yml}"
COMPOSE_STRICT="${OPENSWARM_COMPOSE_STRICT:-${DEPLOY_DIR}/docker-compose.strict-sandbox.yml}"
SERVICE_NAME="${OPENSWARM_SERVICE_NAME:-openswarm}"
LAST_BUILT_SHA_FILE="${OPENSWARM_LAST_BUILT_SHA_FILE:-${DEPLOY_DIR}/.last-built-sha}"
AUTODEPLOY_LOG="${OPENSWARM_AUTODEPLOY_LOG:-${DEPLOY_DIR}/autodeploy.log}"
LOCK_FILE="${OPENSWARM_AUTODEPLOY_LOCK:-${DEPLOY_DIR}/.autodeploy.lock}"
HEALTH_URL="${OPENSWARM_HEALTH_URL:-http://localhost:3847/api/health}"
HEALTH_TIMEOUT_SEC="${OPENSWARM_HEALTH_TIMEOUT_SEC:-90}"
RATE_LIMIT_MIN="${OPENSWARM_RATE_LIMIT_MIN:-55}"
IMAGE_PREFIX="openswarm:vela"
EXECUTOR_SOCK="${OPENSWARM_EXECUTOR_SOCK:-/run/openswarm-sandbox/executor.sock}"
AUTOMATION_DB="${OPENSWARM_AUTOMATION_DB:-${HOME}/.openswarm/automation.db}"

if [[ -n "${VELA_BUILD_SCRIPT:-}" ]]; then
  :
elif [[ -x "${DEPLOY_DIR}/vela-build.sh" ]]; then
  VELA_BUILD_SCRIPT="${DEPLOY_DIR}/vela-build.sh"
elif [[ -x "${SCRIPT_DIR}/vela-build.sh" ]]; then
  VELA_BUILD_SCRIPT="${SCRIPT_DIR}/vela-build.sh"
else
  VELA_BUILD_SCRIPT="${DEPLOY_DIR}/vela-build.sh"
fi

# ── Helpers ─────────────────────────────────────────────────────────────────

log() {
  local ts
  ts="$(date --iso-8601=seconds 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  # Log file may be unset before mkdir; still print to stdout.
  if [[ -n "${AUTODEPLOY_LOG:-}" ]]; then
    mkdir -p "$(dirname "${AUTODEPLOY_LOG}")" 2>/dev/null || true
    echo "${ts}  $*" >> "${AUTODEPLOY_LOG}" 2>/dev/null || true
  fi
  echo "${ts}  $*"
}

warn() {
  log "WARN  $*"
}

die() {
  log "ERROR $*"
  exit 1
}

rollback_to() {
  local prev_tag="$1"
  local compose_backup="$2"
  if [[ -z "${prev_tag}" ]]; then
    warn "ROLLBACK no previous image tag known — cannot roll back"
    return 1
  fi
  if [[ -n "${compose_backup}" && -f "${compose_backup}" ]]; then
    cp "${compose_backup}" "${COMPOSE_FILE}"
    log "ROLLBACK restored compose file from backup"
  else
    local new_tag
    new_tag="$(sed -n 's/.*image:[[:space:]]*\(openswarm:vela-[0-9]\{8\}-[0-9]\{4\}-amd64\).*/\1/p' "${COMPOSE_FILE}" | head -1)"
    if [[ -n "${new_tag}" ]]; then
      sed -i "s|${new_tag}|${prev_tag}|g" "${COMPOSE_FILE}"
      log "ROLLBACK reverted tag ${new_tag} → ${prev_tag} in compose file"
    fi
  fi

  log "ROLLBACK redeploying with ${prev_tag} ..."
  if docker compose -f "${COMPOSE_FILE}" -f "${COMPOSE_STRICT}" up -d --no-deps "${SERVICE_NAME}" 2>&1; then
    log "ROLLBACK redeploy succeeded"
    return 0
  fi
  warn "ROLLBACK redeploy also failed — container may be down"
  return 1
}

read_compose_image() {
  local file="$1"
  [[ -f "${file}" ]] || return 0
  sed -n 's/.*image:[[:space:]]*\(openswarm:vela-[0-9]\{8\}-[0-9]\{4\}-amd64\).*/\1/p' "${file}" | head -1
}

# ── Init ────────────────────────────────────────────────────────────────────

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

mkdir -p "${DEPLOY_DIR}"

if [[ "${DRY_RUN}" == "true" ]]; then
  log "DRY-RUN mode — no build/deploy/compose/sha side effects"
fi

# Flock guard — only one instance at a time
exec 200>"${LOCK_FILE}"
if ! flock -n 200; then
  log "SKIP  another autodeploy instance is running (flock held)"
  exit 0
fi

cd "${DEPLOY_DIR}"

# ── Step 1: Fetch origin/main SHA ──────────────────────────────────────────

log "STEP 1  fetch origin/main SHA"

MAIN_SHA=""
if ! MAIN_SHA="$(git ls-remote origin main 2>/dev/null | awk '{print $1}')"; then
  die "could not reach origin to read main SHA"
fi
if [[ -z "${MAIN_SHA}" ]]; then
  die "git ls-remote returned empty SHA for main"
fi
log "       origin/main = ${MAIN_SHA}"

if [[ -f "${LAST_BUILT_SHA_FILE}" ]]; then
  LAST_SHA="$(tr -d '[:space:]' < "${LAST_BUILT_SHA_FILE}")"
  if [[ "${LAST_SHA}" == "${MAIN_SHA}" ]]; then
    log "SKIP  running image already built from ${MAIN_SHA}"
    exit 0
  fi
  log "       last built SHA = ${LAST_SHA} (differs — proceeding)"
else
  log "       no ${LAST_BUILT_SHA_FILE} — first run, proceeding"
fi

# ── Step 2: CI trust ────────────────────────────────────────────────────────

log "STEP 2  CI trust — main is branch-protected with required checks; merged main is green by construction"

# ── Step 3: Safety window — ledger must be idle ────────────────────────────

log "STEP 3  ledger safety window"

LEDGER_ACTIVE=-1
LEDGER_CHECK_FAILED=false

if command -v sqlite3 &>/dev/null && [[ -f "${AUTOMATION_DB}" ]]; then
  LEDGER_ACTIVE="$(sqlite3 "${AUTOMATION_DB}" "
    SELECT COUNT(*) FROM automation_runs
    WHERE state IN ('VERIFYING', 'PUBLISHING', 'EXECUTING', 'CLAIMED')
  " 2>/dev/null)" || LEDGER_ACTIVE=-1

  if [[ "${LEDGER_ACTIVE}" -lt 0 ]]; then
    warn "       sqlite3 query failed for ${AUTOMATION_DB}"
    LEDGER_CHECK_FAILED=true
  fi
else
  if ! command -v sqlite3 &>/dev/null; then
    warn "       sqlite3 not found — cannot query ledger DB"
  else
    warn "       automation DB not found at ${AUTOMATION_DB}"
  fi
  LEDGER_CHECK_FAILED=true
fi

if [[ "${LEDGER_CHECK_FAILED}" == "true" ]]; then
  log "SKIP  cannot query automation DB — daemon may be down or starting"
  exit 0
fi

if [[ "${LEDGER_ACTIVE}" -gt 0 ]]; then
  log "SKIP  ledger has ${LEDGER_ACTIVE} active run(s) in VERIFYING/PUBLISHING/EXECUTING/CLAIMED"
  exit 0
fi
log "       ledger idle (0 active runs)"

# ── Step 4: Rate limit — skip if container StartedAt < 55 min ago ──────────

log "STEP 4  rate limit check"

if command -v docker &>/dev/null; then
  STARTED_AT=""
  STARTED_AT="$(docker inspect --format '{{.State.StartedAt}}' "${SERVICE_NAME}" 2>/dev/null)" || STARTED_AT=""
  if [[ -n "${STARTED_AT}" ]]; then
    # Docker emits nanosecond ISO timestamps; GNU date often wants ms or no fraction.
    STARTED_EPOCH=0
    STARTED_EPOCH="$(date -d "${STARTED_AT}" +%s 2>/dev/null)" || \
      STARTED_EPOCH="$(date -d "${STARTED_AT%.*}Z" +%s 2>/dev/null)" || \
      STARTED_EPOCH="$(date -d "${STARTED_AT%.*}" +%s 2>/dev/null)" || \
      STARTED_EPOCH=0
    NOW_EPOCH="$(date +%s)"
    if [[ "${STARTED_EPOCH}" -gt 0 ]]; then
      ELAPSED_MIN=$(( (NOW_EPOCH - STARTED_EPOCH) / 60 ))
      if [[ "${ELAPSED_MIN}" -lt "${RATE_LIMIT_MIN}" ]]; then
        log "SKIP  container started ${ELAPSED_MIN}m ago (< ${RATE_LIMIT_MIN}m rate limit)"
        exit 0
      fi
      log "       container started ${ELAPSED_MIN}m ago (≥ ${RATE_LIMIT_MIN}m)"
    else
      log "       could not parse StartedAt=${STARTED_AT} — proceeding"
    fi
  else
    log "       container not running or inspect failed — will deploy fresh"
  fi
else
  warn "       docker not found — cannot check rate limit, proceeding"
fi

# ── Dry-run stops before any mutation ──────────────────────────────────────

PREV_IMAGE="$(read_compose_image "${COMPOSE_FILE}" || true)"
if [[ -n "${PREV_IMAGE}" ]]; then
  log "       current image = ${PREV_IMAGE}"
else
  log "       no previous image tag found in compose file"
fi

if [[ "${DRY_RUN}" == "true" ]]; then
  log "DRY-RUN would build ${MAIN_SHA} via ${VELA_BUILD_SCRIPT}"
  log "DRY-RUN would sed compose tag → ${IMAGE_PREFIX}-<timestamp>-amd64 and up -d ${SERVICE_NAME}"
  log "DRY-RUN would verify healthy + ${HEALTH_URL} + ${EXECUTOR_SOCK}; rollback on failure"
  log "DRY-RUN would write ${MAIN_SHA} to ${LAST_BUILT_SHA_FILE} on success"
  exit 0
fi

# ── Step 5: Build and deploy ───────────────────────────────────────────────

log "STEP 5  build and deploy"

if [[ ! -x "${VELA_BUILD_SCRIPT}" ]]; then
  die "vela-build.sh not found or not executable at ${VELA_BUILD_SCRIPT}"
fi

COMPOSE_BACKUP=""
if [[ -f "${COMPOSE_FILE}" ]]; then
  COMPOSE_BACKUP="${COMPOSE_FILE}.bak.$(date +%s)"
  cp "${COMPOSE_FILE}" "${COMPOSE_BACKUP}"
  log "       backed up compose file to ${COMPOSE_BACKUP}"
else
  die "compose file not found at ${COMPOSE_FILE}"
fi

log "       running ${VELA_BUILD_SCRIPT} ${MAIN_SHA} ..."
NEW_IMAGE=""
BUILD_OUT=""
if ! BUILD_OUT="$("${VELA_BUILD_SCRIPT}" "${MAIN_SHA}" 2>&1)"; then
  echo "${BUILD_OUT}" >&2
  die "vela-build.sh failed for SHA ${MAIN_SHA}"
fi
NEW_IMAGE="$(printf '%s\n' "${BUILD_OUT}" | tail -1)"
if [[ -z "${NEW_IMAGE}" || "${NEW_IMAGE}" != openswarm:vela-* ]]; then
  die "vela-build.sh did not print an image tag (got: ${NEW_IMAGE})"
fi
log "       built image = ${NEW_IMAGE}"

if [[ -n "${PREV_IMAGE}" ]]; then
  sed -i "s|${PREV_IMAGE}|${NEW_IMAGE}|g" "${COMPOSE_FILE}"
  log "       updated compose tag: ${PREV_IMAGE} → ${NEW_IMAGE}"
else
  sed -i "s|openswarm:vela-[0-9]\{8\}-[0-9]\{4\}-amd64|${NEW_IMAGE}|g" "${COMPOSE_FILE}"
  log "       set compose tag to ${NEW_IMAGE}"
fi

log "       deploying with docker compose up -d ..."
if ! docker compose -f "${COMPOSE_FILE}" -f "${COMPOSE_STRICT}" up -d --no-deps "${SERVICE_NAME}" 2>&1; then
  warn "       deploy failed — attempting rollback"
  rollback_to "${PREV_IMAGE}" "${COMPOSE_BACKUP}" || true
  die "deploy failed, rolled back to ${PREV_IMAGE:-previous}"
fi
log "       docker compose up -d succeeded"

# ── Step 6: Verify ─────────────────────────────────────────────────────────

log "STEP 6  verify deployment"

VERIFY_FAILED=false

log "       waiting up to ${HEALTH_TIMEOUT_SEC}s for container health ..."
HEALTHY=false
for ((i=0; i<HEALTH_TIMEOUT_SEC; i+=5)); do
  if docker inspect --format '{{.State.Health.Status}}' "${SERVICE_NAME}" 2>/dev/null | grep -q healthy; then
    HEALTHY=true
    break
  fi
  # Also accept running without a healthcheck block (some host compose variants).
  status="$(docker inspect --format '{{.State.Status}}' "${SERVICE_NAME}" 2>/dev/null || true)"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${SERVICE_NAME}" 2>/dev/null || true)"
  if [[ "${status}" == "running" && "${health}" == "none" ]]; then
    HEALTHY=true
    break
  fi
  sleep 5
done

if [[ "${HEALTHY}" != "true" ]]; then
  warn "       container not healthy within ${HEALTH_TIMEOUT_SEC}s"
  VERIFY_FAILED=true
else
  log "       container healthy"
fi

if [[ "${VERIFY_FAILED}" != "true" ]]; then
  log "       checking ${HEALTH_URL} ..."
  if ! curl -sf --max-time 10 "${HEALTH_URL}" >/dev/null 2>&1; then
    warn "       /api/health endpoint not responding"
    VERIFY_FAILED=true
  else
    log "       /api/health OK"
  fi
fi

# Path cross-checked against daemon code:
#   src/sandboxExecutor/protocol.ts DEFAULT_SANDBOX_EXECUTOR_SOCKET
#   docker-compose.strict-sandbox.yml healthcheck --socket
if [[ "${VERIFY_FAILED}" != "true" ]]; then
  log "       checking executor.sock in container ..."
  if ! docker exec "${SERVICE_NAME}" test -S "${EXECUTOR_SOCK}" 2>/dev/null; then
    warn "       executor.sock not found in container"
    VERIFY_FAILED=true
  else
    log "       executor.sock OK"
  fi
fi

if [[ "${VERIFY_FAILED}" == "true" ]]; then
  warn "VERIFY FAILED — rolling back to previous image"
  rollback_to "${PREV_IMAGE}" "${COMPOSE_BACKUP}" || true
  die "rollback complete — reverted to ${PREV_IMAGE:-previous image}"
fi

echo "${MAIN_SHA}" > "${LAST_BUILT_SHA_FILE}"
log "SUCCESS deployed ${NEW_IMAGE} from SHA ${MAIN_SHA}"
log "       wrote ${MAIN_SHA} to ${LAST_BUILT_SHA_FILE}"
exit 0
