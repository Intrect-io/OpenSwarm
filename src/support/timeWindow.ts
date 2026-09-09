// ============================================
// OpenSwarm - Time Window Management
// Agent work time restriction module
// ============================================

import { t } from '../locale/index.js';

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

const DEFAULT_TIMEZONE = 'Asia/Seoul';

/**
 * Convert time string to minutes from midnight
 */
export function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Check if current time is within a time range
 * Handles overnight ranges (e.g., 22:00 ~ 06:00)
 */
export function isInTimeRange(currentMinutes: number, range: TimeRange): boolean {
  const start = timeToMinutes(range.start);
  const end = timeToMinutes(range.end);

  if (start <= end) {
    // Normal range (e.g., 08:00 ~ 18:00)
    return currentMinutes >= start && currentMinutes < end;
  } else {
    // Overnight range (e.g., 22:00 ~ 06:00)
    return currentMinutes >= start || currentMinutes < end;
  }
}

/**
 * Get current time in KST (Asia/Seoul)
 * @deprecated Use getCurrentTimeParts with explicit timezone
 */
export function _getKSTTime(): Date {
  const now = new Date();
  const kstOffset = 9 * 60; // KST is UTC+9
  const localOffset = now.getTimezoneOffset();
  const diff = kstOffset + localOffset;
  return new Date(now.getTime() + diff * 60 * 1000);
}

/**
 * Get current time parts (day of week, minutes from midnight, formatted time)
 */
export function getCurrentTimeParts(timezone: string | undefined): {
  day: number;
  minutes: number;
  time: string;
} {
  const tz = timezone || DEFAULT_TIMEZONE;
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const dayMap: Record<string, number> = {
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  };
  let day = 0;
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === 'weekday') day = dayMap[p.value.toLowerCase()] ?? 0;
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  return {
    day,
    minutes: hour * 60 + minute,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
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
      currentTime: formatCurrentTime(config.timezone),
    };
  }

  const current = getCurrentTimeParts(config.timezone);
  const currentMinutes = current.minutes;
  const currentDay = current.day;
  const currentTimeStr = current.time;

  // Check day-of-week restrictions
  if (config.restrictedDays && config.restrictedDays.length > 0) {
    if (!config.restrictedDays.includes(currentDay)) {
      return {
        allowed: true,
        reason: t('timeWindow.weekendOrUnrestricted'),
        currentTime: currentTimeStr,
      };
    }
  }

  // Check blocked time ranges (highest priority)
  for (const blocked of config.blockedWindows) {
    if (isInTimeRange(currentMinutes, blocked)) {
      return {
        allowed: false,
        reason: t('timeWindow.blockedWindow', { start: blocked.start, end: blocked.end }),
        currentTime: currentTimeStr,
        nextAllowedTime: findNextAllowedWindow(currentDay, currentMinutes, config),
      };
    }
  }

  // Check allowed time ranges
  for (const allowed of config.allowedWindows) {
    if (isInTimeRange(currentMinutes, allowed)) {
      return {
        allowed: true,
        reason: t('timeWindow.allowedWindow', { start: allowed.start, end: allowed.end }),
        currentTime: currentTimeStr,
      };
    }
  }

  // Not in any allowed time range
  const nextWindow = findNextAllowedWindow(currentDay, currentMinutes, config);
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
function findNextAllowedWindow(currentDay: number, currentMinutes: number, config: TimeWindowConfig): string | undefined {
  // Evaluate the effective policy minute-by-minute for one full week. Merely
  // returning the next allowed-window start was wrong when that start was also
  // blocked or landed on a restricted day.
  for (let offset = 1; offset <= 7 * 24 * 60; offset++) {
    const absolute = currentMinutes + offset;
    const dayOffset = Math.floor(absolute / (24 * 60));
    const minute = absolute % (24 * 60);
    const day = (currentDay + dayOffset) % 7;
    const restrictionsApply = !config.restrictedDays?.length || config.restrictedDays.includes(day);
    const blocked = restrictionsApply && config.blockedWindows.some((range) => isInTimeRange(minute, range));
    const allowed = !restrictionsApply || (!blocked && config.allowedWindows.some((range) => isInTimeRange(minute, range)));
    if (!allowed) continue;

    const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    if (dayOffset === 0) return time;
    if (dayOffset === 1) return t('timeWindow.tomorrowAt', { time });
    return `+${dayOffset}d ${time}`;
  }
  return undefined;
}

