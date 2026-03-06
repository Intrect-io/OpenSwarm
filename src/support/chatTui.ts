#!/usr/bin/env tsx

// OpenSwarm - Rich TUI Chat Interface
// Claude Code style tabbed interface with real-time updates
import blessed from 'blessed';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
// Constants
const CHAT_DIR = resolve(homedir(), '.openswarm', 'chat');
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

// Render guard: blessed는 동시 render() 호출 시 화면이 검은색으로 깨질 수 있음
let renderScheduled = false;
let screenRef: blessed.Widgets.Screen | null = null;

function safeRender() {
  if (renderScheduled || !screenRef) return;
  renderScheduled = true;
  process.nextTick(() => {
    renderScheduled = false;
    try {
      screenRef!.render();
    } catch {
      // render 실패 시 복구 시도
      try {
        screenRef!.alloc();
        screenRef!.render();
      } catch {
        // 무시 — 다음 사이클에서 복구
      }
    }
  });
}
// Types
type Message = { role: 'user' | 'assistant'; content: string; cost?: number };

type Session = {
  id: string;
  model: string;
  messages: Message[];
  claudeSessionId?: string;
  totalCost: number;
  totalTokens: number;
  createdAt: string;
  updatedAt: string;
};

type AppState = {
  session: Session;
  currentTab: number;
  inputMode: 'normal' | 'multiline';
  multilineBuffer: string[];
  showBinary: boolean;
  diagnostics: {
    lastResponseTime: number;
    avgTokensPerSec: number;
    totalRequests: number;
  };
};
// Session Management
async function ensureChatDir(): Promise<void> {
  await mkdir(CHAT_DIR, { recursive: true });
}

async function saveSession(session: Session): Promise<void> {
  await ensureChatDir();
  session.updatedAt = new Date().toISOString();
  const path = resolve(CHAT_DIR, `${session.id}.json`);
  await writeFile(path, JSON.stringify(session, null, 2));
}

async function loadSession(id: string): Promise<Session | null> {
  const path = resolve(CHAT_DIR, `${id}.json`);
  if (!existsSync(path)) return null;
  const data = JSON.parse(await readFile(path, 'utf-8'));
  // Ensure new fields exist
  return {
    ...data,
    totalCost: data.totalCost ?? 0,
    totalTokens: data.totalTokens ?? 0,
  };
}

function generateSessionId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}
// Claude CLI Backend
async function callClaude(
  prompt: string,
  model: string,
  sessionId: string | undefined,
  onStream: (text: string, isThinking: boolean) => void,
): Promise<{ response: string; sessionId: string; cost: number; tokens: number }> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--model', model,
    ];

    if (sessionId) {
      args.push('--resume', sessionId);
    }

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let fullResponse = '';
    let buffer = '';
    let capturedSessionId = sessionId || '';
    let cost = 0;
    let tokens = 0;
    let stderrOutput = '';
    let thinkingTimer: NodeJS.Timeout | null = null;

    // Monitor for thinking pauses (no output for 2 seconds)
    const resetThinkingTimer = () => {
      if (thinkingTimer) {
        clearTimeout(thinkingTimer);
      }
      thinkingTimer = setTimeout(() => {
        // If no output for 2 seconds and we have some response, signal thinking
        if (fullResponse.length > 0) {
          onStream('', true);
        }
      }, 2000);
    };

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          if (event.session_id && !capturedSessionId) {
            capturedSessionId = event.session_id;
          }

          // Stream assistant response
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                fullResponse += block.text;
                onStream(block.text, false);
                resetThinkingTimer(); // Reset thinking detection
              }
            }
          }

          // Extract cost and tokens from result
          if (event.type === 'result') {
            if (thinkingTimer) clearTimeout(thinkingTimer);
            cost = event.total_cost_usd ?? 0;
            tokens = (event.input_tokens ?? 0) + (event.output_tokens ?? 0);
            if (event.session_id) {
              capturedSessionId = event.session_id;
            }
          }
        } catch {
          // Ignore parse failures
        }
      }
    });

    proc.on('close', (code) => {
      if (thinkingTimer) clearTimeout(thinkingTimer);
      if (code !== 0) {
        // Always report non-zero exit codes
        const errorMsg = stderrOutput.trim() || 'Unknown error';
        const errorPrefix = fullResponse ? 'Partial response received, but' : 'Claude';
        reject(new Error(`${errorPrefix} exited with code ${code}: ${errorMsg}`));
      } else {
        resolve({
          response: fullResponse,
          sessionId: capturedSessionId,
          cost,
          tokens,
        });
      }
    });

    proc.on('error', (err) => {
      if (thinkingTimer) clearTimeout(thinkingTimer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.stdin.end();
  });
}
// Warhammer 40k Loading Messages
const LOADING_MESSAGES = [
  'Initializing cogitator arrays',
  'Querying data-vault archives',
  'Accessing servitor protocols',
  'Compiling neural responses',
  'Interfacing with the Noosphere',
  'Scanning data-streams',
  'Calibrating logic engines',
  'Decoding transmission packets',
  'Loading archive databases',
  'Synchronizing machine protocols',
  'Analyzing pattern matrices',
  'Establishing neural link',
  'Processing data-core output',
  'Running diagnostics sequence',
  'Activating response circuits',
];

