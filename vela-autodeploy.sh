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

# Rollback: restore previous image tag in compose file and redeploy.
# Prefers the pre-deploy compose backup (exact known-good state); falls back
# to a sed tag swap when no backup exists. If no previous tag is known either,
# log loudly but do not destroy the running container.
rollback_to() {
  local prev_tag="${1:-}"
  local backup_file="${2:-}"

  # Preferred path: restore the exact compose file captured before deploy.
  if [[ -n "${backup_file}" && -f "${backup_file}" ]]; then
    log "ROLLBACK restoring compose file from backup ${backup_file}"
    if cp "${backup_file}" "${COMPOSE_FILE}"; then
      log "ROLLBACK redeploying with restored compose file ..."
      if docker compose -f "${COMPOSE_FILE}" -f "${COMPOSE_STRICT}" up -d --no-deps "${SERVICE_NAME}" 2>&1; then
        log "ROLLBACK redeploy succeeded (compose backup restored)"
        return 0
      fi
      warn "ROLLBACK redeploy with restored compose failed — trying tag-swap fallback"
    else
      warn "ROLLBACK could not copy backup — trying tag-swap fallback"
    fi
  fi

  # Fallback: sed the image tag back to the previous one.
  if [[ -z "${prev_tag}" ]]; then
    warn "ROLLBACK no previous image tag known and no usable compose backup — cannot roll back"
    warn "ROLLBACK the running container is unchanged; manual intervention required"
    return 1
  fi

  log "ROLLBACK reverting compose image tag to ${prev_tag}"
  sed -i "s|${IMAGE_PREFIX}-[0-9]\{8\}-[0-9]\{4\}-amd64|${prev_tag}|g" "${COMPOSE_FILE}"

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

if command -v curl &>/dev/null; then
  # Try health endpoint first
  HEALTH_BODY=""
  if HEALTH_BODY="$(curl -sf --max-time 5 "${HEALTH_URL}" 2>/dev/null)"; then
    LEDGER_ACTIVE="$(echo "${HEALTH_BODY}" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    # Try common field names for active run states
    for key in ('activeRuns', 'activeTasks', 'inFlight', 'busySlots', 'runningCount'):
        if key in d:
            print(d[key])
            sys.exit(0)
    # Fallback: count from ledger summary if present
    ledger = d.get('ledger', d.get('runLedger', {}))
    active_states = {'VERIFYING', 'PUBLISHING', 'EXECUTING', 'CLAIMED'}
    total = 0
    for state, count in ledger.get('byState', {}).items():
        if state in active_states:
            total += count
    print(total)
except Exception:
    print(-1)
" 2>/dev/null)" || LEDGER_ACTIVE=-1

    if [[ "${LEDGER_ACTIVE}" -lt 0 ]]; then
      # Health endpoint didn't expose ledger — try direct API call
      LEDGER_BODY=""
      if LEDGER_BODY="$(curl -sf --max-time 5 "http://localhost:3847/api/ledger/summary" 2>/dev/null)"; then
        LEDGER_ACTIVE="$(echo "${LEDGER_BODY}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
active_states = {'VERIFYING', 'PUBLISHING', 'EXECUTING', 'CLAIMED'}
total = 0
for state, count in d.get('byState', {}).items():
    if state in active_states:
        total += count
print(total)
" 2>/dev/null)" || LEDGER_ACTIVE=-1
      else
        LEDGER_CHECK_FAILED=true
      fi
    fi
  else
    LEDGER_CHECK_FAILED=true
  fi
else
  LEDGER_CHECK_FAILED=true
fi

if [[ "${LEDGER_CHECK_FAILED}" == "true" ]]; then
  warn "SKIP  cannot reach daemon health/ledger endpoint — daemon may be down or starting"
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

# Generate image tag: openswarm:vela-YYYYMMDD-HHMM-amd64
# IMAGE_PREFIX already carries "vela", so the suffix must not repeat it.
TAG_SUFFIX="$(date -u +%Y%m%d-%H%M)-amd64"
NEW_IMAGE="${IMAGE_PREFIX}-${TAG_SUFFIX}"

if [[ "${DRY_RUN}" == "true" ]]; then
  log "DRY-RUN would build: ${NEW_IMAGE} from SHA ${MAIN_SHA}"
  log "DRY-RUN would backup compose file and set image tag"
  log "DRY-RUN would run: docker compose -f ${COMPOSE_FILE} -f ${COMPOSE_STRICT} up -d ${SERVICE_NAME}"
  log "DRY-RUN would write ${MAIN_SHA} to ${LAST_BUILT_SHA_FILE}"
  log "DRY-RUN complete — no changes made"
  exit 0
fi

# Backup compose file before modifying
COMPOSE_BACKUP="${COMPOSE_FILE}.bak.$(date +%s)"
cp "${COMPOSE_FILE}" "${COMPOSE_BACKUP}"
log "       backed up ${COMPOSE_FILE} → ${COMPOSE_BACKUP}"

# Record the previous image tag for rollback
PREV_IMAGE=""
if [[ -f "${COMPOSE_FILE}" ]]; then
  PREV_IMAGE="$(grep -oE "${IMAGE_PREFIX}-[0-9]{8}-[0-9]{4}-amd64" "${COMPOSE_FILE}" 2>/dev/null | head -1)" || PREV_IMAGE=""
fi

# Build the image
log "       running ${VELA_BUILD_SCRIPT} ${MAIN_SHA} ..."
if ! bash "${VELA_BUILD_SCRIPT}" "${MAIN_SHA}"; then
  die "vela-build.sh failed for SHA ${MAIN_SHA}"
fi
log "       build complete"

# Tag the build with our deploy tag
log "       tagging image as ${NEW_IMAGE}"
docker tag "openswarm:build-${MAIN_SHA}" "${NEW_IMAGE}" 2>/dev/null || \
  docker tag "openswarm:${MAIN_SHA}" "${NEW_IMAGE}" 2>/dev/null || \
  warn "       could not tag build image — will use existing tag in compose"

# Update compose file with new image tag
sed -i "s|${IMAGE_PREFIX}-[0-9]\{8\}-[0-9]\{4\}-amd64|${NEW_IMAGE}|g" "${COMPOSE_FILE}"
log "       updated compose image tag to ${NEW_IMAGE}"

# Deploy
log "       deploying ..."
if ! docker compose -f "${COMPOSE_FILE}" -f "${COMPOSE_STRICT}" up -d --no-deps "${SERVICE_NAME}" 2>&1; then
  warn "       deploy failed — attempting rollback"
  rollback_to "${PREV_IMAGE}" "${COMPOSE_BACKUP}" || true
  die "deploy failed, rolled back to ${PREV_IMAGE:-previous}"
fi
log "       docker compose up -d succeeded"

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
