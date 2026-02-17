// ============================================
// Claude Swarm - Time Window Management
// Agent work time restriction module
// ============================================

import { t } from './locale/index.js';

/**
 * Time range definition
 * format: "HH:MM" (24-hour format, KST)
 */
export interface TimeRange {
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
}

/**
 * Time window configuration
 */
export interface TimeWindowConfig {
  /** Whether time restrictions are enabled */
  enabled: boolean;

  /** Allowed work time ranges (OR condition) */
  allowedWindows: TimeRange[];

  /** Blocked time ranges (e.g. market hours) - takes priority over allowedWindows */
  blockedWindows: TimeRange[];

  /** Restricted days only (0=Sun, 1=Mon, ..., 6=Sat) */
  restrictedDays?: number[];

  /** Timezone (default: Asia/Seoul) */
  timezone?: string;
}

/**
 * Default config: allow only off-hours, block during market hours
 */
export const DEFAULT_TIME_WINDOW: TimeWindowConfig = {
  enabled: true,
  // Allow evening/night work: 18:30 ~ 08:00
  allowedWindows: [
    { start: '18:30', end: '23:59' },
    { start: '00:00', end: '08:00' },
  ],
  // Explicitly block market hours (08:30 ~ 18:00)
  blockedWindows: [
    { start: '08:30', end: '18:00' },
  ],
  // Restrict weekdays only (Mon-Fri)
  restrictedDays: [1, 2, 3, 4, 5],
  timezone: 'Asia/Seoul',
};

/**
 * Convert time string to minutes
 * "09:30" -> 570
 */
function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Check if current time is within a specific range
 */
function isInTimeRange(currentMinutes: number, range: TimeRange): boolean {
  const start = timeToMinutes(range.start);
  const end = timeToMinutes(range.end);

  // Handle midnight crossing (e.g. 22:00 ~ 06:00)
  if (start > end) {
    return currentMinutes >= start || currentMinutes <= end;
  }

  return currentMinutes >= start && currentMinutes <= end;
}

/**
 * Get current KST time
 */
function _getKSTTime(): Date {
  const now = new Date();
  // Convert UTC to KST (UTC+9)
  const kstOffset = 9 * 60; // in minutes
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const kstMinutes = (utcMinutes + kstOffset) % (24 * 60);

  const kstDate = new Date(now);
  kstDate.setUTCHours(Math.floor(kstMinutes / 60), kstMinutes % 60, 0, 0);

  return kstDate;
}

/**
 * Check if work is allowed at the current time
 */
export function isWorkAllowed(config: TimeWindowConfig = DEFAULT_TIME_WINDOW): {
  allowed: boolean;
  reason: string;
  currentTime: string;
  nextAllowedTime?: string;
} {
  // Always allow if disabled
  if (!config.enabled) {
    return {
      allowed: true,
      reason: t('timeWindow.disabled'),
      currentTime: formatCurrentTime(),
    };
  }

  const now = new Date();
  const kstOffset = 9 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const kstMinutes = (utcMinutes + kstOffset) % (24 * 60);

  // Calculate day of week (KST-based)
  // Calculate day of week (KST-based)
  const kstDay = (now.getUTCDay() + (utcMinutes + kstOffset >= 24 * 60 ? 1 : 0)) % 7;

  const currentTimeStr = `${String(Math.floor(kstMinutes / 60)).padStart(2, '0')}:${String(kstMinutes % 60).padStart(2, '0')}`;

  // Check day-of-week restrictions
  if (config.restrictedDays && config.restrictedDays.length > 0) {
    if (!config.restrictedDays.includes(kstDay)) {
      return {
        allowed: true,
        reason: t('timeWindow.weekendOrUnrestricted'),
        currentTime: currentTimeStr,
      };
    }
  }

  // Check blocked time ranges (highest priority)
  for (const blocked of config.blockedWindows) {
    if (isInTimeRange(kstMinutes, blocked)) {
      return {
        allowed: false,
        reason: t('timeWindow.blockedWindow', { start: blocked.start, end: blocked.end }),
        currentTime: currentTimeStr,
        nextAllowedTime: blocked.end,
      };
    }
  }

  // Check allowed time ranges
  for (const allowed of config.allowedWindows) {
    if (isInTimeRange(kstMinutes, allowed)) {
      return {
        allowed: true,
        reason: t('timeWindow.allowedWindow', { start: allowed.start, end: allowed.end }),
        currentTime: currentTimeStr,
      };
    }
  }

  // Not in any allowed time range
  const nextWindow = findNextAllowedWindow(kstMinutes, config.allowedWindows);
  return {
    allowed: false,
    reason: t('timeWindow.outsideAllowed'),
    currentTime: currentTimeStr,
    nextAllowedTime: nextWindow,
  };
}