const SPINNER_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
// UI Components - Claude Code Style
function createUI() {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'OpenSwarm Chat',
    fullUnicode: true,
    terminal: 'xterm-256color',
    forceUnicode: true,
    warnings: false, // Suppress warnings that can corrupt display
    dockBorders: true, // Better border handling in tmux
    fastCSR: true, // Faster rendering for streaming
  });

  const colors = {
    bg: '#1a1a1a',
    statusBg: '#2d3748',
    statusFg: '#e2e8f0',
    tabActiveBg: '#4a5568',
    tabActiveFg: '#f7fafc',
    tabInactiveBg: '#2d3748',
    tabInactiveFg: '#a0aec0',
    border: '#4a5568',
    borderActive: '#667eea',
    inputBorder: '#48bb78',
    scrollbar: '#4a5568',
    userMessage: '#60a5fa',
    assistantMessage: '#34d399',
    dimText: '#718096',
  };

  const statusBar = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    style: {
      fg: colors.statusFg,
      bg: colors.statusBg,
    },
  });

  const tabBar = blessed.box({
    top: 1,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    style: {
      fg: colors.tabInactiveFg,
      bg: colors.tabInactiveBg,
    },
  });

  // Chat tab content - clean borders (adjusted for taller input box)
  const chatLog = blessed.log({
    top: 2,
    left: 0,
    width: '100%',
    height: '100%-9',  // Increased from -7 to -9 for 5-line input box
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    scrollbar: {
      ch: '│',
      track: {
        bg: '#1a1a1a',
      },
      style: {
        fg: colors.scrollbar,
      },
    },
    tags: true,
    border: { type: 'line' },
    style: {
      fg: '#e2e8f0',
      bg: '#1a1a1a',
      border: {
        fg: colors.border,
      },
    },
  });

  const projectsBox = blessed.box({
    top: 2,
    left: 0,
    width: '100%',
    height: '100%-9',  // Adjusted for taller input box
    content: '{center}{#718096-fg}Loading projects...{/}{/center}',
    tags: true,
    scrollable: true,
    mouse: true,
    scrollbar: {
      ch: '│',
      style: { fg: colors.scrollbar },
    },
    border: { type: 'line' },
    style: {
      fg: '#e2e8f0',
      bg: '#1a1a1a',
      border: { fg: colors.border },
    },
    hidden: true,
  });

  const tasksBox = blessed.box({
    top: 2,
    left: 0,
    width: '100%',
    height: '100%-9',  // Adjusted for taller input box
    content: '{center}{#718096-fg}Loading tasks...{/}{/center}',
    tags: true,
    scrollable: true,
    mouse: true,
    scrollbar: {
      ch: '│',
      style: { fg: colors.scrollbar },
    },
    border: { type: 'line' },
    style: {
      fg: '#e2e8f0',
      bg: '#1a1a1a',
      border: { fg: colors.border },
    },
    hidden: true,
  });

  const stuckBox = blessed.box({
    top: 2,
    left: 0,
    width: '100%',
    height: '100%-9',
    content: '{center}{#718096-fg}Loading stuck issues...{/}{/center}',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    keys: true,
    vi: true,
    scrollbar: {
      ch: '█',
      style: { fg: colors.scrollbar },
    },
    style: {
      border: { fg: colors.border },
    },
    hidden: true,
  });

  const logsBox = blessed.log({
    top: 2,
    left: 0,
    width: '100%',
    height: '100%-9',  // Adjusted for taller input box
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    scrollbar: {
      ch: '│',
      style: { fg: colors.scrollbar },
    },
    tags: true,
    border: { type: 'line' },
    style: {
      fg: '#e2e8f0',
      bg: '#1a1a1a',
      border: { fg: colors.border },
    },
    hidden: true,
  });

  // Input box - textarea for multiline + Korean support
  const inputBox = blessed.textarea({
    bottom: 1,
    left: 0,
    width: '100%',
    height: 5,  // Increased height for multiline
    inputOnFocus: true,
    border: { type: 'line' },
    label: ' {#718096-fg}Message (Shift+Enter: newline, Enter: send){/} ',
    tags: true,
    keys: true,  // Enable key handling
    mouse: true,
    scrollable: true,
    alwaysScroll: false,
    style: {
      fg: '#f7fafc',
      bg: '#1a1a1a',
      border: { fg: colors.border },
      focus: {
        border: { fg: colors.borderActive },
        bg: '#0d1117',
      },
    },
  });

  const helpBar = blessed.box({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: ' {#718096-fg}Tab{/} Switch  {#718096-fg}Enter{/} Send  {#718096-fg}Shift+Enter{/} Newline  {#718096-fg}Esc{/} Exit Input  {#718096-fg}i{/} Focus Input  {#718096-fg}Ctrl+C{/} Exit  {#718096-fg}/help{/} Cmds',
    tags: true,
    style: {
      fg: '#a0aec0',
      bg: colors.statusBg,
    },
  });

  screen.append(statusBar);
  screen.append(tabBar);
  screen.append(chatLog);
  screen.append(projectsBox);
  screen.append(tasksBox);
  screen.append(stuckBox);
  screen.append(logsBox);
  screen.append(inputBox);
  screen.append(helpBar);

  return {
    screen,
    statusBar,
    tabBar,
    chatLog,
    projectsBox,
    tasksBox,
    stuckBox,
    logsBox,
    inputBox,
    helpBar,
  };
}
// Tab Management
function updateTabBar(ui: ReturnType<typeof createUI>, currentTab: number) {
  const tabs = [
    { key: '1', name: 'Chat', icon: '💬' },
    { key: '2', name: 'Projects', icon: '📁' },
    { key: '3', name: 'Tasks', icon: '✓' },
    { key: '4', name: 'Stuck', icon: '⚠' },
    { key: '5', name: 'Logs', icon: '📝' },
  ];

  const content = tabs.map((tab, idx) => {
    if (idx === currentTab) {
      // Active tab - highlighted
      return `{#4a5568-bg}{#f7fafc-fg}{bold} ${tab.icon} ${tab.name} {/bold}{/}{/}`;
    }
    // Inactive tab - dimmed
    return `{#2d3748-bg}{#a0aec0-fg} ${tab.icon} ${tab.name} {/}{/}`;
  }).join(' ');

  ui.tabBar.setContent(' ' + content);
}

