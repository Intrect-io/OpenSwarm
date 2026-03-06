// ============================================
// OpenSwarm - Web Interface
// ============================================

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { getChatHistory } from '../discord/index.js';
import { addSSEClient, getActiveSSECount, broadcastEvent, getLogBuffer, getStageBuffer, getChatBuffer } from '../core/eventHub.js';
import { extractCostFromStreamJson, formatCost } from './costTracker.js';
import { getRateLimiterMetrics } from './rateLimiter.js';
import { scanLocalProjects, invalidateProjectCache } from './projectMapper.js';
import type { AutonomousRunner } from '../automation/autonomousRunner.js';
import { DASHBOARD_HTML } from './dashboardHtml.js';
import { getGraph, toProjectSlug, getProjectHealth, scanAndCache, listGraphs } from '../knowledge/index.js';
import { getProjectGitInfo, startGitStatusPoller } from './gitStatus.js';
import { getActiveMonitors, registerMonitor, unregisterMonitor } from '../automation/longRunningMonitor.js';
import type { LongRunningMonitorConfig } from '../core/types.js';
import { getAllProcesses, killProcess, startHealthChecker } from '../adapters/processRegistry.js';
import * as memory from '../memory/index.js';

let server: ReturnType<typeof createServer> | null = null;
let runnerRef: AutonomousRunner | undefined;

// ============================================
// Pinned + enabled repos persistence
// ============================================
const REPOS_FILE = join(homedir(), '.claude', 'openswarm-repos.json');

interface ReposConfig {
  pinned: string[];    // user-added repos (shown in dashboard)
  enabled: string[];   // explicitly enabled for agent work
  basePaths: string[]; // custom scan base paths (added via dashboard)
}

function loadReposConfig(): ReposConfig {
  try {
    if (existsSync(REPOS_FILE)) {
      return JSON.parse(readFileSync(REPOS_FILE, 'utf-8')) as ReposConfig;
    }
  } catch {}
  return { pinned: [], enabled: [], basePaths: [] };
}

function saveReposConfig(): void {
  try {
    const cfg: ReposConfig = {
      pinned:  Array.from(pinnedProjects),
      enabled: runnerRef?.getEnabledProjects() ?? [],
      basePaths: Array.from(customBasePaths),
    };
    writeFileSync(REPOS_FILE, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.warn('[Web] Failed to save repos config:', e);
  }
}

const _reposCfg = loadReposConfig();
const pinnedProjects = new Set<string>(_reposCfg.pinned);
const customBasePaths = new Set<string>(_reposCfg.basePaths ?? []);

/**
 * Set runner reference (call after autonomous runner is initialized)
 */
export function setWebRunner(runner: AutonomousRunner): void {
  runnerRef = runner;
  // Restore persisted enabled state
  for (const path of _reposCfg.enabled) {
    runner.enableProject(path);
  }
  // Pre-seed path cache from pinned + enabled projects so tasks without execution history are still matched
  const allSeeded = new Set([...pinnedProjects, ..._reposCfg.enabled]);
  for (const path of allSeeded) {
    const name = path.split('/').pop();
    if (name) runner.registerProjectPath(name, path);
  }
}

// ============================================
// Read POST body helper
// ============================================
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
  });
}

