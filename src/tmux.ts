// ============================================
// Claude Swarm - Tmux Control
// ============================================

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * List tmux sessions
 */
export async function listSessions(): Promise<string[]> {
  try {
    const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}"');
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if tmux session exists
 */
export async function sessionExists(sessionName: string): Promise<boolean> {
  const sessions = await listSessions();
  return sessions.includes(sessionName);
}

/**
 * Send keys to tmux session
 */
export async function sendKeys(sessionName: string, message: string): Promise<void> {
  // Escape special characters
  const escaped = message
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');

  await execAsync(`tmux send-keys -t "${sessionName}" "${escaped}" Enter`);
}

/**
 * Capture tmux session output
 */
export async function capturePane(
  sessionName: string,
  lines: number = 50
): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `tmux capture-pane -t "${sessionName}" -p -S -${lines}`
    );
    return stdout;
  } catch (err) {
    console.error(`Failed to capture pane for ${sessionName}:`, err);
    return '';
  }
}

/**
 * Send heartbeat message to Claude Code
 */
export async function sendHeartbeat(sessionName: string): Promise<void> {
  const message = `HEARTBEAT.md 체크리스트에 따라 작업 진행. Linear 이슈 확인하고 진행상황 업데이트해줘.`;
  await sendKeys(sessionName, message);
}

/**
 * Send specific task to Claude Code
 */
export async function sendTask(sessionName: string, task: string): Promise<void> {
  await sendKeys(sessionName, task);
}

/**
 * Parse important events from session output
 */
export function parseEvents(output: string): {
  type: 'completed' | 'failed' | 'blocked' | 'commit' | null;
  detail?: string;
}[] {
  const events: ReturnType<typeof parseEvents> = [];

  // Detect TODO completion
  if (output.includes('✓') || output.includes('[x]') || output.includes('completed')) {
    const match = output.match(/(?:completed|done|finished):\s*(.+)/i);
    events.push({
      type: 'completed',
      detail: match?.[1]?.trim(),
    });
  }

  // Detect build/test failure
  if (output.includes('Build failed') || output.includes('error TS')) {
    events.push({ type: 'failed', detail: 'Build failed' });
  }
  if (output.includes('FAIL') || output.includes('Tests failed')) {
    events.push({ type: 'failed', detail: 'Tests failed' });
  }

  // Detect blocked/stuck state
  if (output.includes('BLOCKED') || output.includes('막힘') || output.includes('stuck')) {
    const match = output.match(/(?:BLOCKED|막힘|stuck):\s*(.+)/i);
    events.push({
      type: 'blocked',
      detail: match?.[1]?.trim(),
    });
  }

  // Detect git commit
  const commitMatch = output.match(/git commit.*-m\s*["'](.+?)["']/);
  if (commitMatch) {
    events.push({ type: 'commit', detail: commitMatch[1] });
  }

  return events;
}

/**
 * Create new tmux session (with Claude Code)
 */
export async function createSession(
  sessionName: string,
  projectPath: string
): Promise<void> {
  await execAsync(
    `tmux new-session -d -s "${sessionName}" -c "${projectPath}" "claude --dangerously-skip-permissions"`
  );
}

/**
 * Kill tmux session
 */
export async function killSession(sessionName: string): Promise<void> {
  await execAsync(`tmux kill-session -t "${sessionName}"`);
}

/**
 * Execute tmux command directly
 */
export async function execCommand(command: string): Promise<string> {
  try {
    const { stdout } = await execAsync(command);
    return stdout;
  } catch (err) {
    console.error(`tmux command failed: ${command}`, err);
    throw err;
  }
}

/**
 * Get pane count for session
 */
export async function getPaneCount(sessionName: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `tmux list-panes -t "${sessionName}" | wc -l`
    );
    return parseInt(stdout.trim(), 10);
  } catch {
    return 1;
  }
}

/**
 * Send keys to specific pane
 */
export async function sendKeysToPane(paneTarget: string, message: string): Promise<void> {
  // Escape special characters
  const escaped = message
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');

  await execAsync(`tmux send-keys -t "${paneTarget}" "${escaped}" Enter`);
}

/**
 * Capture output from specific pane
 */
export async function capturePaneOutput(
  paneTarget: string,
  lines: number = 50
): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `tmux capture-pane -t "${paneTarget}" -p -S -${lines}`
    );
    return stdout;
  } catch (err) {
    console.error(`Failed to capture pane ${paneTarget}:`, err);
    return '';
  }
}

/**
 * List panes (session:window.pane format)
 */
export async function listPanes(sessionName: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync(
      `tmux list-panes -t "${sessionName}" -F "#{pane_index}:#{pane_current_path}"`
    );
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Create new pane (in specified directory)
 */
export async function createPane(
  sessionName: string,
  workingDir: string,
  command?: string
): Promise<number> {
  const expandedDir = workingDir.replace('~', process.env.HOME || '');

  // Split new pane
  if (command) {
    await execAsync(
      `tmux split-window -t "${sessionName}" -v -c "${expandedDir}" "${command}"`
    );
  } else {
    await execAsync(
      `tmux split-window -t "${sessionName}" -v -c "${expandedDir}"`
    );
  }

  // Arrange layout
  await execAsync(`tmux select-layout -t "${sessionName}" tiled`);

  // Return newly created pane index
  return (await getPaneCount(sessionName)) - 1;
}

/**
 * Kill pane
 */
export async function killPane(paneTarget: string): Promise<void> {
  await execAsync(`tmux kill-pane -t "${paneTarget}"`);
}

/**
 * Get active window index for session
 */
export async function getActiveWindowIndex(sessionName: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `tmux list-windows -t "${sessionName}" -F "#{window_index}:#{window_active}" | grep ":1$" | cut -d: -f1`
    );
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    // On failure, try first window index
    try {
      const { stdout } = await execAsync(
        `tmux list-windows -t "${sessionName}" -F "#{window_index}" | head -1`
      );
      return parseInt(stdout.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }
}