function switchTab(state: AppState, ui: ReturnType<typeof createUI>, tabIndex: number) {
  state.currentTab = tabIndex;

  ui.chatLog.hide();
  ui.projectsBox.hide();
  ui.tasksBox.hide();
  ui.stuckBox.hide();
  ui.logsBox.hide();

  switch (tabIndex) {
    case 0:
      ui.chatLog.show();
      break;
    case 1:
      ui.projectsBox.show();
      loadProjectsData(ui.projectsBox);
      break;
    case 2:
      ui.tasksBox.show();
      loadTasksData(ui.tasksBox);
      break;
    case 3:
      ui.stuckBox.show();
      loadStuckData(ui.stuckBox);
      break;
    case 4:
      ui.logsBox.show();
      break;
  }

  updateTabBar(ui, tabIndex);
  safeRender();
}
// Data Loaders
async function loadProjectsData(box: blessed.Widgets.BoxElement) {
  try {
    const response = await fetch('http://127.0.0.1:3847/api/projects');
    const projects = await response.json() as Array<{
      name: string;
      path: string;
      enabled: boolean;
      running: string[];
      queued: string[];
    }>;

    if (projects.length === 0) {
      box.setContent('\n{center}{#718096-fg}No projects tracked{/}{/center}');
      return;
    }

    const lines = [
      '',
      `  {#a0aec0-fg}${projects.length} project${projects.length > 1 ? 's' : ''} tracked{/}`,
      '',
    ];

    for (const p of projects) {
      const status = p.enabled ? '{#34d399-fg}●{/}' : '{#718096-fg}○{/}';
      const running = p.running.length > 0 ? `{#60a5fa-fg}${p.running.length} running{/}` : '';
      const queued = p.queued.length > 0 ? `{#f59e0b-fg}${p.queued.length} queued{/}` : '';
      const tasks = [running, queued].filter(Boolean).join(' · ');

      lines.push(`  ${status} {bold}${p.name}{/bold}`);
      if (tasks) {
        lines.push(`    ${tasks}`);
      }
      lines.push(`    {#718096-fg}${p.path}{/}`);
      lines.push('');
    }

    box.setContent(lines.join('\n'));
  } catch (err) {
    box.setContent(`\n{center}{#ef4444-fg}Failed to load projects{/}\n{#718096-fg}${err}{/}{/center}`);
  }
}

