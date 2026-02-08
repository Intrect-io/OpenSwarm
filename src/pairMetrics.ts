// ============================================
// Claude Swarm - Pair Mode Metrics
// 성공률, 평균 시도 횟수, 소요 시간 추적
// ============================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

// ============================================
// Types
// ============================================

export interface PairSessionRecord {
  sessionId: string;
  taskId: string;
  taskTitle: string;
  result: 'approved' | 'rejected' | 'failed' | 'cancelled';
  attempts: number;
  maxAttempts: number;
  durationMs: number;
  filesChanged: number;
  startedAt: number;
  finishedAt: number;
}

export interface PairMetricsSummary {
  totalSessions: number;
  approved: number;
  rejected: number;
  failed: number;
  cancelled: number;
  successRate: number;         // 승인된 비율 (%)
  avgAttempts: number;         // 평균 시도 횟수
  avgDurationMs: number;       // 평균 소요 시간 (ms)
  avgFilesChanged: number;     // 평균 변경 파일 수
  firstAttemptSuccessRate: number; // 첫 시도 성공률 (%)
  lastUpdated: number;
}

export interface DailyMetrics {
  date: string;                // YYYY-MM-DD
  sessions: number;
  approved: number;
  rejected: number;
  failed: number;
  avgAttempts: number;
  avgDurationMs: number;
}

// ============================================
// Storage
// ============================================

const METRICS_DIR = path.join(homedir(), '.claude-swarm', 'metrics');
const RECORDS_FILE = path.join(METRICS_DIR, 'pair-records.json');
const SUMMARY_FILE = path.join(METRICS_DIR, 'pair-summary.json');

// 메모리 캐시
let recordsCache: PairSessionRecord[] = [];
let summaryCache: PairMetricsSummary | null = null;
let initialized = false;

/**
 * 메트릭 디렉토리 초기화
 */
async function ensureDir(): Promise<void> {
  try {
    await fs.mkdir(METRICS_DIR, { recursive: true });
  } catch {
    // 이미 존재
  }
}

/**
 * 레코드 로드
 */
async function loadRecords(): Promise<PairSessionRecord[]> {
  if (!initialized) {
    await ensureDir();
    try {
      const data = await fs.readFile(RECORDS_FILE, 'utf-8');
      recordsCache = JSON.parse(data);
    } catch {
      recordsCache = [];
    }
    initialized = true;
  }
  return recordsCache;
}

/**
 * 레코드 저장
 */
async function saveRecords(): Promise<void> {
  await ensureDir();
  await fs.writeFile(RECORDS_FILE, JSON.stringify(recordsCache, null, 2));
}

/**
 * 요약 저장
 */
async function saveSummary(): Promise<void> {
  if (summaryCache) {
    await fs.writeFile(SUMMARY_FILE, JSON.stringify(summaryCache, null, 2));
  }
}

// ============================================
// Public API
// ============================================

/**
 * 세션 결과 기록
 */
export async function recordSession(record: PairSessionRecord): Promise<void> {
  await loadRecords();

  // 중복 방지
  const exists = recordsCache.some(r => r.sessionId === record.sessionId);
  if (!exists) {
    recordsCache.push(record);

    // 최근 1000개만 유지
    if (recordsCache.length > 1000) {
      recordsCache = recordsCache.slice(-1000);
    }

    await saveRecords();
    await updateSummary();
  }
}

/**
 * 요약 통계 업데이트
 */
async function updateSummary(): Promise<void> {
  const records = await loadRecords();

  if (records.length === 0) {
    summaryCache = {
      totalSessions: 0,
      approved: 0,
      rejected: 0,
      failed: 0,
      cancelled: 0,
      successRate: 0,
      avgAttempts: 0,
      avgDurationMs: 0,
      avgFilesChanged: 0,
      firstAttemptSuccessRate: 0,
      lastUpdated: Date.now(),
    };
    await saveSummary();
    return;
  }

  const approved = records.filter(r => r.result === 'approved');
  const rejected = records.filter(r => r.result === 'rejected');
  const failed = records.filter(r => r.result === 'failed');
  const cancelled = records.filter(r => r.result === 'cancelled');

  const totalAttempts = records.reduce((sum, r) => sum + r.attempts, 0);
  const totalDuration = records.reduce((sum, r) => sum + r.durationMs, 0);
  const totalFiles = records.reduce((sum, r) => sum + r.filesChanged, 0);
  const firstAttemptSuccess = approved.filter(r => r.attempts === 1).length;

  summaryCache = {
    totalSessions: records.length,
    approved: approved.length,
    rejected: rejected.length,
    failed: failed.length,
    cancelled: cancelled.length,
    successRate: Math.round((approved.length / records.length) * 100),
    avgAttempts: Math.round((totalAttempts / records.length) * 10) / 10,
    avgDurationMs: Math.round(totalDuration / records.length),
    avgFilesChanged: Math.round((totalFiles / records.length) * 10) / 10,
    firstAttemptSuccessRate: approved.length > 0
      ? Math.round((firstAttemptSuccess / approved.length) * 100)
      : 0,
    lastUpdated: Date.now(),
  };

  await saveSummary();
}