/**
 * Find next allowed time window
 */
function findNextAllowedWindow(currentMinutes: number, windows: TimeRange[]): string | undefined {
  // Find the nearest start time after current time
  let nearestStart: number | null = null;

  for (const window of windows) {
    const start = timeToMinutes(window.start);

    if (start > currentMinutes) {
      if (nearestStart === null || start < nearestStart) {
        nearestStart = start;
      }
    }
  }

  // If no start time after today, use tomorrow's first window
  if (nearestStart === null && windows.length > 0) {
    nearestStart = timeToMinutes(windows[0].start);
    // Indicate "tomorrow" with +24h (display only)
    return t('timeWindow.tomorrowAt', { time: windows[0].start });
  }

  if (nearestStart !== null) {
    return `${String(Math.floor(nearestStart / 60)).padStart(2, '0')}:${String(nearestStart % 60).padStart(2, '0')}`;
  }

  return undefined;
}

/**
 * Format current time
 */
function formatCurrentTime(): string {
  const now = new Date();
  const kstOffset = 9 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const kstMinutes = (utcMinutes + kstOffset) % (24 * 60);

  return `${String(Math.floor(kstMinutes / 60)).padStart(2, '0')}:${String(kstMinutes % 60).padStart(2, '0')} KST`;
}

/**
 * Get current market status
 */
export function getMarketStatus(): {
  status: 'pre_market' | 'regular' | 'post_market' | 'closed';
  description: string;
  canWork: boolean;
} {
  const result = isWorkAllowed();
  const time = result.currentTime;
  const [hours, minutes] = time.split(':').map(Number);
  const totalMinutes = hours * 60 + minutes;

  // Pre-market hours: 08:30 ~ 09:00
  if (totalMinutes >= 510 && totalMinutes < 540) {
    return {
      status: 'pre_market',
      description: t('timeWindow.marketStatus.preMarket'),
      canWork: false,
    };
  }

  // Regular market hours: 09:00 ~ 15:30
  if (totalMinutes >= 540 && totalMinutes < 930) {
    return {
      status: 'regular',
      description: t('timeWindow.marketStatus.regular'),
      canWork: false,
    };
  }

  // Post-market hours: 15:40 ~ 18:00
  if (totalMinutes >= 940 && totalMinutes < 1080) {
    return {
      status: 'post_market',
      description: t('timeWindow.marketStatus.postMarket'),
      canWork: false,
    };
  }

  // Market closed
  return {
    status: 'closed',
    description: t('timeWindow.marketStatus.closed'),
    canWork: true,
  };
}

/**
 * Pre-work time check (guard function)
 * Throws error if blocked
 */
export function assertWorkAllowed(taskName?: string): void {
  const result = isWorkAllowed();

  if (!result.allowed) {
    const msg = taskName
      ? t('timeWindow.taskBlocked', { task: taskName, reason: result.reason, time: result.currentTime })
      : t('timeWindow.taskBlockedNoName', { reason: result.reason, time: result.currentTime });

    const nextTime = result.nextAllowedTime
      ? t('timeWindow.nextAllowedTime', { time: result.nextAllowedTime })
      : '';

    throw new Error(msg + nextTime);
  }
}

/**
 * Time window status summary (for Discord reporting)
 */
export function getTimeWindowSummary(): string {
  const work = isWorkAllowed();
  const market = getMarketStatus();

  const icon = work.allowed ? '🟢' : '🔴';
  const status = work.allowed ? t('timeWindow.workAllowed') : t('timeWindow.workBlocked');

  return `${icon} **${status}**
${t('timeWindow.currentTime', { time: work.currentTime })}
${t('timeWindow.status', { description: market.description })}
${!work.allowed && work.nextAllowedTime ? t('timeWindow.nextAllowed', { time: work.nextAllowedTime }) : ''}`.trim();
}

/**
 * Allow external configuration updates
 */
let currentConfig: TimeWindowConfig = { ...DEFAULT_TIME_WINDOW };

export function setTimeWindowConfig(config: Partial<TimeWindowConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

export function getTimeWindowConfig(): TimeWindowConfig {
  return { ...currentConfig };
}

/**
 * Run isWorkAllowed with current configuration
 */
export function checkWorkAllowed(): ReturnType<typeof isWorkAllowed> {
  return isWorkAllowed(currentConfig);
}