async function loadTasksData(box: blessed.Widgets.BoxElement) {
  try {
    const response = await fetch('http://127.0.0.1:3847/api/pipeline');
    const { stages } = await response.json() as {
      stages: Array<{
        type: string;
        data: {
          taskId?: string;
          stage?: string;
          status?: 'start' | 'complete' | 'fail';
          model?: string;
          inputTokens?: number;
          outputTokens?: number;
          costUsd?: number;
          title?: string;
          issueIdentifier?: string;
        };
      }>;
    };

    if (stages.length === 0) {
      box.setContent('\n{center}{#718096-fg}No pipeline events{/}{/center}');
      return;
    }

    // Build task info map and extract stage events
    const taskInfo = new Map<string, { title?: string; issueIdentifier?: string }>();
    const allStageEvents: Array<{ taskId: string; stage: string; status: string; model?: string; inputTokens?: number; outputTokens?: number; costUsd?: number }> = [];

    for (const event of stages) {
      if (event.type === 'task:started' && event.data.taskId) {
        taskInfo.set(event.data.taskId, { title: event.data.title, issueIdentifier: event.data.issueIdentifier });
      } else if (event.type === 'pipeline:stage' && event.data.taskId && event.data.stage) {
        allStageEvents.push({
          taskId: event.data.taskId,
          stage: event.data.stage,
          status: event.data.status || '',
          model: event.data.model,
          inputTokens: event.data.inputTokens,
          outputTokens: event.data.outputTokens,
          costUsd: event.data.costUsd,
        });
      }
    }

    if (allStageEvents.length === 0) {
      box.setContent('\n{center}{#718096-fg}No active pipeline stages{/}{/center}');
      return;
    }

    // Render pipeline table
    const recentStages = allStageEvents.slice(-15).reverse();
    const lines = [
      '',
      `  {#34d399-fg}{bold}Pipeline Events{/bold} {#718096-fg}(${recentStages.length} recent){/}{/}`,
      '',
      `  {#718096-fg}${'TASK'.padEnd(12)} ${'STAGE'.padEnd(10)} ${'MODEL'.padEnd(12)} ${'TOKENS'.padEnd(15)} STATUS{/}`,
      `  {#444444-fg}${'─'.repeat(70)}{/}`,
    ];

    for (const ev of recentStages) {
      const info = taskInfo.get(ev.taskId);
      const task = (info?.issueIdentifier || ev.taskId.slice(0, 8)).padEnd(12).slice(0, 12);
      const stage = ev.stage.padEnd(10).slice(0, 10);

      const statusMap: Record<string, [string, string]> = {
        start: ['◐', '#f59e0b'],
        complete: ['●', '#34d399'],
        fail: ['✗', '#ef4444'],
      };
      const [icon, color] = statusMap[ev.status] || ['○', '#718096'];

      let model = '';
      if (ev.model?.includes('sonnet-4-5')) model = 'sonnet-4.5';
      else if (ev.model?.includes('haiku-4-5')) model = 'haiku-4.5';
      else if (ev.model?.includes('opus-4')) model = 'opus-4';
      else if (ev.model) model = ev.model.split('-').pop() || '';
      model = model.padEnd(12).slice(0, 12);

      let tokens = '';
      if (ev.inputTokens || ev.outputTokens) {
        const inK = ev.inputTokens ? Math.round(ev.inputTokens / 1000) : 0;
        const outK = ev.outputTokens ? Math.round(ev.outputTokens / 1000) : 0;
        tokens = `${inK}k/${outK}k`;
        if (ev.costUsd != null) tokens += ` $${ev.costUsd.toFixed(2)}`;
      }
      tokens = tokens.padEnd(15).slice(0, 15);

      lines.push(`  {#34d399-fg}${task}{/} {#718096-fg}${stage}{/} {#34d399-fg}${model}{/} {#718096-fg}${tokens}{/} {${color}-fg}${icon} ${ev.status}{/}`);
    }

    box.setContent(lines.join('\n'));
  } catch (err) {
    box.setContent(`\n{center}{#ef4444-fg}Failed to load pipeline{/}\n{#718096-fg}${err}{/}{/center}`);
  }
}

