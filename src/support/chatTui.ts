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
    let lastStreamTime = Date.now();

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
                lastStreamTime = Date.now();
              }
            }
          }

          // Extract cost and tokens from result
          if (event.type === 'result') {
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
      if (code !== 0 && fullResponse === '') {
        reject(new Error(`claude exited with code ${code}`));
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

  // Color palette - Claude Code inspired
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

  // Status bar (top) - Claude Code style
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

  // Tab bar - sleek design
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

  // Projects tab - matching style
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

  // Tasks tab
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

  // Logs tab
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

  // Help bar (bottom) - subtle
  const helpBar = blessed.box({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: ' {#718096-fg}Tab{/} Switch  {#718096-fg}Enter{/} Send  {#718096-fg}Shift+Enter{/} Newline  {#718096-fg}Esc{/} Clear  {#718096-fg}Ctrl+C{/} Exit  {#718096-fg}/help{/} Commands',
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
    { key: '4', name: 'Logs', icon: '📝' },
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

  // Hide all content boxes
  ui.chatLog.hide();
  ui.projectsBox.hide();
  ui.tasksBox.hide();
  ui.logsBox.hide();

  // Show selected tab
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
      ui.logsBox.show();
      break;
  }

  updateTabBar(ui, tabIndex);
  ui.screen.render();
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
    const response = await fetch('http://127.0.0.1:3847/api/tasks');
    const { running, queued } = await response.json() as {
      running: Array<{ id?: string; description?: string }>;
      queued: Array<{ id?: string; description?: string }>;
    };

    if (running.length === 0 && queued.length === 0) {
      box.setContent('\n{center}{#718096-fg}No active tasks{/}{/center}');
      return;
    }

    const lines: string[] = [''];

    if (running.length > 0) {
      lines.push(`  {#34d399-fg}{bold}Running{/bold} {#718096-fg}(${running.length}){/}{/}`);
      lines.push('');
      for (const t of running) {
        const desc = t.description || t.id || '{#718096-fg}(no description){/}';
        lines.push(`    {#34d399-fg}▸{/} ${desc}`);
      }
      lines.push('');
    }

    if (queued.length > 0) {
      lines.push(`  {#f59e0b-fg}{bold}Queued{/bold} {#718096-fg}(${queued.length}){/}{/}`);
      lines.push('');
      for (const t of queued) {
        const desc = t.description || t.id || '{#718096-fg}(no description){/}';
        lines.push(`    {#718096-fg}•{/} ${desc}`);
      }
      lines.push('');
    }

    box.setContent(lines.join('\n'));
  } catch (err) {
    box.setContent(`\n{center}{#ef4444-fg}Failed to load tasks{/}\n{#718096-fg}${err}{/}{/center}`);
  }
}
// Loading Spinner (inline in chat)
function startSpinner(ui: ReturnType<typeof createUI>): { interval: NodeJS.Timeout; lineIndex: number } {
  let frameIndex = 0;
  const loadingMessage = LOADING_MESSAGES[Math.floor(Math.random() * LOADING_MESSAGES.length)];

  // Add spinner line to chat
  const lines = ui.chatLog.getLines();
  const lineIndex = lines.length;

  const interval = setInterval(() => {
    const spinner = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
    const content = `  {#667eea-fg}${spinner}{/} {#718096-fg}${loadingMessage}...{/}`;
    ui.chatLog.setLine(lineIndex, content);
    ui.chatLog.setScrollPerc(100);
    ui.screen.render();
    frameIndex++;
  }, 80);

  return { interval, lineIndex };
}

function stopSpinner(
  ui: ReturnType<typeof createUI>,
  spinnerData: { interval: NodeJS.Timeout; lineIndex: number }
): void {
  clearInterval(spinnerData.interval);
  // Remove spinner line
  ui.chatLog.deleteLine(spinnerData.lineIndex);
  ui.screen.render();
}
// Chat Logic
async function sendMessage(state: AppState, ui: ReturnType<typeof createUI>, message: string) {
  if (!message.trim()) return;

  // Display user message - Claude Code style
  ui.chatLog.log('');
  ui.chatLog.log(`{#60a5fa-fg}{bold}▸ You{/bold}{/}`);
  ui.chatLog.log(`  ${message}`);
  ui.chatLog.log('');
  ui.chatLog.setScrollPerc(100);
  ui.screen.render();

  state.session.messages.push({ role: 'user', content: message });

  // Prepare assistant message placeholder
  ui.chatLog.log(`{#34d399-fg}{bold}▸ Assistant{/bold}{/}`);
  const assistantHeaderLine = ui.chatLog.getLines().length - 1;
  let assistantContent = '';
  let lastRenderTime = 0;
  let spinnerStopped = false;
  let contentStartLine = assistantHeaderLine + 1;

  // Start spinner
  const spinnerData = startSpinner(ui);

  try {
    const result = await callClaude(
      message,
      state.session.model,
      state.session.claudeSessionId,
      (chunk) => {
        // Stop spinner on first chunk
        if (!spinnerStopped) {
          stopSpinner(ui, spinnerData);
          spinnerStopped = true;
        }

        assistantContent += chunk;
        // Throttle rendering for smoother streaming (30fps)
        const now = Date.now();
        if (now - lastRenderTime < 33) return;
        lastRenderTime = now;

        // Clear previous content lines
        const currentLines = ui.chatLog.getLines().length;
        for (let i = contentStartLine; i < currentLines; i++) {
          ui.chatLog.deleteLine(contentStartLine);
        }

        // Add updated content line by line with proper empty line handling
        const contentLines = assistantContent.split('\n');
        for (const line of contentLines) {
          // Always add line, even if empty (preserves paragraph breaks)
          ui.chatLog.log(line ? `  ${line}` : '  ');
        }

        ui.chatLog.setScrollPerc(100);
        ui.screen.render();
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
    // Clear streaming content first
    const currentLines = ui.chatLog.getLines().length;
    for (let i = contentStartLine; i < currentLines; i++) {
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
    ui.screen.render();
  } catch (err) {
    if (!spinnerStopped) {
      stopSpinner(ui, spinnerData);
    }
    const msg = err instanceof Error ? err.message : String(err);
    ui.chatLog.log(`{#ef4444-fg}{bold}✗ Error{/bold}{/}`);
    ui.chatLog.log(`  ${msg}`);
    ui.chatLog.log('');
    state.session.messages.pop(); // Remove user message on failure
    ui.screen.render();
  }
}
// Status Bar Update
function updateStatusBar(state: AppState, ui: ReturnType<typeof createUI>) {
  const modelShort = state.session.model.replace('claude-', '').replace(/-\d{8}$/, '');
  const cost = state.session.totalCost > 0 ? `$${state.session.totalCost.toFixed(4)}` : '$0.00';
  const msgs = state.session.messages.length;

  // Claude Code inspired status bar
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
      ui.screen.render();
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
      ui.screen.render();
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
      ui.screen.render();
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
      ui.chatLog.log('    {#718096-fg}Ctrl+C{/}         Exit and save');
      ui.chatLog.log('');
      ui.screen.render();
      break;

    default:
      ui.chatLog.log('');
      ui.chatLog.log(`  {#ef4444-fg}Unknown command: /{bold}${command}{/bold}{/}`);
      ui.chatLog.log(`  {#718096-fg}Type {/}{#60a5fa-fg}/help{/}{#718096-fg} for available commands{/}`);
      ui.chatLog.log('');
      ui.screen.render();
  }

  return false;
}
// Main
export async function main(): Promise<void> {
  // Initialize session
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

  // Initial status
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
  ui.screen.key(['tab'], () => {
    const next = (state.currentTab + 1) % 4;
    switchTab(state, ui, next);
  });
  ui.screen.key(['S-tab'], () => {
    const prev = (state.currentTab - 1 + 4) % 4;
    switchTab(state, ui, prev);
  });

  // Ctrl+C: Clear input or exit (Claude Code style)
  ui.screen.key(['C-c'], async () => {
    const currentValue = ui.inputBox.getValue();
    if (currentValue && currentValue.trim()) {
      // If input has text, just clear it
      ui.inputBox.clearValue();
      ui.inputBox.focus();
      ui.screen.render();
    } else {
      // If input is empty, exit
      await saveSession(state.session);
      process.exit(0);
    }
  });

  // Escape: Clear input
  ui.screen.key(['escape'], () => {
    ui.inputBox.clearValue();
    ui.inputBox.focus();
    ui.screen.render();
  });

  // Shift+Enter: Insert newline (handled by textarea by default)
  // Enter: Submit message
  ui.inputBox.key(['enter'], async () => {
    const value = ui.inputBox.getValue();
    const trimmed = value.trim();

    if (!trimmed) return;

    ui.inputBox.clearValue();
    ui.inputBox.focus();
    ui.screen.render();

    if (trimmed.startsWith('/')) {
      await handleCommand(trimmed, state, ui);
    } else {
      await sendMessage(state, ui, trimmed);
    }
  });

  // For backward compatibility with blessed events
  ui.inputBox.on('submit', async (_value: string) => {
    // This is now handled by the Enter key handler above
    // Keep this for compatibility but do nothing
  });

  // Focus input by default
  ui.inputBox.focus();

  // Handle terminal resize (important for tmux)
  process.stdout.on('resize', () => {
    ui.screen.alloc();
    ui.screen.realloc();
    ui.screen.render();
  });

  // Render
  ui.screen.render();

  // Auto-refresh Projects/Tasks tabs every 5s
  setInterval(() => {
    if (state.currentTab === 1) loadProjectsData(ui.projectsBox);
    if (state.currentTab === 2) loadTasksData(ui.tasksBox);
    ui.screen.render();
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