/**
 * 요약 통계 조회
 */
export async function getSummary(): Promise<PairMetricsSummary> {
  if (!summaryCache) {
    await loadRecords();
    await updateSummary();
  }
  return summaryCache!;
}

/**
 * 최근 N개 세션 조회
 */
export async function getRecentSessions(limit: number = 10): Promise<PairSessionRecord[]> {
  const records = await loadRecords();
  return records.slice(-limit).reverse();
}

/**
 * 일별 메트릭 조회
 */
export async function getDailyMetrics(days: number = 7): Promise<DailyMetrics[]> {
  const records = await loadRecords();
  const now = Date.now();
  const cutoff = now - (days * 24 * 60 * 60 * 1000);

  // 날짜별로 그룹화
  const byDate = new Map<string, PairSessionRecord[]>();

  for (const record of records) {
    if (record.finishedAt >= cutoff) {
      const date = new Date(record.finishedAt).toISOString().slice(0, 10);
      if (!byDate.has(date)) {
        byDate.set(date, []);
      }
      byDate.get(date)!.push(record);
    }
  }

  // 일별 메트릭 계산
  const result: DailyMetrics[] = [];

  for (const [date, dayRecords] of byDate) {
    const approved = dayRecords.filter(r => r.result === 'approved').length;
    const rejected = dayRecords.filter(r => r.result === 'rejected').length;
    const failed = dayRecords.filter(r => r.result === 'failed').length;
    const totalAttempts = dayRecords.reduce((sum, r) => sum + r.attempts, 0);
    const totalDuration = dayRecords.reduce((sum, r) => sum + r.durationMs, 0);

    result.push({
      date,
      sessions: dayRecords.length,
      approved,
      rejected,
      failed,
      avgAttempts: Math.round((totalAttempts / dayRecords.length) * 10) / 10,
      avgDurationMs: Math.round(totalDuration / dayRecords.length),
    });
  }

  // 날짜순 정렬
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 메트릭 포맷팅 (Discord용)
 */
export function formatMetricsSummary(summary: PairMetricsSummary): string {
  const avgDurationStr = summary.avgDurationMs < 60000
    ? `${Math.round(summary.avgDurationMs / 1000)}초`
    : `${Math.round(summary.avgDurationMs / 60000)}분`;

  return [
    '📊 **페어 모드 통계**',
    '',
    `**총 세션:** ${summary.totalSessions}개`,
    `**성공률:** ${summary.successRate}% (${summary.approved}/${summary.totalSessions})`,
    `**첫 시도 성공률:** ${summary.firstAttemptSuccessRate}%`,
    '',
    `✅ 승인: ${summary.approved}`,
    `❌ 거부: ${summary.rejected}`,
    `💥 실패: ${summary.failed}`,
    `🚫 취소: ${summary.cancelled}`,
    '',
    `**평균 시도:** ${summary.avgAttempts}회`,
    `**평균 소요 시간:** ${avgDurationStr}`,
    `**평균 변경 파일:** ${summary.avgFilesChanged}개`,
  ].join('\n');
}

/**
 * 일별 메트릭 포맷팅
 */
export function formatDailyMetrics(metrics: DailyMetrics[]): string {
  if (metrics.length === 0) {
    return '(최근 7일간 데이터 없음)';
  }

  const lines = ['📅 **일별 통계**', ''];

  for (const day of metrics) {
    const successRate = day.sessions > 0
      ? Math.round((day.approved / day.sessions) * 100)
      : 0;
    lines.push(`**${day.date}**: ${day.sessions}개 (✅${day.approved} ❌${day.rejected} 💥${day.failed}) - ${successRate}%`);
  }

  return lines.join('\n');
}

/**
 * 메트릭 초기화 (테스트용)
 */
export async function resetMetrics(): Promise<void> {
  recordsCache = [];
  summaryCache = null;
  initialized = false;
  await saveRecords();
  await updateSummary();
}