async function loadStuckData(box: blessed.Widgets.BoxElement) {
  try {
    const response = await fetch('http://127.0.0.1:3847/api/stuck-issues');
    const { stuckIssues, failedIssues } = await response.json() as {
      stuckIssues: Array<{
        identifier: string;
        title: string;
        state: string;
        priority: number;
        stuckDays: number;
        reason: string;
        project?: { name: string };
      }>;
      failedIssues: Array<{
        identifier: string;
        title: string;
        state: string;
        priority: number;
        reason: string;
        project?: { name: string };
      }>;
    };

    const totalStuck = stuckIssues.length;
    const totalFailed = failedIssues.length;
    const total = totalStuck + totalFailed;

    if (total === 0) {
      box.setContent('\n{center}{#34d399-fg}✓ All issues healthy{/}{/center}');
      return;
    }

    const lines = [
      '',
      `  {#ef4444-fg}⚠ ${total} issue${total > 1 ? 's' : ''} need attention{/}`,
      '',
    ];

    // Stuck issues
    if (totalStuck > 0) {
      lines.push(`  {#f59e0b-fg}{bold}⏱ STUCK (${totalStuck}){/bold}{/}`);
      lines.push('');

      for (const issue of stuckIssues) {
        const priorityIcon = issue.priority === 1 ? '{#ef4444-fg}🔴{/}' : issue.priority === 2 ? '{#f59e0b-fg}🟡{/}' : '{#718096-fg}⚪{/}';
        lines.push(`  ${priorityIcon} {bold}${issue.identifier}{/bold}`);
        lines.push(`    ${issue.title.substring(0, 60)}${issue.title.length > 60 ? '...' : ''}`);
        lines.push(`    {#f59e0b-fg}${issue.reason}{/}`);
        if (issue.project?.name) {
          lines.push(`    {#718096-fg}📁 ${issue.project.name}{/}`);
        }
        lines.push('');
      }
    }

    // Failed issues
    if (totalFailed > 0) {
      lines.push(`  {#ef4444-fg}{bold}✖ FAILED (${totalFailed}){/bold}{/}`);
      lines.push('');

      for (const issue of failedIssues) {
        const priorityIcon = issue.priority === 1 ? '{#ef4444-fg}🔴{/}' : issue.priority === 2 ? '{#f59e0b-fg}🟡{/}' : '{#718096-fg}⚪{/}';
        lines.push(`  ${priorityIcon} {bold}${issue.identifier}{/bold}`);
        lines.push(`    ${issue.title.substring(0, 60)}${issue.title.length > 60 ? '...' : ''}`);
        lines.push(`    {#ef4444-fg}${issue.reason}{/}`);
        if (issue.project?.name) {
          lines.push(`    {#718096-fg}📁 ${issue.project.name}{/}`);
        }
        lines.push('');
      }
    }

    box.setContent(lines.join('\n'));
  } catch (err) {
    box.setContent(`\n{center}{#ef4444-fg}Failed to load stuck issues{/}\n{#718096-fg}${err}{/}{/center}`);
  }
}
// Loading Spinner (inline in chat)
function startSpinner(ui: ReturnType<typeof createUI>): { interval: NodeJS.Timeout; lineIndex: number } {
  let frameIndex = 0;
  const loadingMessage = LOADING_MESSAGES[Math.floor(Math.random() * LOADING_MESSAGES.length)];

  const lines = ui.chatLog.getLines();
  const lineIndex = lines.length;

  const interval = setInterval(() => {
    const spinner = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
    const content = `  {#667eea-fg}${spinner}{/} {#718096-fg}${loadingMessage}...{/}`;
    ui.chatLog.setLine(lineIndex, content);
    ui.chatLog.setScrollPerc(100);
    safeRender();
    frameIndex++;
  }, 80);

  return { interval, lineIndex };
}

