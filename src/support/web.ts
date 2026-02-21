// ============================================
// Claude Swarm - Web Interface
// ============================================

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { getChatHistory } from '../discord/index.js';
import { addSSEClient, getActiveSSECount, broadcastEvent } from '../core/eventHub.js';
import { extractCostFromStreamJson, formatCost } from './costTracker.js';
import { scanLocalProjects } from './projectMapper.js';
import type { AutonomousRunner } from '../automation/autonomousRunner.js';
import { DASHBOARD_HTML } from './dashboardHtml.js';

let server: ReturnType<typeof createServer> | null = null;
let runnerRef: AutonomousRunner | undefined;

const chatHistory: { role: 'user' | 'agent'; text: string; ts: number }[] = [];

// ============================================
// Pinned + enabled repos persistence
// ============================================
const REPOS_FILE = join(homedir(), '.claude', 'claude-swarm-repos.json');

interface ReposConfig {
  pinned: string[];    // user-added repos (shown in dashboard)
  enabled: string[];   // explicitly enabled for agent work
}

function loadReposConfig(): ReposConfig {
  try {
    if (existsSync(REPOS_FILE)) {
      return JSON.parse(readFileSync(REPOS_FILE, 'utf-8')) as ReposConfig;
    }
  } catch {}
  return { pinned: [], enabled: [] };
}

function saveReposConfig(): void {
  try {
    const cfg: ReposConfig = {
      pinned:  Array.from(pinnedProjects),
      enabled: runnerRef?.getEnabledProjects() ?? [],
    };
    writeFileSync(REPOS_FILE, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.warn('[Web] Failed to save repos config:', e);
  }
}

const _reposCfg = loadReposConfig();
const pinnedProjects = new Set<string>(_reposCfg.pinned);

/**
 * Set runner reference (call after autonomous runner is initialized)
 */
export function setWebRunner(runner: AutonomousRunner): void {
  runnerRef = runner;
  // Restore persisted enabled state
  for (const path of _reposCfg.enabled) {
    runner.enableProject(path);
  }
  // Pre-seed path cache from pinned projects so tasks without execution history are still matched
  for (const path of pinnedProjects) {
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

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');

      // ---- Dashboard ----
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);

      // ---- SSE stream ----
      } else if (url === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.write(':connected\n\n');
        addSSEClient(res);

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

      // ---- Projects GET (user-managed list only) ----
      } else if (url === '/api/projects' && req.method === 'GET') {
        const enabledPaths = new Set(runnerRef?.getEnabledProjects() ?? []);
        const taskInfo = runnerRef?.getProjectsInfo() ?? [];
        const byPath = new Map(taskInfo.filter(p => p.path).map(p => [p.path, p]));
        // Fallback: match by project name (for tasks not yet executed → path not cached)
        const byName = new Map(taskInfo.map(p => [p.name, p]));

        const result = Array.from(pinnedProjects).map(p => {
          const dirName = p.split('/').pop() ?? p;
          const info = byPath.get(p) ?? byName.get(dirName);
          return {
            path: p,
            name: dirName,
            enabled: enabledPaths.has(p),
            running: info?.running ?? [],
            queued:  info?.queued  ?? [],
            pending: info?.pending ?? [],
          };
        });

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
        const basePaths = runnerRef?.getAllowedProjects() ?? [];
        try {
          const locals = await scanLocalProjects(basePaths);
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

      // ---- Heartbeat (manual trigger) ----
      } else if (url === '/api/heartbeat' && req.method === 'POST') {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        // Non-blocking heartbeat
        runnerRef?.heartbeat().catch((e: Error) => console.error('[Web] Heartbeat error:', e));

      // ---- Chat history ----
      } else if (url === '/api/chat/history' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(chatHistory.slice(-50)));

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
        chatHistory.push({ role: 'user', text: message, ts: Date.now() });

        // Build context-aware prompt (이전 대화 포함)
        const stats    = runnerRef?.getStats();
        const projects = runnerRef?.getProjectsInfo() ?? [];
        const enabled  = projects.filter(p => p.enabled).length;
        const state    = runnerRef?.getState();
        const uptimeSec = state?.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;

        // 현재 메시지 제외한 최근 10개 대화 이력 포맷
        const recentHistory = chatHistory.slice(-11, -1);
        const historyBlock = recentHistory.length > 0
          ? recentHistory.map(m => (m.role === 'user' ? 'User' : 'VEGA') + ': ' + m.text).join('\n\n')
          : '';

        const contextPrompt = [
          'You are VEGA, an autonomous code development supervisor powered by Claude Swarm.',
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
          'Answer the user concisely and helpfully in the same language they use. Use the status data above if relevant.',
          '',
          'User: ' + message,
        ].join('\n');

        const tmpFile = `/tmp/vega-chat-${Date.now()}.txt`;
        try {
          writeFileSync(tmpFile, contextPrompt);
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to write prompt' }));
          return;
        }

        // stdin으로 프롬프트 전달 (특수문자 안전)
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
            for (const line of out.split('\n').filter(Boolean)) {
              try {
                const event = JSON.parse(line);
                if (event.type === 'result' && event.result) {
                  resultText = event.result;
                }
              } catch { /* ignore */ }
            }
            resolve(resultText.trim() || out.trim() || '[No response]');
          });
          proc.on('error', (e: Error) => resolve(`[Error: ${e.message}]`));
          setTimeout(() => { proc.kill(); resolve('[Response timeout — try a shorter question]'); }, 180000);
        });

        try { unlinkSync(tmpFile); } catch {}

        chatHistory.push({ role: 'agent', text: response, ts: Date.now() });
        broadcastEvent({ type: 'chat:agent', data: { text: response, ts: Date.now() } });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, response }));

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

    server.listen(port, () => {
      console.log(`Web interface running at http://localhost:${port}`);
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
