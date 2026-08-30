// ============================================
// OpenSwarm - Web Interface
// ============================================

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, watchFile, unwatchFile, type Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve as resolvePath, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { atomicWriteFileSync } from './atomicFile.js';
import { safeConsole as console } from './safeLog.js';
import { execFile } from 'node:child_process';
import { getChatHistory } from '../discord/index.js';
import { addSSEClient, getActiveSSECount, broadcastEvent, getLogBuffer, getStageBuffer, getChatBuffer } from '../core/eventHub.js';
import { formatCost } from './costTracker.js';
import { getRateLimiterMetrics } from './rateLimiter.js';
import { scanLocalProjects, invalidateProjectCache } from './projectMapper.js';
import type { AutonomousRunner } from '../automation/autonomousRunner.js';
import { buildDashboardHtml } from './dashboardHtml.js';
import { getGraph, toProjectSlug, getProjectHealth, scanAndCache, listGraphs } from '../knowledge/index.js';
import { getProjectGitInfo, startGitStatusPoller, stopGitStatusPoller } from './gitStatus.js';
import { getActiveMonitors, registerMonitor, unregisterMonitor } from '../automation/longRunningMonitor.js';
import type { LongRunningMonitorConfig } from '../core/types.js';
import { getAllProcesses, killProcess, startHealthChecker, stopHealthChecker } from '../adapters/processRegistry.js';
import { setDefaultAdapter, isKnownAdapter, listAdapterNames } from '../adapters/index.js';
import { writeProviderOverride } from '../core/providerOverride.js';
import * as memory from '../memory/index.js';
import { PairPipeline, type PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { PipelineStage, RoleConfig } from '../core/types.js';
import { detectTailscaleIP, isLoopbackAddress, isTailscaleAddress } from './tailscaleNetwork.js';
export { detectTailscaleIP, isTailscaleAddress } from './tailscaleNetwork.js';
import { runChatCompletion, getDefaultChatModel } from './chatBackend.js';
import { handleGraphQL, isGraphQLRequest } from '../issues/graphql/server.js';
import { ISSUE_BOARD_HTML } from '../issues/issueBoardHtml.js';
import { createSubIssuesWithDependencies, getTaskSource } from '../automation/runnerExecution.js';
import { projectInfoForRepository } from '../automation/runnerState.js';
import { loadRepoMetadata } from './repoMetadata.js';
import type { SubTask } from './planner.js';
import { buildHealthPayload } from './healthEndpoint.js';
import { HttpError, readBody } from './httpBody.js';
import { tryHandleAppRoutes } from './webAppRoutes.js';

let server: ReturnType<typeof createServer> | null = null;
let runnerRef: AutonomousRunner | undefined;
let gitStatusPoller: NodeJS.Timeout | null = null;

// CORS origin allowlist — hostname-strict match (no substring/prefix pitfalls)
function isAllowedOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const { protocol, hostname } = url;
  if (protocol !== 'http:' && protocol !== 'https:') return false;

  // Exact hostname matches
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  if (hostname === 'tauri.localhost') return true;

  // Tailscale CGNAT range: 100.64.0.0/10 → first octet 100, second 64–127
  const tailscaleMatch = hostname.match(/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (tailscaleMatch) {
    const second = Number(tailscaleMatch[1]);
    if (second >= 64 && second <= 127) return true;
  }
  return false;
}

// Never leak raw Error objects (which include stack traces in many runtimes)
// or arbitrary thrown values to HTTP responses.
function safeErrorMessage(err: unknown): string {
  if (err instanceof Error && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return 'Internal error';
}

function isTrustedTailscaleRequest(req: IncomingMessage): boolean {
  return process.env.OPENSWARM_TRUST_TAILSCALE === 'true'
    && isTailscaleAddress(req.socket.remoteAddress)
    && isTrustedLocalOrigin(req);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  // Linear-time parse (no regex): 'Bearer' + one space/tab + token. A
  // backtracking /^Bearer\s+(.+)$/ is polynomial on adversarial whitespace runs.
  const prefix = header.slice(0, 7).toLowerCase();
  if (prefix !== 'bearer ' && prefix !== 'bearer\t') return null;
  return header.slice(7).trim() || null;
}

function hasValidWebToken(req: IncomingMessage): boolean {
  const configuredToken = process.env.OPENSWARM_WEB_TOKEN?.trim();
  if (!configuredToken) return false;

  const presentedToken =
    extractBearerToken(req.headers.authorization) ||
    (Array.isArray(req.headers['x-openswarm-token'])
      ? req.headers['x-openswarm-token'][0]
      : req.headers['x-openswarm-token']);
  return presentedToken === configuredToken;
}

function getEffectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

function isTrustedLocalOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;

  if (!isAllowedOrigin(origin)) return false;

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }

  if (originUrl.hostname === 'tauri.localhost') return true;

  const host = req.headers.host;
  if (!host) return false;

  let hostUrl: URL;
  try {
    hostUrl = new URL(`${originUrl.protocol}//${host}`);
  } catch {
    return false;
  }

  const sameHost = originUrl.hostname === hostUrl.hostname;
  const loopbackAlias = isLoopbackHostname(originUrl.hostname) && isLoopbackHostname(hostUrl.hostname);
  return (sameHost || loopbackAlias) && getEffectivePort(originUrl) === getEffectivePort(hostUrl);
}

function isAuthorizedMutation(req: IncomingMessage): boolean {
  if (hasValidWebToken(req)) return true;
  return (isLoopbackAddress(req.socket.remoteAddress) && isTrustedLocalOrigin(req))
    || isTrustedTailscaleRequest(req);
}

function isAuthorizedLocalRead(req: IncomingMessage): boolean {
  if (hasValidWebToken(req)) return true;
  return (isLoopbackAddress(req.socket.remoteAddress) && isTrustedLocalOrigin(req))
    || isTrustedTailscaleRequest(req);
}