function stopSpinner(
  ui: ReturnType<typeof createUI>,
  spinnerData: { interval: NodeJS.Timeout; lineIndex: number }
): void {
  clearInterval(spinnerData.interval);
  ui.chatLog.deleteLine(spinnerData.lineIndex);
  safeRender();
}
// Chat Logic
async function sendMessage(state: AppState, ui: ReturnType<typeof createUI>, message: string) {
  if (!message.trim()) return;

  ui.chatLog.log('');
  ui.chatLog.log(`{#60a5fa-fg}{bold}▸ You{/bold}{/}`);
  ui.chatLog.log(`  ${message}`);
  ui.chatLog.log('');
  ui.chatLog.setScrollPerc(100);
  safeRender();

  state.session.messages.push({ role: 'user', content: message });

  ui.chatLog.log(`{#34d399-fg}{bold}▸ Assistant{/bold}{/}`);
  const assistantHeaderLine = ui.chatLog.getLines().length - 1;
  let assistantContent = '';
  let lastRenderTime = 0;
  let spinnerStopped = false;
  let contentStartLine = assistantHeaderLine + 1;

  const spinnerData = startSpinner(ui);

  try {
    const result = await callClaude(
      message,
      state.session.model,
      state.session.claudeSessionId,
      (chunk, isThinking) => {
        // Handle thinking notification (show/resume spinner)
        if (isThinking) {
          if (spinnerStopped) {
            // Resume spinner for thinking phase
            spinnerStopped = false;
            const newSpinner = startSpinner(ui);
            Object.assign(spinnerData, newSpinner);
          }
          return;
        }

        // Stop spinner on first text chunk
        if (!spinnerStopped && chunk) {
          stopSpinner(ui, spinnerData);
          spinnerStopped = true;
        }

        if (!chunk) return;

        assistantContent += chunk;
        // Throttle rendering for smoother streaming (30fps)
        const now = Date.now();
        if (now - lastRenderTime < 33) return;
        lastRenderTime = now;

        // Clear previous content lines (안전한 역순 삭제)
        const currentLines = ui.chatLog.getLines().length;
        const deleteCount = Math.max(0, Math.min(currentLines - contentStartLine, currentLines));
        for (let i = 0; i < deleteCount; i++) {
          ui.chatLog.deleteLine(contentStartLine);
        }

        // Add updated content line by line with proper empty line handling
        const contentLines = assistantContent.split('\n');
        for (const line of contentLines) {
          // Always add line, even if empty (preserves paragraph breaks)
          ui.chatLog.log(line ? `  ${line}` : '  ');
        }

        ui.chatLog.setScrollPerc(100);
        safeRender();
      }
    );

    // Ensure spinner is stopped
    if (!spinnerStopped) {
      stopSpinner(ui, spinnerData);
      spinnerStopped = true;
    }

    if (result.sessionId) {
      state.session.claudeSessionId = result.sessionId;
    }

    // Update session stats
    state.session.totalCost += result.cost;
    state.session.totalTokens += result.tokens;

    // Finalize assistant message with cost
    // Clear streaming content first (안전한 삭제)
    const finalLines = ui.chatLog.getLines().length;
    const finalDeleteCount = Math.max(0, Math.min(finalLines - contentStartLine, finalLines));
    for (let i = 0; i < finalDeleteCount; i++) {
      ui.chatLog.deleteLine(contentStartLine);
    }

    // Add final content line by line with proper empty line handling
    const contentLines = result.response.split('\n');
    for (const line of contentLines) {
      // Always add line, even if empty (preserves paragraph breaks)
      ui.chatLog.log(line ? `  ${line}` : '  ');
    }

    // Add cost info if available
    if (result.cost > 0) {
      ui.chatLog.log(`  {#718096-fg}${result.tokens} tokens · $${result.cost.toFixed(4)}{/}`);
    }
    ui.chatLog.log('');

    state.session.messages.push({
      role: 'assistant',
      content: result.response,
      cost: result.cost,
    });

    await saveSession(state.session);
    updateStatusBar(state, ui);
    safeRender();
  } catch (err) {
    if (!spinnerStopped) {
      stopSpinner(ui, spinnerData);
    }
    const msg = err instanceof Error ? err.message : String(err);
    ui.chatLog.log(`{#ef4444-fg}{bold}✗ Error{/bold}{/}`);
    ui.chatLog.log(`  ${msg}`);
    ui.chatLog.log('');
    state.session.messages.pop(); // Remove user message on failure
    safeRender();
  }
}
// Status Bar Update
function updateStatusBar(state: AppState, ui: ReturnType<typeof createUI>) {
  const modelShort = state.session.model.replace('claude-', '').replace(/-\d{8}$/, '');
  const cost = state.session.totalCost > 0 ? `$${state.session.totalCost.toFixed(4)}` : '$0.00';
  const msgs = state.session.messages.length;

  const status = [
    '{bold}OpenSwarm{/bold}',
    `{#718096-fg}│{/}`,
    `{#a0aec0-fg}${state.session.id}{/}`,
    `{#718096-fg}│{/}`,
    `{#60a5fa-fg}${modelShort}{/}`,
    `{#718096-fg}│{/}`,
    `{#a0aec0-fg}${msgs} messages{/}`,
    `{#718096-fg}│{/}`,
    `{#34d399-fg}${cost}{/}`,
  ].join(' ');

  ui.statusBar.setContent(' ' + status);
}
// Command Handler
async function handleCommand(
  cmd: string,
  state: AppState,
  ui: ReturnType<typeof createUI>
): Promise<boolean> {
  const [command, ...args] = cmd.slice(1).split(' ');

  switch (command) {
    case 'clear':
    case 'c':
      state.session.messages = [];
      state.session.claudeSessionId = undefined;
      state.session.totalCost = 0;
      state.session.totalTokens = 0;
      ui.chatLog.setContent('');
      ui.chatLog.log('');
      ui.chatLog.log('{#34d399-fg}✓ Conversation cleared{/}');
      ui.chatLog.log('');
      updateStatusBar(state, ui);
      safeRender();
      break;

    case 'model':
    case 'm': {
      const newModel = args[0];
      ui.chatLog.log('');
      if (!newModel) {
        ui.chatLog.log(`  {bold}Current model:{/bold} {#60a5fa-fg}${state.session.model.replace('claude-', '').replace(/-\d{8}$/, '')}{/}`);
        ui.chatLog.log('');
        ui.chatLog.log('  {#718096-fg}Available models:{/}');
        ui.chatLog.log('    {#a0aec0-fg}sonnet{/}  {#718096-fg}→{/} claude-sonnet-4-5');
        ui.chatLog.log('    {#a0aec0-fg}haiku{/}   {#718096-fg}→{/} claude-haiku-4-5');
        ui.chatLog.log('    {#a0aec0-fg}opus{/}    {#718096-fg}→{/} claude-opus-4-6');
      } else {
        const aliases: Record<string, string> = {
          sonnet: 'claude-sonnet-4-5-20250929',
          haiku: 'claude-haiku-4-5-20251001',
          opus: 'claude-opus-4-6',
        };
        state.session.model = aliases[newModel] || newModel;
        state.session.claudeSessionId = undefined;
        const shortName = state.session.model.replace('claude-', '').replace(/-\d{8}$/, '');
        ui.chatLog.log(`  {#34d399-fg}✓ Model changed to {bold}${shortName}{/bold}{/}`);
        updateStatusBar(state, ui);
      }
      ui.chatLog.log('');
      safeRender();
      break;
    }

    case 'save': {
      const name = args[0] || state.session.id;
      state.session.id = name;
      await saveSession(state.session);
      ui.chatLog.log('');
      ui.chatLog.log(`  {#34d399-fg}✓ Session saved: {bold}${name}{/bold}{/}`);
      ui.chatLog.log('');
      updateStatusBar(state, ui);
      safeRender();
      break;
    }

    case 'help':
    case 'h':
    case '?':
      ui.chatLog.log('');
      ui.chatLog.log('  {bold}Available Commands{/bold}');
      ui.chatLog.log('');
      ui.chatLog.log('    {#60a5fa-fg}/clear{/}         Clear conversation');
      ui.chatLog.log('    {#60a5fa-fg}/model{/} [name]  Change model {#718096-fg}(sonnet/haiku/opus){/}');
      ui.chatLog.log('    {#60a5fa-fg}/save{/} [name]   Save session');
      ui.chatLog.log('    {#60a5fa-fg}/help{/}          Show this help');
      ui.chatLog.log('');
      ui.chatLog.log('  {bold}Navigation{/bold}');
      ui.chatLog.log('');
      ui.chatLog.log('    {#718096-fg}1-4{/}            Switch tabs directly');
      ui.chatLog.log('    {#718096-fg}Tab/Shift+Tab{/}  Cycle through tabs');
      ui.chatLog.log('    {#718096-fg}Esc{/}            Exit input mode (blur)');
      ui.chatLog.log('    {#718096-fg}i / Enter{/}      Focus input (from chat)');
      ui.chatLog.log('    {#718096-fg}Ctrl+C{/}         Exit (double press to confirm)');
      ui.chatLog.log('');
      safeRender();
      break;

    default:
      ui.chatLog.log('');
      ui.chatLog.log(`  {#ef4444-fg}Unknown command: /{bold}${command}{/bold}{/}`);
      ui.chatLog.log(`  {#718096-fg}Type {/}{#60a5fa-fg}/help{/}{#718096-fg} for available commands{/}`);
      ui.chatLog.log('');
      safeRender();
  }

  return false;
}
// Main
export async function main(): Promise<void> {
  const loadArg = process.argv[2];
  let session: Session;

  if (loadArg && loadArg !== '--' && !loadArg.startsWith('-')) {
    const loaded = await loadSession(loadArg);
    if (loaded) {
      session = loaded;
    } else {
      session = {
        id: loadArg,
        model: DEFAULT_MODEL,
        messages: [],
        totalCost: 0,
        totalTokens: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  } else {
    session = {
      id: generateSessionId(),
      model: DEFAULT_MODEL,
      messages: [],
      totalCost: 0,
      totalTokens: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  const state: AppState = {
    session,
    currentTab: 0,
    inputMode: 'normal',
    multilineBuffer: [],
    showBinary: false,
    diagnostics: {
      lastResponseTime: 0,
      avgTokensPerSec: 0,
      totalRequests: 0,
    },
  };

  const ui = createUI();
  screenRef = ui.screen;  // safeRender용 참조 설정

  updateStatusBar(state, ui);
  updateTabBar(ui, state.currentTab);

  // Restore chat history - Claude Code style with proper line breaks
  for (const msg of session.messages) {
    ui.chatLog.log('');
    if (msg.role === 'user') {
      ui.chatLog.log(`{#60a5fa-fg}{bold}▸ You{/bold}{/}`);
      // Split multiline user messages
      const userLines = msg.content.split('\n');
      for (const line of userLines) {
        ui.chatLog.log(line ? `  ${line}` : '  ');
      }
    } else {
      ui.chatLog.log(`{#34d399-fg}{bold}▸ Assistant{/bold}{/}`);
      // Split multiline assistant messages properly
      const assistantLines = msg.content.split('\n');
      for (const line of assistantLines) {
        ui.chatLog.log(line ? `  ${line}` : '  ');
      }
      if (msg.cost) {
        ui.chatLog.log(`  {#718096-fg}$${msg.cost.toFixed(4)}{/}`);
      }
    }
  }
  if (session.messages.length > 0) {
    ui.chatLog.log('');
  }

  // Key bindings
  ui.screen.key(['1'], () => switchTab(state, ui, 0));
  ui.screen.key(['2'], () => switchTab(state, ui, 1));
  ui.screen.key(['3'], () => switchTab(state, ui, 2));
  ui.screen.key(['4'], () => switchTab(state, ui, 3));
  ui.screen.key(['5'], () => switchTab(state, ui, 4));
  ui.screen.key(['tab'], () => {
    const next = (state.currentTab + 1) % 5;
    switchTab(state, ui, next);
  });
  ui.screen.key(['S-tab'], () => {
    const prev = (state.currentTab - 1 + 5) % 5;
    switchTab(state, ui, prev);
  });

  // Ctrl+C: Clear input or exit (Claude Code style)
  let ctrlCPressed = false;
  ui.screen.key(['C-c'], async () => {
    const currentValue = ui.inputBox.getValue();
    if (currentValue && currentValue.trim()) {
      // If input has text, just clear it
      ui.inputBox.clearValue();
      ui.inputBox.focus();
      safeRender();
      ctrlCPressed = false;
    } else {
      // If input is empty, exit with double Ctrl+C
      if (ctrlCPressed) {
        await saveSession(state.session);
        process.exit(0);
      } else {
        ctrlCPressed = true;
        ui.statusBar.setContent(' {#f59e0b-fg}Press Ctrl+C again to exit{/}');
        safeRender();
        setTimeout(() => {
          ctrlCPressed = false;
          updateStatusBar(state, ui);
          safeRender();
        }, 2000);
      }
    }
  });

  // Escape: Clear input and blur (exit input mode)
  ui.screen.key(['escape'], () => {
    const currentValue = ui.inputBox.getValue();
    if (currentValue && currentValue.trim()) {
      // Clear input if has content
      ui.inputBox.clearValue();
    }
    // Blur input box to exit input mode
    ui.chatLog.focus();
    safeRender();
  });

  // Enter in chatLog: focus input
  ui.chatLog.key(['enter', 'i'], () => {
    ui.inputBox.focus();
    safeRender();
  });

  // Shift+Enter: Insert newline (handled by textarea by default)
  // Enter: Submit message
  ui.inputBox.key(['enter'], async () => {
    const value = ui.inputBox.getValue();
    const trimmed = value.trim();

    if (!trimmed) return;

    ui.inputBox.clearValue();
    ui.inputBox.focus();
    safeRender();

    if (trimmed.startsWith('/')) {
      await handleCommand(trimmed, state, ui);
    } else {
      await sendMessage(state, ui, trimmed);
    }
  });

  // Focus input by default
  ui.inputBox.focus();

  // Handle terminal resize (important for tmux) — debounce로 연속 resize 시 깜빡임 방지
  let resizeTimer: NodeJS.Timeout | null = null;
  process.stdout.on('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      ui.screen.alloc();
      ui.screen.realloc();
      safeRender();
    }, 50);
  });

  // Render
  safeRender();

  // Auto-refresh Projects/Tasks/Stuck tabs every 5s
  setInterval(() => {
    if (state.currentTab === 1) loadProjectsData(ui.projectsBox);
    if (state.currentTab === 2) loadTasksData(ui.tasksBox);
    if (state.currentTab === 3) loadStuckData(ui.stuckBox);
    safeRender();
  }, 5000);

  // System logs (example - hook into eventHub in real implementation)
  ui.logsBox.log('{gray-fg}System initialized{/gray-fg}');
}

// Auto-run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
