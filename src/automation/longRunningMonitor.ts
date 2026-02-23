// ============================================
// OpenSwarm - Long-Running Task Monitor
// 외부 장기 작업(RunPod 학습, 배치 처리 등) 상태 추적
// ============================================

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  LongRunningMonitorConfig,
  LongRunningMonitor,
  MonitorState,
  CompletionCheck,
} from '../core/types.js';
import { broadcastEvent } from '../core/eventHub.js';

// ============================================
// Constants
// ============================================

const PERSIST_FILE = join(homedir(), '.claude', 'openswarm-monitors.json');
const CHECK_TIMEOUT_MS = 30_000; // 개별 체크 명령어 타임아웃 30초

// ============================================
// State
// ============================================

const monitors = new Map<string, LongRunningMonitor>();

// ============================================
// Persistence
// ============================================

interface PersistedData {
  monitors: LongRunningMonitor[];
  updatedAt: string;
}

function loadFromDisk(): void {
  try {
    if (!existsSync(PERSIST_FILE)) return;
    const data = JSON.parse(readFileSync(PERSIST_FILE, 'utf-8')) as PersistedData;
    for (const m of data.monitors) {
      // pending/running만 복원 (completed/failed/timeout은 이미 종료)
      if (m.state === 'pending' || m.state === 'running') {
        monitors.set(m.id, m);
      }
    }
    if (monitors.size > 0) {
      console.log(`[Monitor] Restored ${monitors.size} monitors from disk`);
    }
  } catch (err) {
    console.warn('[Monitor] Failed to load persisted monitors:', err);
  }
}

function saveToDisk(): void {
  try {
    const active = Array.from(monitors.values()).filter(
      m => m.state === 'pending' || m.state === 'running'
    );
    const data: PersistedData = {
      monitors: active,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(PERSIST_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn('[Monitor] Failed to save monitors to disk:', err);
  }
}

// ============================================
// Check Execution
// ============================================

function executeCheck(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = execFile('bash', ['-c', command], {
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        exitCode: error?.code !== undefined
          ? (typeof error.code === 'number' ? error.code : 1)
          : proc.exitCode ?? 0,
        stdout: (stdout ?? '').trim(),
        stderr: (stderr ?? '').trim(),
      });
    });
  });
}

// ============================================
// Result Evaluation
// ============================================

function evaluateResult(
  check: CompletionCheck,
  exitCode: number,
  stdout: string,
): MonitorState {
  switch (check.type) {
    case 'exit-code': {
      const successCode = check.successExitCode ?? 0;
      // exit 0(또는 successExitCode) = still running, 그 외 = completed
      return exitCode === successCode ? 'running' : 'completed';
    }

    case 'output-regex': {
      if (check.failurePattern && new RegExp(check.failurePattern).test(stdout)) {
        return 'failed';
      }
      if (new RegExp(check.successPattern).test(stdout)) {
        return 'completed';
      }
      return 'running';
    }

    case 'http-status': {
      const expected = check.expectedStatus ?? 200;
      // stdout에서 HTTP 상태 코드 추출 시도
      const statusMatch = stdout.match(/(\d{3})/);
      if (exitCode === 0 && statusMatch && Number(statusMatch[1]) === expected) {
        return 'completed';
      }
      return exitCode === 0 ? 'running' : 'failed';
    }
  }
}

// ============================================
// State Transition Handler
// ============================================

function handleStateTransition(
  monitor: LongRunningMonitor,
  prevState: MonitorState,
): void {
  if (prevState === monitor.state) return;

  console.log(`[Monitor] ${monitor.name}: ${prevState} → ${monitor.state}`);

  broadcastEvent({
    type: 'monitor:stateChange',
    data: {
      id: monitor.id,
      name: monitor.name,
      from: prevState,
      to: monitor.state,
      issueId: monitor.issueId,
    },
  });

  saveToDisk();
}

// ============================================
// Public API
// ============================================

/**
 * 서비스 시작 시 config + 영속 파일에서 모니터 로드
 */
