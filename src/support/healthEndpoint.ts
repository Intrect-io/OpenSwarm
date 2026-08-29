// ============================================
// OpenSwarm - /api/health payload (INT-3388)
// ============================================
//
// Field names deliberately mirror the vega-agent desktop shell's
// BackendHealth contract so its polling/recovery logic ports over unchanged:
// the shell identifies "the daemon I expect" via `app` + `status`, and
// detects restarts via `backend_pid` changing between polls.

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
   * at sub-second or tens of seconds — but `used_heap_size` was not reported
   * anywhere, so the cause could only be inferred from RSS. (AGT-4063)
   *
   * Cheap enough to sit in a payload the healthcheck polls every 30s: both
   * calls are in-process reads of counters V8 already maintains, no syscall
   * and no I/O.
   */
  heap_used_mb: number;
  heap_limit_mb: number;
  rss_mb: number;
}

const MB = 1024 * 1024;

// One id per process lifetime, minted at module load (daemon boot).
const INSTANCE_ID = randomUUID();

/**
 * The daemon generation. Log sequences are process-local and restart at 1, so
 * consumers that dedupe on them must know WHICH process a number belongs to —
 * broadcastEvent stamps this alongside each line. (INT-3402)
 */
export function getInstanceId(): string {
  return INSTANCE_ID;
}

function readPackageVersion(): string {
  try {
    // healthEndpoint.js lives at <pkg>/dist/support/, so package.json is two up.
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const VERSION = readPackageVersion();

function detectBackendOwner(env: NodeJS.ProcessEnv): 'service' | 'source' {
  const explicit = env.OPENSWARM_BACKEND_OWNER;
  if (explicit === 'service' || explicit === 'source') return explicit;
  // launchd sets XPC_SERVICE_NAME for jobs it supervises; systemd sets
  // INVOCATION_ID. A plain `npm run dev` has neither.
  if (env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== '0') return 'service';
  if (env.INVOCATION_ID) return 'service';
  return 'source';
}

export function buildHealthPayload(
  deps: {
    env?: NodeJS.ProcessEnv;
    pid?: number;
    ppid?: number;
    uptimeS?: number;
    version?: string;
    instanceId?: string;
    memory?: { heapUsedBytes: number; heapLimitBytes: number; rssBytes: number };
  } = {},
): HealthPayload {
  return {
    status: 'ok',
    app: 'openswarm',
    backend_owner: detectBackendOwner(deps.env ?? process.env),
    backend_version: deps.version ?? VERSION,
    backend_instance_id: deps.instanceId ?? INSTANCE_ID,
    backend_pid: deps.pid ?? process.pid,
    backend_parent_pid: deps.ppid ?? process.ppid ?? null,
    uptime_s: Math.floor(deps.uptimeS ?? process.uptime()),
    ...memoryFields(deps.memory),
  };
}

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
