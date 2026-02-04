// ============================================
// Claude Swarm - Dynamic Scheduler
// OpenClaw 아키텍처 기반 tmux pane 스케줄러
// ============================================

import { Cron } from 'croner';
import { resolve } from 'path';
import { homedir } from 'os';
import * as fs from 'fs/promises';
import * as tmux from './tmux.js';

// 스케줄 저장 경로
const SCHEDULE_DIR = resolve(homedir(), '.claude-swarm');
const SCHEDULE_FILE = resolve(SCHEDULE_DIR, 'schedules.json');

// 기본 tmux 세션 이름
const SWARM_SESSION = 'swarm';

// 스케줄 작업 인터페이스
export interface ScheduledJob {
  id: string;
  name: string;
  projectPath: string;
  prompt: string;
  schedule: string; // cron 표현식 또는 interval (예: "30m", "1h", "0 9 * * *")
  enabled: boolean;
  paneIndex?: number;
  createdAt: number;
  lastRun?: number;
  createdBy?: string; // Discord 사용자
}

// 실행 중인 cron 작업
const activeJobs: Map<string, Cron> = new Map();

// pane 할당 관리
const paneAssignments: Map<string, number> = new Map();
let nextPaneIndex = 0;

/**
 * 스케줄 파일 로드
 */
