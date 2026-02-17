// ============================================
// Claude Swarm - Pair Mode Metrics
// Success rate, average attempts, and duration tracking
// ============================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { t } from './locale/index.js';

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
  successRate: number;         // Approval rate (%)
  avgAttempts: number;         // Average attempt count
  avgDurationMs: number;       // Average duration (ms)
  avgFilesChanged: number;     // Average files changed
  firstAttemptSuccessRate: number; // First attempt success rate (%)
  lastUpdated: number;
}

export interface DailyMetrics {
  date: string;                // YYYY-MM-DD format
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

// In-memory cache
let recordsCache: PairSessionRecord[] = [];
let summaryCache: PairMetricsSummary | null = null;
let initialized = false;

/**
 * Ensure metrics directory exists
 */
async function ensureDir(): Promise<void> {
  try {
    await fs.mkdir(METRICS_DIR, { recursive: true });
  } catch {
    // Already exists
  }
}

/**
 * Load records
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
 * Save records
 */
async function saveRecords(): Promise<void> {
  await ensureDir();
  await fs.writeFile(RECORDS_FILE, JSON.stringify(recordsCache, null, 2));
}

/**
 * Save summary
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
 * Record session result
 */
export async function recordSession(record: PairSessionRecord): Promise<void> {
  await loadRecords();

  // Prevent duplicates
  const exists = recordsCache.some(r => r.sessionId === record.sessionId);
  if (!exists) {
    recordsCache.push(record);

    // Keep only the last 1000 records
    if (recordsCache.length > 1000) {
      recordsCache = recordsCache.slice(-1000);
    }

    await saveRecords();
    await updateSummary();
  }
}

/**
 * Update summary statistics
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
 * Get summary statistics
 */
export async function getSummary(): Promise<PairMetricsSummary> {
  if (!summaryCache) {
    await loadRecords();
    await updateSummary();
  }
  return summaryCache!;
}

/**
 * Get recent N sessions
 */
export async function getRecentSessions(limit: number = 10): Promise<PairSessionRecord[]> {
  const records = await loadRecords();
  return records.slice(-limit).reverse();
}

/**
 * Get daily metrics
 */
export async function getDailyMetrics(days: number = 7): Promise<DailyMetrics[]> {
  const records = await loadRecords();
  const now = Date.now();
  const cutoff = now - (days * 24 * 60 * 60 * 1000);

  // Group by date
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

  // Calculate daily metrics
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

  // Sort by date
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Format metrics (for Discord)
 */
export function formatMetricsSummary(summary: PairMetricsSummary): string {
  const avgDurationStr = summary.avgDurationMs < 60000
    ? t('common.duration.seconds', { n: Math.round(summary.avgDurationMs / 1000) })
    : t('common.duration.minutes', { n: Math.round(summary.avgDurationMs / 60000) });

  return [
    `📊 **${t('discord.pair.stats.title')}**`,
    '',
    t('discord.pair.stats.totalSessions', { n: summary.totalSessions }),
    `${t('discord.pair.stats.successRate', { n: summary.successRate })} (${summary.approved}/${summary.totalSessions})`,
    t('discord.pair.stats.firstAttemptRate', { n: summary.firstAttemptSuccessRate }),
    '',
    `✅ ${t('discord.pair.stats.approved', { n: summary.approved })}`,
    `❌ ${t('discord.pair.stats.rejected', { n: summary.rejected })}`,
    `💥 ${t('discord.pair.stats.failed', { n: summary.failed })}`,
    `🚫 ${t('discord.pair.stats.cancelled', { n: summary.cancelled })}`,
    '',
    t('discord.pair.stats.avgAttempts', { n: summary.avgAttempts }),
    t('discord.pair.stats.avgDuration', { duration: avgDurationStr }),
    t('discord.pair.stats.avgFiles', { n: summary.avgFilesChanged }),
  ].join('\n');
}

/**
 * Format daily metrics
 */
export function formatDailyMetrics(metrics: DailyMetrics[]): string {
  if (metrics.length === 0) {
    return t('discord.pair.stats.noData');
  }

  const lines = [`📅 **${t('discord.pair.stats.dailyTitle')}**`, ''];

  for (const day of metrics) {
    const successRate = day.sessions > 0
      ? Math.round((day.approved / day.sessions) * 100)
      : 0;
    lines.push(`**${day.date}**: ${day.sessions} (✅${day.approved} ❌${day.rejected} 💥${day.failed}) - ${successRate}%`);
  }

  return lines.join('\n');
}

/**
 * Reset metrics (for testing)
 */
export async function resetMetrics(): Promise<void> {
  recordsCache = [];
  summaryCache = null;
  initialized = false;
  await saveRecords();
  await updateSummary();
}
