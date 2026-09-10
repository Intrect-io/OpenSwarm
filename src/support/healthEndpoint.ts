// ============================================
// OpenSwarm - /api/health payload (INT-3388)
// ============================================
//
// Field names deliberately mirror the vega-agent desktop shell's
// BackendHealth contract so its polling/recovery logic ports over unchanged:
// the shell identifies "the daemon I expect" via `app` + `status`, and
// detects restarts via `backend_pid` changing between polls.
//
// The payload is served from a timer-refreshed cache (AGT-4079) so that
// the HEALTHCHECK probe never queues behind synchronous work on the event
// loop.  `buildHealthPayload` is still exported for tests and for the
// initial seed; the request handler calls `getCachedHealthPayload()`.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';

export interface HealthPayload {
  status: 'ok';
  app: 'openswarm';
  /** 'service' when supervised (launchd/systemd), 'source' for a dev checkout run. */
  backend_owner: 'service' | 'source';
  backend_version: string;
  /** Fresh per daemon boot — lets a client tell a restart from a hiccup. */
  backend_instance_id: string;
  backend_pid: number;
  backend_parent_pid: number | null;
  uptime_s: number;
  /**
   * V8 old-space in use, its ceiling, and process RSS — all MB.
   *
   * The daemon is single-threaded, so a heap near its ceiling means frequent
   * full mark-compact collections, and those stop the world: nothing else on
   * the loop runs for the duration. Measured on the container at 3.55 GB RSS
   * against Node's default 4144 MB ceiling, with `/api/health` latency bimodal
   * at 0.1 s and 1.0 s under 6 concurrent tasks (AGT-4079).
   */
  heap_used_mb: number;
  heap_limit_mb: number;
  rss_mb: number;
}

const MB = 1024 * 1024;

// ---- Cached payload (AGT-4079) ----
//
// The cache is seeded once and then refreshed on a 1-second timer so the
// request handler never calls process.uptime() / process.memoryUsage() /
// getHeapStatistics() synchronously on the hot path.  During a multi-second
// event-loop stall the timer *also* stalls, but the last-written snapshot
// is served instantly — the HEALTHCHECK probe reads a stale-but-truthful
// "process was alive recently" answer rather than timing out.

let cachedPayload: HealthPayload | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Build the payload from live process state.  Exported for tests and for
 * seeding the cache; production callers should use `getCachedHealthPayload()`.
 */
export function buildHealthPayload(
  deps: {
    env?: NodeJS.ProcessEnv;
    pid?: number;
    ppid?: number | null;
    uptimeS?: number;
    version?: string;
    instanceId?: string;
    memory?: { heapUsedBytes: number; heapLimitBytes: number; rssBytes: number };
  } = {},
): HealthPayload {
  const env = deps.env ?? process.env;
  const pid = deps.pid ?? process.pid;
  const ppid = deps.ppid !== undefined ? deps.ppid : (process.ppid ?? null);
  const uptimeS = deps.uptimeS ?? process.uptime();
  const version = deps.version ?? readPackageVersion();
  const instanceId = deps.instanceId ?? getInstanceId();
  return {
    status: 'ok',
    app: 'openswarm',
    backend_owner: detectBackendOwner(env),
    backend_version: version,
    backend_instance_id: instanceId,
    backend_pid: pid,
    backend_parent_pid: ppid,
    // Whole seconds: this is the shape vega's shell parses, and an exhaustive
    // test pins it. Dropping the floor turned `12` into `12.9` for every
    // consumer of the contract.
    uptime_s: Math.floor(uptimeS),
    ...memoryFields(deps.memory),
  };
}

/**
 * Return the latest cached health snapshot.  The first call seeds the cache
 * synchronously so the very first request never returns null.
 */
export function getCachedHealthPayload(): HealthPayload {
  if (cachedPayload) return cachedPayload;
  cachedPayload = buildHealthPayload();
  return cachedPayload;
}

/**
 * Start a 1-second timer that refreshes the cached health payload.
 * Idempotent: calling it twice does not start two timers.
 * Returns a stop function.
 */
export function startHealthCache(intervalMs = 1_000): () => void {
  if (refreshTimer) return () => stopHealthCache();

  // Seed immediately so the first request has data.
  cachedPayload = buildHealthPayload();

  refreshTimer = setInterval(() => {
    cachedPayload = buildHealthPayload();
  }, intervalMs);
  refreshTimer.unref();

  return () => stopHealthCache();
}

/** Stop the refresh timer.  Safe to call when not started. */
export function stopHealthCache(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// ---- helpers (unchanged) ----

function memoryFields(
  override?: { heapUsedBytes: number; heapLimitBytes: number; rssBytes: number },
): Pick<HealthPayload, 'heap_used_mb' | 'heap_limit_mb' | 'rss_mb'> {
  const heapUsedBytes = override?.heapUsedBytes ?? process.memoryUsage().heapUsed;
  const heapLimitBytes = override?.heapLimitBytes ?? getHeapStatistics().heap_size_limit;
  const rssBytes = override?.rssBytes ?? process.memoryUsage.rss();
  return {
    heap_used_mb: Math.round(heapUsedBytes / MB),
    heap_limit_mb: Math.round(heapLimitBytes / MB),
    rss_mb: Math.round(rssBytes / MB),
  };
}

// ---- instance-id / version / owner detection (unchanged) ----

let instanceId: string | undefined;

export function getInstanceId(): string {
  if (!instanceId) instanceId = randomUUID();
  return instanceId;
}

export function readPackageVersion(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(__dirname, '..', '..', 'package.json');
  try {
    const raw = readFileSync(pkgPath, 'utf-8');
    return JSON.parse(raw).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function detectBackendOwner(env: NodeJS.ProcessEnv): 'service' | 'source' {
  if (env.OPENSWARM_BACKEND_OWNER === 'service' || env.OPENSWARM_BACKEND_OWNER === 'source') {
    return env.OPENSWARM_BACKEND_OWNER;
  }
  // launchd on macOS, systemd on Linux
  if (env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== '0') return 'service';
  if (env.INVOCATION_ID) return 'service';
  return 'source';
}