async function loadSchedules(): Promise<ScheduledJob[]> {
  try {
    await fs.mkdir(SCHEDULE_DIR, { recursive: true });
    const data = await fs.readFile(SCHEDULE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

/**
 * 스케줄 파일 저장
 */
async function saveSchedules(schedules: ScheduledJob[]): Promise<void> {
  await fs.mkdir(SCHEDULE_DIR, { recursive: true });
  await fs.writeFile(SCHEDULE_FILE, JSON.stringify(schedules, null, 2));
}

/**
 * interval 문자열을 cron 표현식으로 변환
 * 예: "30m" -> 매 30분, "1h" -> 매 1시간, "2h" -> 매 2시간
 */
function intervalToCron(interval: string): string {
  const match = interval.match(/^(\d+)(m|h|d)$/);
  if (!match) return interval; // 이미 cron 표현식이면 그대로 반환

  const [, value, unit] = match;
  const num = parseInt(value, 10);

  switch (unit) {
    case 'm':
      return `*/${num} * * * *`;
    case 'h':
      if (num === 1) return '0 * * * *';
      return `0 */${num} * * *`;
    case 'd':
      return `0 9 */${num} * *`; // 매일 9시
    default:
      return interval;
  }
}

/**
 * tmux swarm 세션 초기화
 */
export async function initSwarmSession(): Promise<void> {
  const exists = await tmux.sessionExists(SWARM_SESSION);
  if (!exists) {
    // 기본 세션 생성 (홈 디렉토리에서)
    await tmux.createSession(SWARM_SESSION, homedir());
    console.log(`[Scheduler] Created swarm session: ${SWARM_SESSION}`);
  }
}

/**
 * 프로젝트용 pane 생성 또는 가져오기
 */
async function getOrCreatePane(jobId: string, projectPath: string): Promise<string> {
  // 활성 윈도우 인덱스 조회
  const windowIndex = await tmux.getActiveWindowIndex(SWARM_SESSION);

  // 이미 할당된 pane이 있으면 반환
  if (paneAssignments.has(jobId)) {
    const paneIndex = paneAssignments.get(jobId)!;
    return `${SWARM_SESSION}:${windowIndex}.${paneIndex}`;
  }

  // 새 pane 생성
  const expandedPath = projectPath.replace('~', homedir());

  try {
    // 새 pane 분할 (수직)
    await tmux.execCommand(
      `tmux split-window -t "${SWARM_SESSION}:${windowIndex}" -v -c "${expandedPath}"`
    );

    // pane 레이아웃 정리
    await tmux.execCommand(`tmux select-layout -t "${SWARM_SESSION}:${windowIndex}" tiled`);

    // 현재 pane 수 확인
    const paneCount = await tmux.getPaneCount(SWARM_SESSION);
    const paneIndex = paneCount - 1;

    paneAssignments.set(jobId, paneIndex);
    console.log(`[Scheduler] Created pane ${windowIndex}.${paneIndex} for job ${jobId}`);

    return `${SWARM_SESSION}:${windowIndex}.${paneIndex}`;
  } catch (err) {
    console.error(`[Scheduler] Failed to create pane:`, err);
    // 실패 시 기본 pane 사용
    return `${SWARM_SESSION}:${windowIndex}.0`;
  }
}

/**
 * 스케줄 작업 실행
 */
async function runScheduledJob(job: ScheduledJob): Promise<void> {
  console.log(`[Scheduler] Running job: ${job.name}`);

  try {
    // pane 가져오기/생성
    const paneTarget = await getOrCreatePane(job.id, job.projectPath);

    // 프롬프트를 임시 파일에 저장
    const promptFile = resolve(SCHEDULE_DIR, `prompt-${job.id}.txt`);
    await fs.writeFile(promptFile, job.prompt);

    // Claude Code 실행 명령 전송 (bash 사용하여 glob 확장 방지)
    const expandedPath = job.projectPath.replace('~', homedir());
    // bash -c로 실행하여 zsh glob 문제 회피
    const command = `bash -c 'cd "${expandedPath}" && claude -p "$(cat ${promptFile})"'`;

    await tmux.sendKeysToPane(paneTarget, command);

    // 마지막 실행 시간 업데이트
    const schedules = await loadSchedules();
    const updated = schedules.map((s) =>
      s.id === job.id ? { ...s, lastRun: Date.now() } : s
    );
    await saveSchedules(updated);

    console.log(`[Scheduler] Job ${job.name} started in pane ${paneTarget}`);
  } catch (err) {
    console.error(`[Scheduler] Job ${job.name} failed:`, err);
  }
}

/**
 * 스케줄 작업 등록
 */
export async function addSchedule(
  name: string,
  projectPath: string,
  prompt: string,
  schedule: string,
  createdBy?: string
): Promise<ScheduledJob> {
  const schedules = await loadSchedules();

  // 중복 체크
  const existing = schedules.find((s) => s.name === name);
  if (existing) {
    throw new Error(`Schedule "${name}" already exists`);
  }

  const job: ScheduledJob = {
    id: `job-${Date.now()}`,
    name,
    projectPath,
    prompt,
    schedule,
    enabled: true,
    createdAt: Date.now(),
    createdBy,
  };

  schedules.push(job);
  await saveSchedules(schedules);

  // cron 작업 시작
  await startCronJob(job);

  console.log(`[Scheduler] Added schedule: ${name} (${schedule})`);
  return job;
}

/**
 * 스케줄 작업 삭제
 */
export async function removeSchedule(nameOrId: string): Promise<boolean> {
  const schedules = await loadSchedules();
  const index = schedules.findIndex((s) => s.name === nameOrId || s.id === nameOrId);

  if (index === -1) return false;

  const job = schedules[index];

  // cron 작업 중지
  const cron = activeJobs.get(job.id);
  if (cron) {
    cron.stop();
    activeJobs.delete(job.id);
  }

  // pane 할당 제거
  paneAssignments.delete(job.id);

  // 저장
  schedules.splice(index, 1);
  await saveSchedules(schedules);

  console.log(`[Scheduler] Removed schedule: ${job.name}`);
  return true;
}

/**
 * 스케줄 작업 일시 중지/재개
 */
export async function toggleSchedule(nameOrId: string): Promise<ScheduledJob | null> {
  const schedules = await loadSchedules();
  const job = schedules.find((s) => s.name === nameOrId || s.id === nameOrId);

  if (!job) return null;

  job.enabled = !job.enabled;
  await saveSchedules(schedules);

  // cron 작업 토글
  const cron = activeJobs.get(job.id);
  if (job.enabled && !cron) {
    await startCronJob(job);
  } else if (!job.enabled && cron) {
    cron.stop();
    activeJobs.delete(job.id);
  }

  console.log(`[Scheduler] ${job.enabled ? 'Enabled' : 'Disabled'} schedule: ${job.name}`);
  return job;
}

/**
 * cron 작업 시작
 */
async function startCronJob(job: ScheduledJob): Promise<void> {
  if (!job.enabled) return;

  const cronExpr = intervalToCron(job.schedule);

  try {
    const cron = new Cron(cronExpr, () => {
      void runScheduledJob(job).catch((err) => {
        console.error(`[Scheduler] Job ${job.name} error:`, err);
      });
    });

    activeJobs.set(job.id, cron);
    console.log(`[Scheduler] Started cron for ${job.name}: ${cronExpr}`);
  } catch (err) {
    console.error(`[Scheduler] Failed to start cron for ${job.name}:`, err);
  }
}

/**
 * 모든 스케줄 로드 및 시작
 */
export async function startAllSchedules(): Promise<void> {
  await initSwarmSession();

  const schedules = await loadSchedules();
  console.log(`[Scheduler] Loading ${schedules.length} schedules...`);

  for (const job of schedules) {
    if (job.enabled) {
      await startCronJob(job);
    }
  }
}

/**
 * 모든 스케줄 중지
 */
export function stopAllSchedules(): void {
  for (const [id, cron] of activeJobs) {
    cron.stop();
    console.log(`[Scheduler] Stopped cron: ${id}`);
  }
  activeJobs.clear();
}

/**
 * 스케줄 목록 조회
 */
export async function listSchedules(): Promise<ScheduledJob[]> {
  return loadSchedules();
}

/**
 * 즉시 실행
 */
export async function runNow(nameOrId: string): Promise<boolean> {
  const schedules = await loadSchedules();
  const job = schedules.find((s) => s.name === nameOrId || s.id === nameOrId);

  if (!job) return false;

  await runScheduledJob(job);
  return true;
}

/**
 * 자연어에서 스케줄 정보 파싱
 * 예: "StockAPI 30분마다 개발해줘" -> { name: "StockAPI", schedule: "30m", ... }
 */
export function parseScheduleFromNaturalLanguage(
  text: string
): { name?: string; schedule?: string; projectPath?: string; prompt?: string } | null {
  const result: { name?: string; schedule?: string; projectPath?: string; prompt?: string } = {};

  // 프로젝트 이름 추출 (첫 단어 또는 따옴표 안)
  const nameMatch = text.match(/["']([^"']+)["']|^(\S+)/);
  if (nameMatch) {
    result.name = nameMatch[1] || nameMatch[2];
  }

  // 주기 추출
  const intervalMatch = text.match(/(\d+)\s*(분|시간|일|min|hour|h|m|d)/i);
  if (intervalMatch) {
    const [, num, unit] = intervalMatch;
    const unitMap: Record<string, string> = {
      '분': 'm', 'min': 'm', 'm': 'm',
      '시간': 'h', 'hour': 'h', 'h': 'h',
      '일': 'd', 'd': 'd',
    };
    result.schedule = `${num}${unitMap[unit.toLowerCase()] || 'm'}`;
  }

  // 매일/매주 등
  if (text.includes('매일') || text.includes('daily')) {
    result.schedule = '0 9 * * *'; // 매일 9시
  }
  if (text.includes('매주') || text.includes('weekly')) {
    result.schedule = '0 9 * * 1'; // 매주 월요일 9시
  }

  // 작업 내용 추출
  const actionMatch = text.match(/(개발|작업|체크|확인|빌드|테스트|리뷰|보고)/);
  if (actionMatch) {
    result.prompt = text; // 전체 텍스트를 프롬프트로
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * 스케줄 정보를 포맷팅된 문자열로 반환
 */
export function formatScheduleList(schedules: ScheduledJob[]): string {
  if (schedules.length === 0) {
    return '등록된 스케줄이 없습니다.';
  }

  return schedules
    .map((s, i) => {
      const status = s.enabled ? '🟢' : '⏸️';
      const lastRun = s.lastRun ? new Date(s.lastRun).toLocaleString('ko-KR') : '없음';
      return `${i + 1}. ${status} **${s.name}**\n   📁 ${s.projectPath}\n   ⏰ ${s.schedule}\n   🕐 마지막 실행: ${lastRun}`;
    })
    .join('\n\n');
}
