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

const DEFAULT_TIMEZONE = DEFAULT_TIME_WINDOW.timezone ?? 'Asia/Seoul';
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
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

function getCurrentTimeParts(timezone: string | undefined): {
  day: number;
  minutes: number;
  time: string;
  timezone: string;
} {
  const resolvedTimezone = timezone || DEFAULT_TIMEZONE;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: resolvedTimezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hours = Number(values.hour);
  const minutes = Number(values.minute);
  const day = WEEKDAY_INDEX[values.weekday];

  return {
    day,
    minutes: hours * 60 + minutes,
    time: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
    timezone: resolvedTimezone,
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
function formatCurrentTime(timezone: string | undefined): string {
  const current = getCurrentTimeParts(timezone);
  const label = current.timezone === 'Asia/Seoul' ? 'KST' : current.timezone;
  return `${current.time} ${label}`;
}

/**
 * Get current market status
 */
export function getMarketStatus(config: TimeWindowConfig = DEFAULT_TIME_WINDOW): {
  status: 'pre_market' | 'regular' | 'post_market' | 'closed';
  description: string;
  canWork: boolean;
} {
  const result = isWorkAllowed(config);
  const current = getCurrentTimeParts(config.timezone);
  const totalMinutes = current.minutes;

  if (config.restrictedDays && config.restrictedDays.length > 0 && !config.restrictedDays.includes(current.day)) {
    return {
      status: 'closed',
      description: t('timeWindow.marketStatus.closed'),
      canWork: result.allowed,
    };
  }

  // Pre-market hours: 08:30 ~ 09:00
  if (totalMinutes >= 510 && totalMinutes < 540) {
    return {
      status: 'pre_market',
      description: t('timeWindow.marketStatus.preMarket'),
      canWork: result.allowed,
    };
  }

  // Regular market hours: 09:00 ~ 15:30
  if (totalMinutes >= 540 && totalMinutes < 930) {
    return {
      status: 'regular',
      description: t('timeWindow.marketStatus.regular'),
      canWork: result.allowed,
    };
  }

  // Post-market hours: 15:40 ~ 18:00
  if (totalMinutes >= 940 && totalMinutes < 1080) {
    return {
      status: 'post_market',
      description: t('timeWindow.marketStatus.postMarket'),
      canWork: result.allowed,
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
  const config = getTimeWindowConfig();
  const work = isWorkAllowed(config);
  const market = getMarketStatus(config);

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
  const next = { ...currentConfig, ...config };
  const validRange = (range: TimeRange): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(range.start) && /^([01]\d|2[0-3]):[0-5]\d$/.test(range.end);
  if (!Array.isArray(next.allowedWindows) || !next.allowedWindows.every(validRange)) throw new Error('Invalid allowed time window');
  if (!Array.isArray(next.blockedWindows) || !next.blockedWindows.every(validRange)) throw new Error('Invalid blocked time window');
  if (next.restrictedDays && (!Array.isArray(next.restrictedDays) || next.restrictedDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) {
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
