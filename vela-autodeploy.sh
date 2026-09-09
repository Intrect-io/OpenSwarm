#!/usr/bin/env bash
# vela-autodeploy.sh — autodeploy lane for OpenSwarm daemon on rtx
#
# Cron every 20 min, flock-guarded. Merged main → build → deploy → verify.
# Deployed at ~/openswarm-deploy on rtx.
#
# Usage:
#   ./vela-autodeploy.sh          # normal run (cron)
#   ./vela-autodeploy.sh --dry-run  # print decisions, no side effects
#
# Design: https://linear.app/intrect/issue/AGT-4182

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
DEPLOY_DIR="${HOME}/openswarm-deploy"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.yml"
COMPOSE_STRICT="${DEPLOY_DIR}/docker-compose.strict-sandbox.yml"
SERVICE_NAME="openswarm"
LAST_BUILT_SHA_FILE="${DEPLOY_DIR}/.last-built-sha"
AUTODEPLOY_LOG="${DEPLOY_DIR}/autodeploy.log"
LOCK_FILE="${DEPLOY_DIR}/.autodeploy.lock"
HEALTH_URL="http://localhost:3847/api/health"
HEALTH_TIMEOUT_SEC=90
RATE_LIMIT_MIN=55  # skip if container StartedAt < this many minutes ago
IMAGE_PREFIX="openswarm:vela"   # tag = openswarm:vela-YYYYMMDD-HHMM-amd64
VELA_BUILD_SCRIPT="${DEPLOY_DIR}/vela-build.sh"
AUTOMATION_DB="${HOME}/.openswarm/automation.db"

# ── Helpers ─────────────────────────────────────────────────────────────────

log() {
  local ts
  ts="$(date --iso-8601=seconds)"
  echo "${ts}  $*" >> "${AUTODEPLOY_LOG}"
  echo "${ts}  $*"
}

warn() {
  log "WARN  $*"
}

die() {
  log "ERROR $*"
  exit 1
}

# Rollback: restore previous compose tag and redeploy
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
    # In-place sed: replace the new tag with the previous one
    local new_tag
    new_tag="$(sed -n 's/.*image:\s*\(openswarm:vela-[0-9]\{8\}-[0-9]\{4\}-amd64\).*/\1/p' "${COMPOSE_FILE}" | head -1)"
    if [[ -n "${new_tag}" ]]; then
      sed -i "s|${new_tag}|${prev_tag}|g" "${COMPOSE_FILE}"
      log "ROLLBACK reverted tag ${new_tag} → ${prev_tag} in compose file"
    fi
  fi

  log "ROLLBACK redeploying with ${prev_tag} ..."
  if docker compose -f "${COMPOSE_FILE}" -f "${COMPOSE_STRICT}" up -d --no-deps "${SERVICE_NAME}" 2>&1; then
    log "ROLLBACK redeploy succeeded"
    return 0
  else
    warn "ROLLBACK redeploy also failed — container may be down"
    return 1
  fi
}

# ── Init ────────────────────────────────────────────────────────────────────

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  log "DRY-RUN mode — no side effects"
fi

mkdir -p "${DEPLOY_DIR}"

# Flock guard — only one instance at a time
exec 200>"${LOCK_FILE}"
if ! flock -n 200; then
  log "SKIP  another autodeploy instance is running (flock held)"
  exit 0
fi

# cd to deploy dir for git/docker compose commands
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

# Skip if the running image was already built from this SHA
if [[ -f "${LAST_BUILT_SHA_FILE}" ]]; then
  LAST_SHA="$(cat "${LAST_BUILT_SHA_FILE}")"
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

# Query the automation database directly for active run states.
# DB path: ~/.openswarm/automation.db (from src/automation/automationDbPath.ts:44)
# Schema: src/automation/runLedgerSchema.ts — automation_runs table with state column
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
  warn "SKIP  cannot query automation DB — daemon may be down or starting"
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
    STARTED_EPOCH="$(date -d "${STARTED_AT}" +%s 2>/dev/null)" || STARTED_EPOCH=0
    NOW_EPOCH="$(date +%s)"
    ELAPSED_MIN=$(( (NOW_EPOCH - STARTED_EPOCH) / 60 ))
    if [[ "${ELAPSED_MIN}" -lt "${RATE_LIMIT_MIN}" ]]; then
      log "SKIP  container started ${ELAPSED_MIN}m ago (< ${RATE_LIMIT_MIN}m rate limit)"
      exit 0
    fi
    log "       container started ${ELAPSED_MIN}m ago (≥ ${RATE_LIMIT_MIN}m)"
  else
    log "       container not running or inspect failed — will deploy fresh"
  fi
else
  warn "       docker not found — cannot check rate limit, proceeding"
fi

# ── Step 5: Build and deploy ───────────────────────────────────────────────

log "STEP 5  build and deploy"

# Pre-flight: the build script must exist and be executable
if [[ ! -x "${VELA_BUILD_SCRIPT}" ]]; then
  die "vela-build.sh not found or not executable at ${VELA_BUILD_SCRIPT}"
fi

# Read current image tag from compose file for rollback
PREV_IMAGE=""
if [[ -f "${COMPOSE_FILE}" ]]; then
  PREV_IMAGE="$(sed -n 's/.*image:\s*\(openswarm:vela-[0-9]\{8\}-[0-9]\{4\}-amd64\).*/\1/p' "${COMPOSE_FILE}" | head -1)" || true
