#!/usr/bin/env tsx
// ============================================
// Claude Swarm - Interactive Chat CLI
// Interactive chat interface for CLI agent command center
// Backend: claude -p (Claude Code OAuth auth)
// ============================================

import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

// ============================================
// Constants
// ============================================

const CHAT_DIR = resolve(homedir(), '.claude-swarm', 'chat');
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

// ANSI
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

// ============================================
// Types
// ============================================

type Message = { role: 'user' | 'assistant'; content: string };

type Session = {
  id: string;
  model: string;
  messages: Message[];
  claudeSessionId?: string;
  createdAt: string;
  updatedAt: string;
};

// ============================================
// Claude CLI Backend
// ============================================

async function callClaude(
  prompt: string,
  model: string,
  sessionId?: string,
): Promise<{ response: string; sessionId: string; cost?: number }> {
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
    let cost: number | undefined;
    let headerPrinted = false;

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

          // Assistant response
          if (event.type === 'assistant' && event.message?.content) {
            if (!headerPrinted) {
              process.stdout.write(`\n${GREEN}${BOLD}assistant${RESET} `);
              headerPrinted = true;
            }
            for (const block of event.message.content) {
              if (block.type === 'text') {
                process.stdout.write(block.text);
                fullResponse += block.text;
              }
            }
          }

          // Result
          if (event.type === 'result') {
            cost = event.total_cost_usd;
            if (event.session_id) {
              capturedSessionId = event.session_id;
            }
          }
        } catch {
          // Ignore parse failures
        }
      }
    });

    proc.stderr.on('data', () => {
      // Ignore hook output etc.
    });

    proc.on('close', (code) => {
      if (headerPrinted && cost !== undefined) {
        process.stdout.write(`\n${DIM}($${cost.toFixed(4)})${RESET}`);
      }
      process.stdout.write('\n\n');

      if (code !== 0 && fullResponse === '') {
        reject(new Error(`claude exited with code ${code}`));
      } else {
        resolve({
          response: fullResponse,
          sessionId: capturedSessionId,
          cost,
        });
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.stdin.end();
  });
}

// ============================================
// Session Management
// ============================================

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
  return JSON.parse(await readFile(path, 'utf-8'));
}

async function listSessions(): Promise<string[]> {
  await ensureChatDir();
  const files = await readdir(CHAT_DIR);
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''));
}

function generateSessionId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

// ============================================
// Chat
// ============================================

async function chat(session: Session, userMessage: string): Promise<void> {
  session.messages.push({ role: 'user', content: userMessage });

  try {
    const result = await callClaude(
      userMessage,
      session.model,
      session.claudeSessionId,
    );

    if (result.sessionId) {
      session.claudeSessionId = result.sessionId;
    }

    if (result.response) {
      session.messages.push({ role: 'assistant', content: result.response });
    } else {
      session.messages.pop();
    }

    await saveSession(session);
  } catch (err: any) {
    console.error(`${RED}Error: ${err.message || err}${RESET}\n`);
    session.messages.pop();
  }
}

// ============================================
// Slash Commands
// ============================================