// ============================================
// Start web server
// ============================================
export async function startWebServer(port: number = 3847): Promise<void> {
  if (server) {
    console.log('Web interface already running, skipping...');
    return;
  }

  return new Promise((resolve, reject) => {
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url?.split('?')[0] || '/';

      // CORS: allow localhost and Tailscale network
      const origin = req.headers.origin;
      if (origin && (
        origin.startsWith('http://localhost:') ||
        origin.startsWith('http://127.0.0.1:') ||
        origin.startsWith('http://100.') // Tailscale CGNAT range (100.64.0.0/10)
      )) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
      }

      // ---- Dashboard ----
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);

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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          runningTasks: stats?.schedulerStats?.running ?? 0,
          queuedTasks: stats?.schedulerStats?.queued ?? 0,
          completedToday: stats?.schedulerStats?.completed ?? 0,
          uptime: state?.startedAt ? Date.now() - state.startedAt : 0,
          isRunning: stats?.isRunning ?? false,
          sseClients: getActiveSSECount(),
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
        const byPath = new Map(taskInfo.filter(p => p.path).map(p => [p.path, p]));
        // Fallback: match by project name (for tasks not yet executed → path not cached)
        const byName = new Map(taskInfo.map(p => [p.name, p]));

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
          const info = byPath.get(p) ?? byName.get(dirName);
          const gitInfo = await getProjectGitInfo(p);
          return {
            path: p,
            name: dirName,
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
          res.end(JSON.stringify({ error: String(e) }));
        }

      // ---- Pin project ----
      } else if (url === '/api/projects/pin' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const { projectPath } = JSON.parse(body) as { projectPath: string };
          if (typeof projectPath === 'string' && projectPath) {
            pinnedProjects.add(projectPath);
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
            if (enabled) runnerRef?.enableProject(projectPath);
            else         runnerRef?.disableProject(projectPath);
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
          res.end(JSON.stringify({ error: String(error) }));
        }

      // ---- Heartbeat (manual trigger) ----
      } else if (url === '/api/heartbeat' && req.method === 'POST') {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        // Non-blocking heartbeat
        runnerRef?.heartbeat().catch((e: Error) => console.error('[Web] Heartbeat error:', e));

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
          res.end(JSON.stringify({ error: String(error) }));
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
          res.end(JSON.stringify({ error: String(error) }));
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
          res.end(JSON.stringify({ error: String(error) }));
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getLogBuffer()));

      // ---- Stage buffer snapshot ----
      } else if (url === '/api/stages' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getStageBuffer()));

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

        const contextPrompt = [
          'You are OpenSwarm, an autonomous code development supervisor.',
          'You manage a fleet of Claude Code agents that autonomously work on Linear issues.',
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

        const tmpFile = `/tmp/openswarm-chat-${Date.now()}.txt`;
        try {
          writeFileSync(tmpFile, contextPrompt);
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to write prompt' }));
          return;
        }

        // Pass prompt via stdin (safe for special characters)
        const response = await new Promise<string>((resolve) => {
          const proc = spawn(
            'claude',
            ['--output-format', 'stream-json', '-p', contextPrompt],
            { shell: false, cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
          );
          let out = '';
          proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
          proc.on('close', () => {
            // Extract cost
            const costInfo = extractCostFromStreamJson(out);
            if (costInfo) {
              console.log(`[Web Chat] Cost: ${formatCost(costInfo)}`);
            }
            // Extract result text from stream-json
            let resultText = '';
            const assistantTexts: string[] = [];
            for (const line of out.split('\n').filter(Boolean)) {
              try {
                const event = JSON.parse(line);
                if (event.type === 'result' && event.result) {
                  resultText = event.result;
                }
                // Collect text blocks from assistant messages (fallback when result is empty)
                if (event.type === 'assistant' && event.message?.content) {
                  for (const block of event.message.content) {
                    if (block.type === 'text' && block.text?.trim()) {
                      assistantTexts.push(block.text.trim());
                    }
                  }
                }
              } catch { /* ignore */ }
            }
            // Use result if available, otherwise combine assistant text, fallback to error message
            resolve(resultText.trim() || assistantTexts.join('\n\n') || '[No response]');
          });
          proc.on('error', (e: Error) => resolve(`[Error: ${e.message}]`));
          setTimeout(() => { proc.kill(); resolve('[Response timeout — try a shorter question]'); }, 180000);
        });

        try { unlinkSync(tmpFile); } catch {}

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
        res.end(JSON.stringify({ ok: true, response }));

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
          res.end(JSON.stringify({ error: String(e) }));
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
          res.end(JSON.stringify({ error: String(e) }));
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
            res.end(JSON.stringify({ error: String(e) }));
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
          res.end(JSON.stringify({ error: String(e) }));
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
          if (!config.id || !config.name || !config.checkCommand || !config.completionCheck) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required fields: id, name, checkCommand, completionCheck' }));
            return;
          }
          const monitor = registerMonitor(config);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(monitor));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }

      // ---- Monitors: delete ----
      } else if (url.startsWith('/api/monitors/') && req.method === 'DELETE') {
        const monitorId = url.replace('/api/monitors/', '');
        const deleted = unregisterMonitor(monitorId);
        res.writeHead(deleted ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: deleted }));

      // ---- Processes: list ----
      } else if (url === '/api/processes' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getAllProcesses()));

      // ---- Processes: kill ----
      } else if (url.startsWith('/api/processes/') && req.method === 'DELETE') {
        const pidStr = url.replace('/api/processes/', '');
        const pid = parseInt(pidStr, 10);
        if (isNaN(pid)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid PID' }));
        } else {
          const killed = await killProcess(pid);
          res.writeHead(killed ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: killed }));
        }

      // ---- Scan Paths: list ----
      } else if (url === '/api/scan-paths' && req.method === 'GET') {
        const configPaths = runnerRef?.getAllowedProjects() ?? [];
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
        customBasePaths.delete(decodedPath);
        invalidateProjectCache();
        saveReposConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

      // ---- Discord history (legacy) ----
      } else if (url === '/api/history') {
        const history = await getChatHistory();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(history));

      } else {
        res.writeHead(404);
        res.end('Not Found');
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

    server.listen(port, '0.0.0.0', () => {
      const tailscaleIP = '100.95.200.28'; // Current Tailscale IP
      console.log(`Web interface running at:`);
      console.log(`  - http://127.0.0.1:${port} (localhost)`);
      console.log(`  - http://${tailscaleIP}:${port} (Tailscale)`);
      startGitStatusPoller(() => Array.from(pinnedProjects));
      startHealthChecker(30000);
      resolve();
    });
  });
}

/**
 * Stop the web server
 */
export async function stopWebServer(): Promise<void> {
  if (server) {
    server.close();
    server = null;
  }
}