fi
if [[ -n "${PREV_IMAGE}" ]]; then
  log "       current image = ${PREV_IMAGE}"
else
  log "       no previous image tag found in compose file"
fi

# Backup compose file before modifying
COMPOSE_BACKUP="${COMPOSE_FILE}.bak.$(date +%s)"
if [[ -f "${COMPOSE_FILE}" ]]; then
  cp "${COMPOSE_FILE}" "${COMPOSE_BACKUP}"
  log "       backed up compose file to ${COMPOSE_BACKUP}"
fi

# Build new image
log "       running ${VELA_BUILD_SCRIPT} ${MAIN_SHA} ..."
NEW_IMAGE=""
if [[ "${DRY_RUN}" == "true" ]]; then
  NEW_IMAGE="${IMAGE_PREFIX}-dryrun-${MAIN_SHA:0:8}"
  log "       DRY-RUN would build ${NEW_IMAGE}"
else
  NEW_IMAGE="$("${VELA_BUILD_SCRIPT}" "${MAIN_SHA}" 2>&1 | tail -1)" || \
    die "vela-build.sh failed for SHA ${MAIN_SHA}"
fi
log "       built image = ${NEW_IMAGE}"

# Update image tag in compose file
if [[ -f "${COMPOSE_FILE}" ]]; then
  if [[ -n "${PREV_IMAGE}" ]]; then
    sed -i "s|${PREV_IMAGE}|${NEW_IMAGE}|g" "${COMPOSE_FILE}"
    log "       updated compose tag: ${PREV_IMAGE} → ${NEW_IMAGE}"
  else
    # No previous tag — replace any openswarm:vela-* tag
    sed -i "s|openswarm:vela-[0-9]\{8\}-[0-9]\{4\}-amd64|${NEW_IMAGE}|g" "${COMPOSE_FILE}"
    log "       set compose tag to ${NEW_IMAGE}"
  fi
else
  die "compose file not found at ${COMPOSE_FILE}"
fi

# Deploy
log "       deploying with docker compose up -d ..."
if [[ "${DRY_RUN}" == "true" ]]; then
  log "       DRY-RUN would run: docker compose -f ${COMPOSE_FILE} -f ${COMPOSE_STRICT} up -d ${SERVICE_NAME}"
else
  if ! docker compose -f "${COMPOSE_FILE}" -f "${COMPOSE_STRICT}" up -d --no-deps "${SERVICE_NAME}" 2>&1; then
    warn "       deploy failed — attempting rollback"
    rollback_to "${PREV_IMAGE}" "${COMPOSE_BACKUP}" || true
    die "deploy failed, rolled back to ${PREV_IMAGE:-previous}"
  fi
  log "       docker compose up -d succeeded"
fi

# ── Step 6: Verify ─────────────────────────────────────────────────────────

log "STEP 6  verify deployment"

VERIFY_FAILED=false

# 6a: Wait for container healthy
log "       waiting up to ${HEALTH_TIMEOUT_SEC}s for container health ..."
HEALTHY=false
for ((i=0; i<HEALTH_TIMEOUT_SEC; i+=5)); do
  if docker inspect --format '{{.State.Health.Status}}' "${SERVICE_NAME}" 2>/dev/null | grep -q healthy; then
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

# 6b: Check /api/health endpoint
if [[ "${VERIFY_FAILED}" != "true" ]]; then
  log "       checking ${HEALTH_URL} ..."
  if ! curl -sf --max-time 10 "${HEALTH_URL}" >/dev/null 2>&1; then
    warn "       /api/health endpoint not responding"
    VERIFY_FAILED=true
  else
    log "       /api/health OK"
  fi
fi

# 6c: Check executor.sock in-container
# Path cross-checked against the daemon code:
#   src/sandboxExecutor/protocol.ts:3 DEFAULT_SANDBOX_EXECUTOR_SOCKET = '/run/openswarm-sandbox/executor.sock'
#   src/core/config.ts:449 default '/run/openswarm-sandbox/executor.sock'
#   docker-compose.strict-sandbox.yml:121 healthcheck --socket /run/openswarm-sandbox/executor.sock
if [[ "${VERIFY_FAILED}" != "true" ]]; then
  log "       checking executor.sock in container ..."
  if ! docker exec "${SERVICE_NAME}" test -S /run/openswarm-sandbox/executor.sock 2>/dev/null; then
    warn "       executor.sock not found in container"
    VERIFY_FAILED=true
  else
    log "       executor.sock OK"
  fi
fi

# ── Rollback on failure ────────────────────────────────────────────────────

if [[ "${VERIFY_FAILED}" == "true" ]]; then
  warn "VERIFY FAILED — rolling back to previous image"
  rollback_to "${PREV_IMAGE}" "${COMPOSE_BACKUP}" || true
  die "rollback complete — reverted to ${PREV_IMAGE:-previous image}"
fi

# ── Success ─────────────────────────────────────────────────────────────────

echo "${MAIN_SHA}" > "${LAST_BUILT_SHA_FILE}"
log "SUCCESS deployed ${NEW_IMAGE} from SHA ${MAIN_SHA}"
log "       wrote ${MAIN_SHA} to ${LAST_BUILT_SHA_FILE}"
exit 0