async function handleCommand(
  cmd: string,
  session: Session,
): Promise<'exit' | 'handled'> {
  const [command, ...args] = cmd.slice(1).split(' ');

  switch (command) {
    case 'exit':
    case 'quit':
    case 'q':
      await saveSession(session);
      return 'exit';

    case 'clear':
    case 'c':
      session.messages = [];
      session.claudeSessionId = undefined;
      console.log(`${GREEN}Conversation cleared.${RESET}`);
      return 'handled';

    case 'save': {
      const name = args[0] || session.id;
      session.id = name;
      await saveSession(session);
      console.log(`${GREEN}Saved: ${name}${RESET}`);
      return 'handled';
    }

    case 'load': {
      const name = args[0];
      if (!name) {
        const sessions = await listSessions();
        if (sessions.length === 0) {
          console.log(`${DIM}No saved sessions.${RESET}`);
        } else {
          console.log(`${BOLD}Sessions:${RESET}`);
          for (const s of sessions.slice(-10)) {
            const data = await loadSession(s);
            const msgCount = data?.messages.length ?? 0;
            const hasResume = data?.claudeSessionId ? ' (resumable)' : '';
            console.log(`  ${CYAN}${s}${RESET} ${msgCount} msgs${hasResume}`);
          }
        }
        return 'handled';
      }
      const loaded = await loadSession(name);
      if (!loaded) {
        console.log(`${RED}Not found: ${name}${RESET}`);
        return 'handled';
      }
      Object.assign(session, loaded);
      console.log(`${GREEN}Loaded: ${name} (${loaded.messages.length} msgs)${RESET}`);
      return 'handled';
    }

    case 'model': {
      const newModel = args[0];
      if (!newModel) {
        console.log(`${BOLD}Model:${RESET} ${session.model}`);
        console.log(`${DIM}  sonnet → claude-sonnet-4-5-20250929${RESET}`);
        console.log(`${DIM}  haiku  → claude-haiku-4-5-20251001${RESET}`);
        console.log(`${DIM}  opus   → claude-opus-4-6${RESET}`);
        return 'handled';
      }
      const aliases: Record<string, string> = {
        sonnet: 'claude-sonnet-4-5-20250929',
        haiku: 'claude-haiku-4-5-20251001',
        opus: 'claude-opus-4-6',
      };
      session.model = aliases[newModel] || newModel;
      // Reset claude session on model change
      session.claudeSessionId = undefined;
      console.log(`${GREEN}Model: ${session.model}${RESET}`);
      return 'handled';
    }

    case 'info':
    case 'status': {
      console.log(`${BOLD}Session:${RESET} ${session.id}`);
      console.log(`${BOLD}Model:${RESET} ${session.model}`);
      console.log(`${BOLD}Messages:${RESET} ${session.messages.length}`);
      console.log(`${BOLD}Claude session:${RESET} ${session.claudeSessionId ? 'active' : 'none'}`);
      return 'handled';
    }

    case 'help':
    case 'h':
    case '?':
      console.log(`
${BOLD}Commands:${RESET}
  ${CYAN}/clear${RESET}          대화 초기화
  ${CYAN}/save [name]${RESET}    세션 저장
  ${CYAN}/load [name]${RESET}    세션 목록/로드
  ${CYAN}/model [id]${RESET}     모델 변경 (sonnet/haiku/opus)
  ${CYAN}/info${RESET}           세션 정보
  ${CYAN}/exit${RESET}           종료 (Ctrl+D)

${BOLD}Multiline:${RESET}  ${CYAN}"""${RESET} 시작 → ${CYAN}"""${RESET} 종료
`);
      return 'handled';

    default:
      console.log(`${RED}Unknown: /${command}${RESET} (/help)`);
      return 'handled';
  }
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  // Check if claude CLI exists
  try {
    const { execSync } = await import('node:child_process');
    execSync('which claude', { stdio: 'pipe' });
  } catch {
    console.error(`${RED}claude CLI not found.${RESET}`);
    console.error(`${DIM}npm i -g @anthropic-ai/claude-code${RESET}`);
    process.exit(1);
  }

  // Initialize session
  const loadArg = process.argv[2];
  let session: Session;

  if (loadArg && loadArg !== '--') {
    const loaded = await loadSession(loadArg);
    if (loaded) {
      session = loaded;
      console.log(`${GREEN}Resumed: ${loadArg} (${loaded.messages.length} msgs)${RESET}`);
    } else {
      session = {
        id: loadArg,
        model: DEFAULT_MODEL,
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  } else {
    session = {
      id: generateSessionId(),
      model: DEFAULT_MODEL,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  // Header
  const shortModel = session.model.replace('claude-', '').replace(/-\d{8}$/, '');
  console.log(`${BOLD}╔════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║${RESET}  Swarm Chat  ${DIM}${shortModel}${RESET}`);
  console.log(`${BOLD}╚════════════════════════════════════╝${RESET}`);
  console.log(`${DIM}${session.id} | /help | Ctrl+D exit${RESET}\n`);

  // REPL
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  rl.on('SIGINT', () => process.stdout.write('\n'));

  const prompt = `${CYAN}${BOLD}you${RESET} `;

  while (true) {
    let input: string;
    try {
      input = await rl.question(prompt);
    } catch {
      break;
    }

    const trimmed = input.trim();
    if (!trimmed) continue;

    // Multiline
    if (trimmed === '"""' || trimmed === "'''") {
      const delim = trimmed;
      const lines: string[] = [];
      console.log(`${DIM}(multiline — ${delim} to end)${RESET}`);
      while (true) {
        let line: string;
        try { line = await rl.question(`${DIM}...${RESET} `); }
        catch { break; }
        if (line.trim() === delim) break;
        lines.push(line);
      }
      if (lines.length > 0) await chat(session, lines.join('\n'));
      continue;
    }

    // Commands
    if (trimmed.startsWith('/')) {
      if (await handleCommand(trimmed, session) === 'exit') break;
      continue;
    }

    await chat(session, trimmed);
  }

  await saveSession(session);
  console.log(`\n${DIM}Saved: ${session.id}${RESET}`);
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`${RED}Fatal: ${err.message || err}${RESET}`);
  process.exit(1);
});