function isMutatingApiRequest(pathname: string, method: string | undefined): boolean {
  return pathname.startsWith('/api/') && ['DELETE', 'PATCH', 'POST', 'PUT'].includes(method ?? '');
}

function isMutatingGraphQLRequest(requestUrl: URL, method: string | undefined): boolean {
  if (!isGraphQLRequest(requestUrl.pathname)) return false;
  if (['DELETE', 'PATCH', 'POST', 'PUT'].includes(method ?? '')) return true;
  if (method !== 'GET') return false;

  const query = requestUrl.searchParams.get('query') ?? '';
  return query.includes('mutation');
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Exec task store (in-memory)

interface ExecTaskEntry {
  taskId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  currentStage?: string;
  result?: {
    success: boolean;
    summary?: string;
    finalStatus?: string;
  };
  error?: string;
  createdAt: number;
}

const execTasks = new Map<string, ExecTaskEntry>();

function cleanupExecTask(taskId: string): void {
  setTimeout(() => { execTasks.delete(taskId); }, 3600000); // 1 hour
}

/**
 * Create an in-memory exec task and run it through PairPipeline asynchronously.
 * Shared by `POST /api/exec` and the `/api/plan/dispatch` fallback (Path B) so a
 * fix to the exec lifecycle applies to both. Returns the taskId immediately;
 * status is pollable via GET /api/exec/:taskId.
 */
function startExecTask(
  prompt: string,
  opts: { projectPath?: string; pipeline?: boolean; workerOnly?: boolean; model?: string } = {},
): string {
  const taskId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const resolvedPath = opts.projectPath ?? process.cwd();

  const entry: ExecTaskEntry = { taskId, status: 'queued', createdAt: Date.now() };
  execTasks.set(taskId, entry);

  // Run pipeline asynchronously
  (async () => {
    try {
      entry.status = 'running';

      let stages: PipelineStage[];
      if (opts.workerOnly) {
        stages = ['worker'];
      } else if (opts.pipeline) {
        stages = ['worker', 'reviewer', 'tester', 'documenter'];
      } else {
        stages = ['worker', 'reviewer'];
      }

      const roles: Record<string, RoleConfig> = {};
      if (opts.model) {
        roles.worker = { enabled: true, model: opts.model, timeoutMs: 0 };
      }

      const task: TaskItem = {
        id: taskId,
        source: 'local',
        title: prompt,
        description: prompt,
        priority: 3,
        projectPath: resolvedPath,
        createdAt: Date.now(),
      };

      const pipelineInstance = new PairPipeline({
        stages,
        maxIterations: 3,
        roles: Object.keys(roles).length > 0 ? roles as any : undefined,
      });

      pipelineInstance.on('stage:start', ({ stage }: { stage: string }) => {
        entry.currentStage = stage;
      });

      const result: PipelineResult = await pipelineInstance.run(task, resolvedPath);

      entry.status = 'completed';
      entry.result = {
        success: result.success,
        summary: result.workerResult?.summary,
        finalStatus: result.finalStatus,
      };
    } catch (err) {
      entry.status = 'failed';
      entry.error = err instanceof Error ? err.message : String(err);
    } finally {
      cleanupExecTask(taskId);
    }
  })();

  return taskId;
}

// Pinned + enabled repos persistence
const REPOS_FILE = join(homedir(), '.claude', 'openswarm-repos.json');

interface ReposConfig {
  pinned: string[];             // user-added repos (shown in dashboard)
  enabled: string[];            // explicitly enabled for agent work
  basePaths: string[];          // custom scan base paths (added via dashboard)
  removedConfigPaths?: string[]; // config 경로 중 대시보드에서 제거한 항목
}

function loadReposConfig(): ReposConfig {
  try {
    if (existsSync(REPOS_FILE)) {
      return JSON.parse(readFileSync(REPOS_FILE, 'utf-8')) as ReposConfig;
    }
  } catch (err) {
    console.warn(`[Web] repos config 로드 실패:`, err instanceof Error ? err.message : err);
  }
  return { pinned: [], enabled: [], basePaths: [], removedConfigPaths: [] };
}

/**
 * Persist the repos config.
 *
 * Atomic (write-temp + fsync + rename) because this file has three concurrent
 * participants: this process, `openswarm add/remove` via projectHandler's
 * saveRepos(), and startReposWatcher() polling it every 3s. A plain in-place
 * write leaves a window where the poller reads a half-written file;
 * loadReposConfig()'s catch then returns an empty config, and applyReposConfig
 * computes an empty desired set — disabling every active project. Matches
 * projectHandler.saveRepos(), which already writes this same path atomically.
 */
function saveReposConfig(): void {
  try {
    const cfg: ReposConfig = {
      pinned:  Array.from(pinnedProjects),
      enabled: runnerRef?.getEnabledProjects() ?? [],
      basePaths: Array.from(customBasePaths),
      removedConfigPaths: Array.from(removedConfigPaths),
    };
    atomicWriteFileSync(REPOS_FILE, JSON.stringify(cfg, null, 2) + '\n', 0o600);
  } catch (e) {
    console.warn('[Web] Failed to save repos config:', e);
  }
}

const _reposCfg = loadReposConfig();
const pinnedProjects = new Set<string>(_reposCfg.pinned);
const customBasePaths = new Set<string>(_reposCfg.basePaths ?? []);
const removedConfigPaths = new Set<string>(_reposCfg.removedConfigPaths ?? []);

function syncSet(set: Set<string>, values: string[]): void {
  set.clear();
  for (const v of values) set.add(v);
}

/**
 * INT-2799: the removedConfigPaths denylist is matched by raw string equality in
 * applyReposConfig, but the same repo reaches it in two forms — config.yaml's
 * allowedProjects load raw (tilde `~/dev/x`; config.ts:expandPath is NOT applied
 * there), while repos.json.enabled and dashboard toggle paths are absolute. A
 * single-format entry misses the other form, so a config-defined project slips the
 * filter and revives on restart. Return both variants so add (disable) and delete
 * (enable/pin) cover every form — this also fixes the re-enable trap where only the
 * absolute form was cleared and the lingering tilde form kept the repo denied.
 */
function pathDenylistVariants(p: string): string[] {
  const home = homedir();
  const variants = new Set<string>([p]);
  if (p.startsWith('~')) variants.add(home + p.slice(1));
  if (p.startsWith(home + '/')) variants.add('~' + p.slice(home.length));
  return [...variants];
}

/**
 * Re-read ~/.claude/openswarm-repos.json and apply it to the in-memory registry
 * + runner. The file is the source of truth: the in-memory pinned/basePaths/
 * denylist Sets are refilled in place (endpoints close over those refs), and the
 * runner's enabled set is reconciled to file.enabled minus the denylist. Called
 * at startup and by the file watcher, so a CLI `add`/`remove` (or a hand edit)
 * reflects in the dashboard without a daemon restart.
 */
export function applyReposConfig(runner: AutonomousRunner, cfg: ReposConfig = loadReposConfig()): void {
  syncSet(pinnedProjects, cfg.pinned ?? []);
  syncSet(customBasePaths, cfg.basePaths ?? []);
  // INT-1810 R6: removedConfigPaths is a HARD denylist — a removed/isolated repo
  // never returns, even if it lingers in the persisted enabled list.
  syncSet(removedConfigPaths, cfg.removedConfigPaths ?? []);

  // Reconcile the runner's enabled set to the file (authoritative): enable every
  // file-enabled, non-denylisted repo; disable anything no longer listed. enabled
  // is only ever set from here or the dashboard toggle, so this can't fight the
  // autonomous loop.
  const enabledNow = (cfg.enabled ?? []).filter((p) => !removedConfigPaths.has(p));
  const desired = new Set(enabledNow);
  for (const path of desired) runner.enableProject(path);
  for (const path of runner.getEnabledProjects()) {
    if (!desired.has(path)) runner.disableProject(path);
  }

  // INT-1877: an enabled repo must also be ALLOWED — otherwise the DecisionEngine
  // allowedProjects filter drops it. Merge enabled into allowedProjects, strip the
  // denylist.
  const current = runner.getAllowedProjects();
  const merged = [...new Set([...current, ...enabledNow])].filter((p) => !removedConfigPaths.has(p));
  if (merged.length !== current.length || merged.some((p) => !current.includes(p))) {
    runner.updateAllowedProjects(merged);
  }

  // Pre-seed name→path cache so tasks without execution history are still matched.
  for (const path of new Set([...pinnedProjects, ...enabledNow])) {
    const name = path.split('/').pop();
    if (name) runner.registerProjectPath(name, path);
  }
}

let reposWatcherStarted = false;
let reposWatcherListener: ((curr: Stats, prev: Stats) => void) | null = null;
/**
 * Poll the repo registry file and reload when it changes, so external writers
 * (CLI `openswarm add`/`remove`, hand edits) show up in the dashboard within a
 * few seconds — no restart. Dashboard writes (saveReposConfig) also trip this,
 * but reload is a no-op when memory already matches the file. applyReposConfig
 * never writes, so there is no feedback loop.
 */
function startReposWatcher(): void {
  if (reposWatcherStarted) return;
  reposWatcherStarted = true;
  reposWatcherListener = (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    const runner = runnerRef;
    if (!runner) return;
    console.log('[Web] repos config changed on disk — reloading project registry');
    try {
      applyReposConfig(runner);
    } catch (e) {
      console.warn('[Web] repos reload failed:', e instanceof Error ? e.message : e);
    }
  };
  watchFile(REPOS_FILE, { interval: 3000 }, reposWatcherListener);
}

export function stopReposWatcher(): void {
  if (reposWatcherListener) {
    unwatchFile(REPOS_FILE, reposWatcherListener);
    reposWatcherListener = null;
  }
  reposWatcherStarted = false;
}

/**
 * Set runner reference (call after autonomous runner is initialized).
 * Pass `undefined` to detach (tests / early boot without autonomous mode).
 */
/** Actual bound port — for tests that start the server on an ephemeral port (0). */
export function getWebServerPort(): number | null {
  const address = server?.address();
  return address && typeof address === 'object' ? address.port : null;
}
export function setWebRunner(runner: AutonomousRunner | undefined): void {
  runnerRef = runner;
  if (!runner) return;
  applyReposConfig(runner);
  startReposWatcher();
}

// Read POST body helper
// Start web server
export async function startWebServer(port: number = 3847): Promise<void> {
  if (server) {
    console.log('Web interface already running, skipping...');
    return;
  }

  if (runnerRef) startReposWatcher();

  return new Promise((resolve, reject) => {
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
      const requestUrl = new URL(req.url ?? '/', 'http://localhost');
      const url = requestUrl.pathname;

      // CORS: allow localhost, Tauri webview, and Tailscale network
      const origin = req.headers.origin;
      if (origin && isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-OpenSwarm-Token');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      // Health stays ahead of both auth gates: no secrets ("diagnostics, not
      // authentication"), and the desktop shell polls it token-less. (INT-3388)
      if (url === '/api/health' && req.method === 'GET') { writeJson(res, 200, buildHealthPayload()); return; }
      if ((isMutatingApiRequest(url, req.method) || isMutatingGraphQLRequest(requestUrl, req.method)) && !isAuthorizedMutation(req)) {
        writeJson(res, 403, { error: 'Forbidden' });
        return;
      }
      if (req.method === 'GET' && (url.startsWith('/api/') || isGraphQLRequest(url)) && !isAuthorizedLocalRead(req)) {
        writeJson(res, 403, { error: 'Forbidden' });
        return;
      }

      // ---- GraphQL API (이슈 트래커) ----
      if (isGraphQLRequest(req.url)) {
        await handleGraphQL(req, res);

      // ---- Issue Board ----
      } else if (url === '/issues') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(ISSUE_BOARD_HTML);

      // ---- Dashboard ----
      } else if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // Build buttons from the live registry so the toggle never drifts from
        // isKnownAdapter validation (INT-1901 / INT-3284).
        res.end(buildDashboardHtml(listAdapterNames()));

      // ---- Desktop-app routes (/app, /static/*, /api/work*) → webAppRoutes.ts (INT-3388) ----
      } else if (await tryHandleAppRoutes(req, res, url, requestUrl, runnerRef, readBody)) {
        // handled

      // ---- SSE stream ----
      } else if (url === '/api/events') {
        const skipReplay = req.url?.includes('skipReplay=1') ?? false;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.write(':connected\n\n');
        addSSEClient(res, skipReplay);

      // ---- Stats ----
      } else if (url === '/api/stats') {
        const stats = runnerRef?.getStats();
        const state = runnerRef?.getState();
        const adapters = await runnerRef?.getAdapterSummary();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          runningTasks: stats?.schedulerStats?.running ?? 0,
          queuedTasks: stats?.schedulerStats?.queued ?? 0,
          completedToday: stats?.schedulerStats?.completed ?? 0,
          uptime: state?.startedAt ? Date.now() - state.startedAt : 0,
          isRunning: stats?.isRunning ?? false,
          sseClients: getActiveSSECount(),
          adapters,
          dailyPace: stats?.dailyPace ?? null,
          failureCauses: { window: 50, counts: runnerRef?.getFailureCauseSummary(50) ?? {} },
          throughput: stats?.schedulerStats?.throughput ?? null,
          // Scoped to the projects dispatch can act on; rows from disabled or
          // pre-containerisation projects surface as outOfScope instead of
          // inflating byState. Previously computed but returned by no endpoint,
          // so the misleading raw totals were what operators actually queried
          // by hand. (AGT-4127, tier-2 review C2)
          automationLedger: stats?.automationLedger ?? null,
        }));

      // ---- Tasks ----
      } else if (url === '/api/tasks') {
        const running = runnerRef?.getRunningTasks() ?? [];
        const queued  = runnerRef?.getQueuedTasks() ?? [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ running, queued }));

      // ---- Pipeline GET (detailed pipeline stages) ----
      } else if (url === '/api/pipeline') {
        const stages = getStageBuffer();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ stages }));

      // ---- Rate Limiter Metrics GET ----
      } else if (url === '/api/rate-limits') {
        const metrics = getRateLimiterMetrics();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(metrics));

      // ---- Projects GET (pinned + active projects) ----
      } else if (url === '/api/projects' && req.method === 'GET') {
        const enabledPaths = new Set(runnerRef?.getEnabledProjects() ?? []);
        const taskInfo = runnerRef?.getProjectsInfo() ?? [];
        // Start with pinned projects
        const allPaths = new Set(pinnedProjects);
        // Auto-include enabled projects and projects with active tasks
        for (const path of enabledPaths) allPaths.add(path);
        for (const info of taskInfo) {
          if (info.path && (info.running.length > 0 || info.queued.length > 0)) {
            allPaths.add(info.path);
          }
        }

        const result = await Promise.all(Array.from(allPaths).map(async p => {
          const dirName = p.split('/').pop() ?? p;
          // A fetched project has no path until a task runs. Join it to the
          // pinned repository by the stable project id from openswarm.json so
          // a quiet repo does not show zero issues merely because its Linear
          // name differs in case from the directory (CGF-Portal/cgf-portal).
          const metadata = await loadRepoMetadata(p).catch(() => null);
          const info = projectInfoForRepository(taskInfo, {
            path: p,
            directoryName: dirName,
            linearProjectId: metadata?.linear?.projectId,
            linearProjectName: metadata?.linear?.projectName,
          });
          const gitInfo = await getProjectGitInfo(p);
          return {
            path: p,
            name: dirName,
            linearProject: info?.name,
            enabled: enabledPaths.has(p),
            pinned: pinnedProjects.has(p),
            running: info?.running ?? [],
            queued:  info?.queued  ?? [],
            pending: info?.pending ?? [],
            git: gitInfo.git,
            prs: gitInfo.prs,
          };
        }));

        result.sort((a, b) => {
          const aActive = a.running.length + a.queued.length + a.pending.length;
          const bActive = b.running.length + b.queued.length + b.pending.length;
          if (aActive !== bActive) return bActive - aActive;
          return a.name.localeCompare(b.name);
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));

      // ---- Local projects for picker ----
      } else if (url === '/api/local-projects' && req.method === 'GET') {
        const configPaths = runnerRef?.getAllowedProjects() ?? [];
        const allBasePaths = [...new Set([...configPaths, ...customBasePaths])];
        try {
          const locals = await scanLocalProjects(allBasePaths);
          const SKIP = ['/node_modules/', '/.git/', '/dist/', '/build/', '/__pycache__/', '/venv/', '/.venv/'];
          const filtered = locals.filter(l => !SKIP.some(s => l.path.includes(s)));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(filtered.map(l => ({ path: l.path, name: l.name, pinned: pinnedProjects.has(l.path) }))));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: safeErrorMessage(e) }));
        }

      // ---- Pin project ----
      } else if (url === '/api/projects/pin' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const { projectPath } = JSON.parse(body) as { projectPath: string };
          if (typeof projectPath === 'string' && projectPath) {
            pinnedProjects.add(projectPath);
            // R6: an explicit pin is a deliberate re-enable — clear the denylist (both path
            // forms — INT-2799) so it isn't skipped again by setWebRunner on the next restart.
            for (const v of pathDenylistVariants(projectPath)) removedConfigPaths.delete(v);
            saveReposConfig();
            // Seed path cache so Linear project name matches immediately
            const name = projectPath.split('/').pop();
            if (name && runnerRef) runnerRef.registerProjectPath(name, projectPath);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400).end(JSON.stringify({ error: 'Invalid JSON' }));
        }

      // ---- Unpin project ----
      } else if (url === '/api/projects/unpin' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const { projectPath } = JSON.parse(body) as { projectPath: string };
          if (typeof projectPath === 'string') {
            pinnedProjects.delete(projectPath);
            // Also disable the project so it doesn't reappear via enabledPaths
            runnerRef?.disableProject(projectPath);
            saveReposConfig();
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400).end(JSON.stringify({ error: 'Invalid JSON' }));
        }

      // ---- Projects Toggle ----
      } else if (url === '/api/projects/toggle' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const { projectPath, enabled } = JSON.parse(body) as { projectPath: string; enabled: boolean };
          if (typeof projectPath === 'string' && typeof enabled === 'boolean') {
            if (enabled) {
              // R6: explicit enable clears the denylist (both path forms — INT-2799).
              for (const v of pathDenylistVariants(projectPath)) removedConfigPaths.delete(v);
              runnerRef?.enableProject(projectPath);
            } else {
              // INT-2799: a soft-disable must survive a daemon restart. disableProject
              // only clears the in-memory enabled set + project-selection file; on restart
              // reconcileRepos re-enables from repos.json.enabled and config.yaml re-allows
              // via allowedProjects, so a config-defined project (e.g. vega-agent) revives.
              // Add it to removedConfigPaths — the hard R6 denylist reconcile filters on
              // (applyReposConfig lines ~334/345) — in both tilde+absolute forms so the
              // config.yaml raw path is caught too. enable (above) clears both, symmetric.
              for (const v of pathDenylistVariants(projectPath)) removedConfigPaths.add(v);
              runnerRef?.disableProject(projectPath);
            }
            saveReposConfig();
            broadcastEvent({ type: 'project:toggled', data: { projectPath, enabled } });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }

      // ---- Move Issue to Todo ----
      } else if (url === '/api/issue/move-to-todo' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const { issueId } = JSON.parse(body) as { issueId: string };
          if (!issueId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing issueId' }));
            return;
          }

          // Import linear dynamically to avoid circular deps
          const linearModule = await import('../linear/index.js');
          await linearModule.updateIssueState(issueId, 'Todo');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (error) {
          console.error('[Web] Failed to move issue to Todo:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: safeErrorMessage(error) }));
        }

      // ---- Heartbeat (manual trigger) ----
      } else if (url === '/api/heartbeat' && req.method === 'POST') {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        // Non-blocking heartbeat
        runnerRef?.heartbeat().catch((e: Error) => console.error('[Web] Heartbeat error:', e));

      // ---- Provider toggle ----
      } else if (url === '/api/provider' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const { provider } = JSON.parse(body) as { provider: string };
          // Validate against the live adapter registry rather than a hardcoded list,
          // so the dashboard's provider buttons (incl. claude / codex-responses) never
          // drift out of sync with what's actually registered.
          if (!isKnownAdapter(provider)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Invalid provider "${provider}". Valid: ${listAdapterNames().join(', ')}` }));
            return;
          }

          setDefaultAdapter(provider);
          runnerRef?.switchProvider(provider);
          // switchProvider persists only when a runner is attached. Always write
          // here so a dashboard-only / runner-less daemon still survives restart.
          // Idempotent with switchProvider's own write. (INT-3284)
          writeProviderOverride(provider);
          broadcastEvent({
            type: 'log',
            data: { taskId: 'system', stage: 'provider', line: `Provider switched to ${provider}` },
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, provider }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }

      // ---- PR Processor Status ----
      } else if (url === '/api/pr-processor-status' && req.method === 'GET') {
        try {
          const { getPRProcessor } = await import('../core/service.js');
          const processor = getPRProcessor();
          const status = processor ? processor.getStatus() : null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(status));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: safeErrorMessage(error) }));
        }

      // ---- Trigger PR Processor ----
      } else if (url === '/api/trigger-pr-processor' && req.method === 'POST') {
        try {
          const { getPRProcessor } = await import('../core/service.js');
          const processor = getPRProcessor();
          if (!processor) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'PR Processor not initialized' }));
            return;
          }
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          // Non-blocking PR processing
          processor.processPRs().catch((e: Error) => console.error('[Web] PR Processor error:', e));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: safeErrorMessage(error) }));
        }

      // ---- CI Worker Status ----
      } else if (url === '/api/ci-worker-status' && req.method === 'GET') {
        try {
          const { getCIWorkerStatus } = await import('../automation/ciWorker.js');
          const status = getCIWorkerStatus();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(status));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: safeErrorMessage(error) }));
        }

      // ---- Stuck/Failed Issues ----
      } else if (url === '/api/stuck-issues' && req.method === 'GET') {
        try {
          const linearModule = await import('../linear/index.js');
          const result = await linearModule.getStuckIssues();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (error) {
          console.error('[Web] Failed to fetch stuck issues:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: safeErrorMessage(error) }));
        }

      // ---- Chat history ----
      } else if (url === '/api/chat/history' && req.method === 'GET') {
        const buf = getChatBuffer();
        const history = buf
          .filter((ev): ev is Extract<typeof ev, { type: 'chat:user' | 'chat:agent' }> =>
            ev.type === 'chat:user' || ev.type === 'chat:agent'
          )
          .map(ev => ({
            role: ev.type === 'chat:user' ? 'user' as const : 'agent' as const,
            text: ev.data.text,
            ts: ev.data.ts,
          }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(history.slice(-50)));

      // ---- Log buffer snapshot ----
      } else if (url === '/api/logs' && req.method === 'GET') {
        // 성능 최적화: 최근 200개 로그만 반환 (응답 시간 단축)
        const allLogs = getLogBuffer();
        const recentLogs = allLogs.slice(-200);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(recentLogs));

      // ---- Stage buffer snapshot ----
      } else if (url === '/api/stages' && req.method === 'GET') {
        // 성능 최적화: 최근 100개 스테이지만 반환 (응답 시간 단축)
        const allStages = getStageBuffer();
        const recentStages = allStages.slice(-100);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(recentStages));

      // ---- Chat message ----
      } else if (url === '/api/chat' && req.method === 'POST') {
        const body = await readBody(req);
        let message: string;
        try {
          message = (JSON.parse(body) as { message: string }).message?.trim();
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }
        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Empty message' }));
          return;
        }

        broadcastEvent({ type: 'chat:user', data: { text: message, ts: Date.now() } });

        // Build context-aware prompt (including previous conversation)
        const stats    = runnerRef?.getStats();
        const projects = runnerRef?.getProjectsInfo() ?? [];
        const enabled  = projects.filter(p => p.enabled).length;
        const state    = runnerRef?.getState();
        const uptimeSec = state?.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;

        // 1. Short-term memory: recent chat buffer
        const chatBuf = getChatBuffer()
          .filter((ev): ev is Extract<typeof ev, { type: 'chat:user' | 'chat:agent' }> =>
            ev.type === 'chat:user' || ev.type === 'chat:agent'
          );
        const recentHistory = chatBuf.slice(-11, -1);
        const historyBlock = recentHistory.length > 0
          ? recentHistory.map(m => (m.type === 'chat:user' ? 'User' : 'OpenSwarm') + ': ' + m.data.text).join('\n\n')
          : '';

        // 2. Long-term memory: semantic search (shared with Discord)
        const memories = await memory.searchMemory(message, {
          types: ['journal'],
          repo: 'chat',  // Shared repo for both Discord and Dashboard
          limit: 5,
          minSimilarity: 0.4,
          minTrust: 0.5,
        });
        const memoryContext = memories.length > 0
          ? '## Relevant Past Discussions\n' + memories.map(m => `- ${m.content.replace(/^Q: |^A: /g, '')}`).join('\n')
          : '';

        const adapterSummary = await runnerRef?.getAdapterSummary();
        const provider = adapterSummary?.defaultAdapter ?? 'codex';
        const model = adapterSummary?.worker?.model ?? getDefaultChatModel(provider);

        const contextPrompt = [
          'You are OpenSwarm, an autonomous code development supervisor.',
          'You manage a fleet of coding agents that autonomously work on Linear issues.',
          `Current chat provider: ${provider}`,
          `Current chat model: ${model}`,
          '',
          'Current system status:',
          '- Running tasks: ' + (stats?.schedulerStats?.running ?? 0),
          '- Queued tasks: '  + (stats?.schedulerStats?.queued ?? 0),
          '- Completed today: '+ (stats?.schedulerStats?.completed ?? 0),
          '- Active repos: '  + enabled + '/' + projects.length,
          '- Uptime: '        + uptimeSec + 's',
          '',
          ...(historyBlock ? [
            'Conversation history (most recent first):',
            historyBlock,
            '',
          ] : []),
          ...(memoryContext ? [memoryContext, ''] : []),
          'Answer the user concisely and helpfully in the same language they use. Use the status data above if relevant.',
          '',
          'User: ' + message,
        ].join('\n');

        const result = await runChatCompletion({
          prompt: contextPrompt,
          provider,
          model,
          cwd: process.cwd(),
          timeoutMs: 300000,
        }).catch((error: Error) => ({
          response: `[Error: ${error.message}]`,
          provider,
          model,
          cost: undefined,
          tokens: undefined,
        }));
        const response = result.response;

        if (result.cost !== undefined) {
          console.log(`[Web Chat] Cost: ${formatCost({
            costUsd: result.cost,
            inputTokens: result.tokens ?? 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            durationMs: 0,
            model: result.model,
          })}`);
        }

        broadcastEvent({ type: 'chat:agent', data: { text: response, ts: Date.now() } });

        // 3. Save conversation to long-term memory
        await memory.saveConversation(
          'dashboard',      // channelId (fixed for dashboard)
          'dashboard-user', // userId
          'User',           // userName
          message,
          response
        );
        console.log(`[Dashboard Chat] Saved to memory (${message.length} + ${response.length} chars)`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, response, provider: result.provider, model: result.model }));

      // ---- Service control: status ----
      } else if (url === '/api/service/status' && req.method === 'GET') {
        try {
          const result = await new Promise<string>((resolve) => {
            execFile('systemctl', ['--user', 'is-active', 'openswarm'], (_err, stdout) => {
              resolve(stdout.trim());
            });
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: result }));
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'unknown' }));
        }

      // ---- Service control: stop ----
      } else if (url === '/api/service/stop' && req.method === 'POST') {
        try {
          await new Promise<void>((resolve, reject) => {
            execFile('systemctl', ['--user', 'stop', 'openswarm'], (err) => {
              if (err) reject(err); else resolve();
            });
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: safeErrorMessage(e) }));
        }

      // ---- Service control: restart ----
      } else if (url === '/api/service/restart' && req.method === 'POST') {
        try {
          await new Promise<void>((resolve, reject) => {
            execFile('systemctl', ['--user', 'restart', 'openswarm'], (err) => {
              if (err) reject(err); else resolve();
            });
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: safeErrorMessage(e) }));
        }

      // ---- Knowledge Graph: project health ----
      } else if (url.startsWith('/api/knowledge/') && req.method === 'GET') {
        const projectSlug = url.replace('/api/knowledge/', '').split('?')[0];
        if (!projectSlug) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing project slug' }));
        } else {
          try {
            const graph = await getGraph(projectSlug);
            if (!graph) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Graph not found. Run a scan first.' }));
            } else {
              const health = getProjectHealth(graph);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                slug: projectSlug,
                scannedAt: graph.scannedAt,
                nodeCount: graph.nodeCount,
                edgeCount: graph.edgeCount,
                ...health,
              }));
            }
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: safeErrorMessage(e) }));
          }
        }

      // ---- Knowledge Graph: list all ----
      } else if (url === '/api/knowledge' && req.method === 'GET') {
        try {
          const slugs = await listGraphs();
          const result = [];
          for (const slug of slugs) {
            const graph = await getGraph(slug);
            if (graph) {
              result.push({
                slug,
                nodeCount: graph.nodeCount,
                edgeCount: graph.edgeCount,
                scannedAt: graph.scannedAt,
                summary: graph.buildSummary(),
              });
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: safeErrorMessage(e) }));
        }

      // ---- Knowledge Graph: trigger scan ----
      } else if (url === '/api/knowledge/scan' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const { projectPath } = JSON.parse(body) as { projectPath: string };
          if (!projectPath) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing projectPath' }));
          } else {
            const resolvedPath = projectPath.replace('~', homedir());
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, slug: toProjectSlug(resolvedPath) }));
            // Non-blocking scan
            scanAndCache(resolvedPath, { force: true }).catch(e =>
              console.error('[Web] Knowledge scan error:', e)
            );
          }
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }

      // ---- Pipeline history (time-ordered) ----
      } else if (url === '/api/pipeline/history' && req.method === 'GET') {
        const limitParam = (req.url?.split('?')[1] || '').match(/limit=(\d+)/);
        const limit = limitParam ? Math.min(Number(limitParam[1]), 100) : 50;
        const history = runnerRef?.getPipelineHistory(limit) ?? [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(history));

      // ---- Monitors: list ----
      } else if (url === '/api/monitors' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getActiveMonitors()));

      // ---- Monitors: register ----
      } else if (url === '/api/monitors' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const config = JSON.parse(body) as LongRunningMonitorConfig;
          if (
            !config.id ||
            !config.name ||
            !Array.isArray(config.checkCommand) ||
            config.checkCommand.length === 0 ||
            !config.completionCheck
          ) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'Missing or invalid required fields: id, name, checkCommand (string[]), completionCheck',
            }));
            return;
          }
          const monitor = registerMonitor(config);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(monitor));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: safeErrorMessage(e) }));
        }

      // ---- Monitors: delete ----
      } else if (url.startsWith('/api/monitors/') && req.method === 'DELETE') {
        const monitorId = url.replace('/api/monitors/', '');
        const deleted = unregisterMonitor(monitorId);
        res.writeHead(deleted ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: deleted }));

      // ---- Processes: list ----
      } else if (url === '/api/processes' && req.method === 'GET') {
        // Spawned CLI subprocesses (PID-tracked) + in-process pipeline tasks. Native
        // adapters (codex-responses/openrouter/local) run the worker/reviewer in-process
        // with no child PID, so without the pipeline entries the panel looks empty even
        // while tasks are actively running.
        const subprocs = getAllProcesses().map((p) => ({ ...p, kind: 'subprocess', id: String(p.pid) }));
        const pipelines = (runnerRef?.getRunningPipelines() ?? []).map((t) => ({
          kind: 'pipeline',
          id: t.id,
          pid: null,
          taskId: t.issue ?? t.title,
          project: t.project,
          stage: t.stage ?? 'running',
          projectPath: t.projectPath,
          spawnedAt: t.startedAt,
          lastActivityAt: t.startedAt,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([...pipelines, ...subprocs]));

      // ---- Processes: kill (PID) or cancel (pipeline task id) ----
      } else if (url.startsWith('/api/processes/') && req.method === 'DELETE') {
        const idStr = decodeURIComponent(url.replace('/api/processes/', ''));
        const pid = parseInt(idStr, 10);
        if (!isNaN(pid) && String(pid) === idStr) {
          const killed = await killProcess(pid);
          res.writeHead(killed ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: killed }));
        } else {
          // Non-numeric id → in-process pipeline task: abort it (and its adapter call).
          const cancelled = runnerRef?.cancelTask(idStr) ?? false;
          res.writeHead(cancelled ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: cancelled }));
        }

      // ---- Scan Paths: list ----
      } else if (url === '/api/scan-paths' && req.method === 'GET') {
        // removedConfigPaths에 있는 경로는 UI에 표시하지 않음
        const allConfigPaths = runnerRef?.getAllowedProjects() ?? [];
        const configPaths = allConfigPaths.filter(p => !removedConfigPaths.has(p));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          configPaths,
          customPaths: Array.from(customBasePaths),
        }));

      // ---- Scan Paths: add ----
      } else if (url === '/api/scan-paths' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const { path: newPath } = JSON.parse(body) as { path: string };
          if (typeof newPath !== 'string' || !newPath.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing path' }));
          } else {
            customBasePaths.add(newPath.trim());
            invalidateProjectCache();
            // Update runner's allowedProjects with merged list
            const configPaths = runnerRef?.getAllowedProjects() ?? [];
            const merged = [...new Set([...configPaths, ...customBasePaths])];
            runnerRef?.updateAllowedProjects(merged);
            saveReposConfig();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          }
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }

      // ---- Scan Paths: remove ----
      } else if (url.startsWith('/api/scan-paths/') && req.method === 'DELETE') {
        const encodedPath = url.replace('/api/scan-paths/', '');
        const decodedPath = decodeURIComponent(encodedPath);
        // customPaths에서 제거
        customBasePaths.delete(decodedPath);
        // configPaths에서도 제거: removedConfigPaths에 기록하고 runner에서 즉시 반영
        const allConfigPaths = runnerRef?.getAllowedProjects() ?? [];
        if (allConfigPaths.includes(decodedPath)) {
          removedConfigPaths.add(decodedPath);
          runnerRef?.updateAllowedProjects(allConfigPaths.filter(p => p !== decodedPath));
        }
        invalidateProjectCache();
        saveReposConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

      // ---- Filesystem browse (folder picker) ----
      // GET /api/fs/list?path=<absolute or ~/...>
      // Returns: { path, parent, entries: [{name, isDir}] } — dotfiles excluded, dirs first.
      } else if (url.startsWith('/api/fs/list') && req.method === 'GET') {
        if (!isAuthorizedLocalRead(req)) {
          writeJson(res, 403, { error: 'Forbidden' });
          return;
        }

        try {
          const requested = requestUrl.searchParams.get('path')?.trim();
          const startPath = requested && requested.length > 0
            ? requested
            : homedir();
          const expanded = startPath.startsWith('~')
            ? join(homedir(), startPath.slice(1))
            : startPath;
          const absolute = resolvePath(expanded);

          const st = await stat(absolute);
          if (!st.isDirectory()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not a directory', path: absolute }));
            return;
          }

          const raw = await readdir(absolute, { withFileTypes: true });
          const entries = raw
            .filter((d) => !d.name.startsWith('.'))
            .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
            .sort((a, b) => {
              if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
              return a.name.localeCompare(b.name);
            });

          const parent = dirname(absolute);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            path: absolute,
            parent: parent === absolute ? null : parent,
            name: basename(absolute) || absolute,
            entries,
          }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: safeErrorMessage(e) }));
        }

      // ---- Discord history (legacy) ----
      } else if (url === '/api/history') {
        const history = await getChatHistory();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(history));

      // ---- Exec: submit task ----
      } else if (url === '/api/exec' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const { prompt, projectPath, pipeline, workerOnly, model } = JSON.parse(body) as {
            prompt: string;
            projectPath?: string;
            pipeline?: boolean;
            workerOnly?: boolean;
            model?: string;
          };

          if (!prompt?.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing prompt' }));
            return;
          }

          const taskId = startExecTask(prompt, { projectPath, pipeline, workerOnly, model });

          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ taskId, status: 'queued' }));

        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }

      // ---- Plan dispatch: TUI /plan cockpit → daemon loop ----
      } else if (url === '/api/plan/dispatch' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const { goal, projectPath, subTasks } = JSON.parse(body) as {
            goal: string;
            projectPath?: string;
            subTasks?: SubTask[];
          };
          if (!goal?.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing goal' }));
            return;
          }
          const resolvedPath = projectPath ?? process.cwd();
          const tasks = Array.isArray(subTasks) ? subTasks : [];
          const triggerHeartbeat = () => {
            runnerRef?.heartbeat().catch((e: Error) => console.error('[Web] plan heartbeat error:', e));
          };

          // Path A — a task source is registered (Linear OR local SQLite): create a
          // parent issue + dependency-wired sub-issues (reusing the autonomous
          // engine, which routes through the same source), then heartbeat.
          const source = getTaskSource();
          if (source) {
            const parent = await source.createTask(
              goal,
              `Planned via the \`/plan\` cockpit.\n\n${tasks.length} sub-task(s) dispatched.`,
            );
            if ('error' in parent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Task source: ${parent.error}` }));
              return;
            }

            if (tasks.length === 0) {
              // Planner saw no decomposition — run the goal itself as one task.
              await source.updateState(parent.id, 'Todo').catch(() => {});
              triggerHeartbeat();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                mode: source.kind,
                parentIssue: { id: parent.id, identifier: parent.identifier },
                subIssues: [],
              }));
              return;
            }

            const totalMinutes = tasks.reduce((sum, t) => sum + (t.estimatedMinutes || 0), 0);
            await createSubIssuesWithDependencies(
              parent.id,
              { title: goal },
              tasks,
              totalMinutes,
              { reportToDiscord: () => {}, scheduleNextHeartbeat: triggerHeartbeat },
              parent.id,
              20,
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              mode: source.kind,
              parentIssue: { id: parent.id, identifier: parent.identifier },
            }));
            return;
          }

          // Path B (fallback) — no Linear: run each sub-task via the exec pipeline.
          const items: SubTask[] = tasks.length > 0
            ? tasks
            : [{ title: goal, description: goal, estimatedMinutes: 0, priority: 3 }];
          const taskIds = items.map((st) =>
            startExecTask(`${st.title}\n\n${st.description ?? ''}`.trim(), {
              projectPath: resolvedPath,
              pipeline: true,
            }),
          );
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ mode: 'exec', taskIds }));

        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid JSON' }));
        }

      // ---- Exec: task status ----
      } else if (url.startsWith('/api/exec/') && req.method === 'GET') {
        const taskId = url.replace('/api/exec/', '');
        const entry = execTasks.get(taskId);
        if (!entry) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Task not found' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            taskId: entry.taskId,
            status: entry.status,
            currentStage: entry.currentStage,
            result: entry.result,
            error: entry.error,
          }));
        }

      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
      } catch (err) {
        const statusCode = err instanceof HttpError ? err.statusCode : 500;
        writeJson(res, statusCode, {
          error: err instanceof HttpError ? err.message : safeErrorMessage(err),
        });
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`Port ${port} is already in use, skipping web server...`);
        server = null;
        resolve();
      } else {
        reject(err);
      }
    });

    const trustTailscale = process.env.OPENSWARM_TRUST_TAILSCALE === 'true';
    const listenHost = process.env.OPENSWARM_WEB_TOKEN?.trim() || trustTailscale ? '0.0.0.0' : '127.0.0.1';
    server.listen(port, listenHost, () => {
      const tailscaleIP = detectTailscaleIP();
      console.log(`Web interface running at:`);
      console.log(`  - http://127.0.0.1:${port} (localhost)`);
      if (listenHost === '0.0.0.0') {
        const access = trustTailscale && !process.env.OPENSWARM_WEB_TOKEN?.trim()
          ? 'Tailscale only'
          : 'token required';
        if (tailscaleIP) console.log(`  - http://${tailscaleIP}:${port} (${access})`);
        else console.log(`  - http://<this-host>:${port} (token required)`);
      }
      gitStatusPoller = startGitStatusPoller(() => Array.from(pinnedProjects));
      startHealthChecker(30000);
      resolve();
    });
  });
}

/**
 * Stop the web server
 */
export async function stopWebServer(): Promise<void> {
  if (gitStatusPoller) {
    stopGitStatusPoller();
    gitStatusPoller = null;
  }
  stopHealthChecker();
  stopReposWatcher();

  if (server) {
    const current = server;
    server = null;
    await new Promise<void>((resolve, reject) => {
      current.close((error) => {
        if (!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') resolve();
        else reject(error);
      });
    });
  }
}