/**
 * Format current time
 */
export function formatCurrentTime(timezone: string | undefined): string {
  const parts = getCurrentTimeParts(timezone);
  return parts.time;
}

/**
 * Get market status
 */
export function getMarketStatus(config: TimeWindowConfig = DEFAULT_TIME_WINDOW): {
  status: 'open' | 'closed';
  description: string;
  canWork: boolean;
} {
  const result = isWorkAllowed(config);

  if (result.allowed) {
    return {
      status: 'open',
      description: t('timeWindow.marketStatus.open'),
      canWork: true,
    };
  }

  // Market closed
  return {
    status: 'closed',
    description: t('timeWindow.marketStatus.closed'),
    canWork: result.allowed,
  };
}

/**
 * Pre-work time check (guard function)
 * Throws error if blocked
 */
export function assertWorkAllowed(taskName?: string): void {
  const result = isWorkAllowed(currentConfig);

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
 * Get time window summary
 */
export function getTimeWindowSummary(): string {
  const config = currentConfig;
  if (!config.enabled) {
    return t('timeWindow.summaryDisabled');
  }

  const result = isWorkAllowed(config);
  const lines: string[] = [];

  lines.push(t('timeWindow.summaryHeader', { timezone: config.timezone || DEFAULT_TIMEZONE }));
  lines.push(t('timeWindow.currentStatus', { status: result.allowed ? '✅' : '❌', time: result.currentTime }));

  if (config.allowedWindows.length > 0) {
    const windows = config.allowedWindows.map(w => `${w.start}-${w.end}`).join(', ');
    lines.push(t('timeWindow.allowedWindows', { windows }));
  }

  if (config.blockedWindows.length > 0) {
    const blocked = config.blockedWindows.map(w => `${w.start}-${w.end}`).join(', ');
    lines.push(t('timeWindow.blockedWindows', { windows: blocked }));
  }

  if (config.restrictedDays && config.restrictedDays.length > 0) {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const days = config.restrictedDays.map(d => dayNames[d]).join(', ');
    lines.push(t('timeWindow.restrictedDays', { days }));
  }

  if (!result.allowed && result.nextAllowedTime) {
    lines.push(t('timeWindow.nextAllowedTime', { time: result.nextAllowedTime }));
  }

  return lines.join('\n');
}

// Mutable active configuration (initialised from DEFAULT)
let currentConfig: TimeWindowConfig = { ...DEFAULT_TIME_WINDOW };

/**
 * Update the active time-window configuration.
 * Validates before applying.
 */
export function setTimeWindowConfig(config: Partial<TimeWindowConfig>): void {
  const next: TimeWindowConfig = { ...currentConfig, ...config };
  // Validate ranges
  for (const w of [...(next.allowedWindows || []), ...(next.blockedWindows || [])]) {
    if (!/^\d{2}:\d{2}$/.test(w.start) || !/^\d{2}:\d{2}$/.test(w.end)) {
      throw new Error(`Invalid time format: ${w.start}-${w.end}`);
    }
  }
  if (next.restrictedDays && (next.restrictedDays.length > 7 ||
    next.restrictedDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) {
    throw new Error('restrictedDays must contain integers from 0 to 6');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: next.timezone || DEFAULT_TIMEZONE });
  } catch {
    throw new Error(`Invalid timezone: ${next.timezone}`);
  }
  currentConfig = next;
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