export function initMonitors(configs?: LongRunningMonitorConfig[]): void {
  // 영속 파일에서 먼저 복원
  loadFromDisk();

  // config.yaml에 정의된 모니터 등록 (이미 존재하면 스킵)
  if (configs) {
    for (const cfg of configs) {
      if (!monitors.has(cfg.id)) {
        registerMonitor(cfg);
      }
    }
  }

  console.log(`[Monitor] Initialized with ${monitors.size} monitor(s)`);
}

/**
 * 모니터 등록
 */
export function registerMonitor(config: LongRunningMonitorConfig): LongRunningMonitor {
  const monitor: LongRunningMonitor = {
    ...config,
    checkInterval: config.checkInterval ?? 1,
    maxDurationHours: config.maxDurationHours ?? 48,
    notify: config.notify ?? true,
    state: 'pending',
    registeredAt: Date.now(),
    checkCount: 0,
    heartbeatsSinceRegister: 0,
  };

  monitors.set(monitor.id, monitor);
  saveToDisk();

  console.log(`[Monitor] Registered: ${monitor.name} (${monitor.id})`);
  broadcastEvent({
    type: 'monitor:stateChange',
    data: { id: monitor.id, name: monitor.name, from: 'pending', to: 'pending', issueId: monitor.issueId },
  });

  return monitor;
}

/**
 * 모니터 제거
 */
export function unregisterMonitor(id: string): boolean {
  const deleted = monitors.delete(id);
  if (deleted) {
    saveToDisk();
    console.log(`[Monitor] Unregistered: ${id}`);
  }
  return deleted;
}

/**
 * 모든 활성 모니터 체크 (heartbeat에서 호출)
 */
export async function checkAllMonitors(): Promise<number> {
  const active = Array.from(monitors.values()).filter(
    m => m.state === 'pending' || m.state === 'running'
  );

  if (active.length === 0) return 0;

  let checkedCount = 0;

  for (const monitor of active) {
    monitor.heartbeatsSinceRegister++;

    // checkInterval에 따른 스킵
    if (monitor.heartbeatsSinceRegister % monitor.checkInterval! !== 0) {
      continue;
    }

    // 타임아웃 체크
    const elapsedHours = (Date.now() - monitor.registeredAt) / (1000 * 60 * 60);
    if (elapsedHours > monitor.maxDurationHours!) {
      const prevState = monitor.state;
      monitor.state = 'timeout';
      handleStateTransition(monitor, prevState);
      continue;
    }

    try {
      const result = await executeCheck(monitor.checkCommand);
      const prevState = monitor.state;

      monitor.lastCheckedAt = Date.now();
      monitor.checkCount++;
      monitor.lastOutput = result.stdout.slice(0, 1000); // 최대 1KB
      monitor.lastExitCode = result.exitCode;

      const newState = evaluateResult(monitor.completionCheck, result.exitCode, result.stdout);

      // pending → running 자동 전이 (첫 체크 시)
      if (monitor.state === 'pending' && newState === 'running') {
        monitor.state = 'running';
      } else if (newState === 'completed' || newState === 'failed') {
        monitor.state = newState;
      }

      handleStateTransition(monitor, prevState);

      broadcastEvent({
        type: 'monitor:checked',
        data: {
          id: monitor.id,
          name: monitor.name,
          state: monitor.state,
          output: monitor.lastOutput,
          checkCount: monitor.checkCount,
        },
      });

      checkedCount++;
    } catch (err) {
      console.error(`[Monitor] Check failed for ${monitor.name}:`, err);
    }
  }

  if (checkedCount > 0) {
    saveToDisk();
  }

  return checkedCount;
}

/**
 * 활성 모니터 목록
 */
export function getActiveMonitors(): LongRunningMonitor[] {
  return Array.from(monitors.values());
}

/**
 * 특정 모니터 조회
 */
export function getMonitor(id: string): LongRunningMonitor | undefined {
  return monitors.get(id);
}
