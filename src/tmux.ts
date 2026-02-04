// ============================================
// Claude Swarm - Tmux Control
// ============================================

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * tmux 세션 목록 조회
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
 * tmux 세션 존재 여부 확인
 */
export async function sessionExists(sessionName: string): Promise<boolean> {
  const sessions = await listSessions();
  return sessions.includes(sessionName);
}

/**
 * tmux 세션에 명령 전송
 */
export async function sendKeys(sessionName: string, message: string): Promise<void> {
  // 특수 문자 이스케이프
  const escaped = message
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');

  await execAsync(`tmux send-keys -t "${sessionName}" "${escaped}" Enter`);
}

/**
 * tmux 세션 출력 캡처
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
 * Claude Code에 heartbeat 메시지 전송
 */
export async function sendHeartbeat(sessionName: string): Promise<void> {
  const message = `HEARTBEAT.md 체크리스트에 따라 작업 진행. Linear 이슈 확인하고 진행상황 업데이트해줘.`;
  await sendKeys(sessionName, message);
}

/**
 * Claude Code에 특정 작업 지시
 */
export async function sendTask(sessionName: string, task: string): Promise<void> {
  await sendKeys(sessionName, task);
}

/**
 * 세션 출력에서 중요 이벤트 파싱
 */
export function parseEvents(output: string): {
  type: 'completed' | 'failed' | 'blocked' | 'commit' | null;
  detail?: string;
}[] {
  const events: ReturnType<typeof parseEvents> = [];

  // TODO 완료 감지
  if (output.includes('✓') || output.includes('[x]') || output.includes('completed')) {
    const match = output.match(/(?:completed|done|finished):\s*(.+)/i);
    events.push({
      type: 'completed',
      detail: match?.[1]?.trim(),
    });
  }

  // 빌드/테스트 실패 감지
  if (output.includes('Build failed') || output.includes('error TS')) {
    events.push({ type: 'failed', detail: 'Build failed' });
  }
  if (output.includes('FAIL') || output.includes('Tests failed')) {
    events.push({ type: 'failed', detail: 'Tests failed' });
  }

  // 막힘 감지
  if (output.includes('BLOCKED') || output.includes('막힘') || output.includes('stuck')) {
    const match = output.match(/(?:BLOCKED|막힘|stuck):\s*(.+)/i);
    events.push({
      type: 'blocked',
      detail: match?.[1]?.trim(),
    });
  }

  // 커밋 감지
  const commitMatch = output.match(/git commit.*-m\s*["'](.+?)["']/);
  if (commitMatch) {
    events.push({ type: 'commit', detail: commitMatch[1] });
  }

  return events;
}

/**
 * 새 tmux 세션 생성 (Claude Code 실행)
 */
export async function createSession(
  sessionName: string,
  projectPath: string
): Promise<void> {
  await execAsync(
    `tmux new-session -d -s "${sessionName}" -c "${projectPath}" "claude"`
  );
}

/**
 * tmux 세션 종료
 */
export async function killSession(sessionName: string): Promise<void> {
  await execAsync(`tmux kill-session -t "${sessionName}"`);
}

/**
 * tmux 명령 직접 실행
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
 * 세션의 pane 개수 조회
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
 * 특정 pane에 명령 전송
 */
export async function sendKeysToPane(paneTarget: string, message: string): Promise<void> {
  // 특수 문자 이스케이프
  const escaped = message
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');

  await execAsync(`tmux send-keys -t "${paneTarget}" "${escaped}" Enter`);
}

/**
 * 특정 pane의 출력 캡처
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
 * pane 목록 조회 (세션:윈도우.pane 형식)
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
 * 새 pane 생성 (특정 디렉토리에서)
 */
export async function createPane(
  sessionName: string,
  workingDir: string,
  command?: string
): Promise<number> {
  const expandedDir = workingDir.replace('~', process.env.HOME || '');

  // 새 pane 분할
  if (command) {
    await execAsync(
      `tmux split-window -t "${sessionName}" -v -c "${expandedDir}" "${command}"`
    );
  } else {
    await execAsync(
      `tmux split-window -t "${sessionName}" -v -c "${expandedDir}"`
    );
  }

  // 레이아웃 정리
  await execAsync(`tmux select-layout -t "${sessionName}" tiled`);

  // 새로 생성된 pane 인덱스 반환
  return (await getPaneCount(sessionName)) - 1;
}

/**
 * pane 종료
 */
export async function killPane(paneTarget: string): Promise<void> {
  await execAsync(`tmux kill-pane -t "${paneTarget}"`);
}

/**
 * 세션의 활성 윈도우 인덱스 조회
 */
export async function getActiveWindowIndex(sessionName: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `tmux list-windows -t "${sessionName}" -F "#{window_index}:#{window_active}" | grep ":1$" | cut -d: -f1`
    );
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    // 실패 시 첫 번째 윈도우 인덱스 시도
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
