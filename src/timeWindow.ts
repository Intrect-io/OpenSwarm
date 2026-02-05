// ============================================
// Claude Swarm - Time Window Management
// 에이전트 작업 시간 제한 모듈
// ============================================

/**
 * 시간 범위 정의
 * format: "HH:MM" (24시간 형식, KST 기준)
 */
export interface TimeRange {
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
}

/**
 * 시간 윈도우 설정
 */
export interface TimeWindowConfig {
  /** 시간 제한 활성화 여부 */
  enabled: boolean;

  /** 허용된 작업 시간대 (OR 조건) */
  allowedWindows: TimeRange[];

  /** 차단된 시간대 (장중 등) - allowedWindows보다 우선 */
  blockedWindows: TimeRange[];

  /** 특정 요일만 제한 (0=일, 1=월, ..., 6=토) */
  restrictedDays?: number[];

  /** 타임존 (기본: Asia/Seoul) */
  timezone?: string;
}

/**
 * 기본 설정: 새벽 시간만 허용, 장중 차단
 */
export const DEFAULT_TIME_WINDOW: TimeWindowConfig = {
  enabled: true,
  // 새벽/야간 작업 허용: 18:30 ~ 08:00
  allowedWindows: [
    { start: '18:30', end: '23:59' },
    { start: '00:00', end: '08:00' },
  ],
  // 장중 시간 명시적 차단 (08:30 ~ 18:00)
  blockedWindows: [
    { start: '08:30', end: '18:00' },
  ],
  // 주중만 제한 (월~금)
  restrictedDays: [1, 2, 3, 4, 5],
  timezone: 'Asia/Seoul',
};

/**
 * 시간 문자열을 분 단위로 변환
 * "09:30" -> 570
 */
function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * 현재 시간이 특정 범위 내에 있는지 확인
 */
function isInTimeRange(currentMinutes: number, range: TimeRange): boolean {
  const start = timeToMinutes(range.start);
  const end = timeToMinutes(range.end);

  // 자정을 넘는 경우 (예: 22:00 ~ 06:00)
  if (start > end) {
    return currentMinutes >= start || currentMinutes <= end;
  }

  return currentMinutes >= start && currentMinutes <= end;
}

/**
 * 현재 KST 시간 가져오기
 */
function getKSTTime(): Date {
  const now = new Date();
  // UTC를 KST로 변환 (UTC+9)
  const kstOffset = 9 * 60; // 분 단위
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const kstMinutes = (utcMinutes + kstOffset) % (24 * 60);

  const kstDate = new Date(now);
  kstDate.setUTCHours(Math.floor(kstMinutes / 60), kstMinutes % 60, 0, 0);

  return kstDate;
}

/**
 * 현재 시간에 작업이 허용되는지 확인
 */
export function isWorkAllowed(config: TimeWindowConfig = DEFAULT_TIME_WINDOW): {
  allowed: boolean;
  reason: string;
  currentTime: string;
  nextAllowedTime?: string;
} {
  // 비활성화면 항상 허용
  if (!config.enabled) {
    return {
      allowed: true,
      reason: '시간 제한 비활성화',
      currentTime: formatCurrentTime(),
    };
  }

  const now = new Date();
  const kstOffset = 9 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const kstMinutes = (utcMinutes + kstOffset) % (24 * 60);

  // 요일 계산 (KST 기준)
  const kstHours = Math.floor(kstMinutes / 60);
  const dayOffset = kstHours < (now.getUTCHours()) ? 1 : 0;
  const kstDay = (now.getUTCDay() + (utcMinutes + kstOffset >= 24 * 60 ? 1 : 0)) % 7;

  const currentTimeStr = `${String(Math.floor(kstMinutes / 60)).padStart(2, '0')}:${String(kstMinutes % 60).padStart(2, '0')}`;

  // 요일 제한 확인
  if (config.restrictedDays && config.restrictedDays.length > 0) {
    if (!config.restrictedDays.includes(kstDay)) {
      return {
        allowed: true,
        reason: '주말/제한 없는 요일',
        currentTime: currentTimeStr,
      };
    }
  }

  // 차단 시간대 확인 (최우선)
  for (const blocked of config.blockedWindows) {
    if (isInTimeRange(kstMinutes, blocked)) {
      return {
        allowed: false,
        reason: `차단 시간대 (${blocked.start} ~ ${blocked.end})`,
        currentTime: currentTimeStr,
        nextAllowedTime: blocked.end,
      };
    }
  }

  // 허용 시간대 확인
  for (const allowed of config.allowedWindows) {
    if (isInTimeRange(kstMinutes, allowed)) {
      return {
        allowed: true,
        reason: `허용 시간대 (${allowed.start} ~ ${allowed.end})`,
        currentTime: currentTimeStr,
      };
    }
  }

  // 어떤 허용 시간대에도 속하지 않음
  const nextWindow = findNextAllowedWindow(kstMinutes, config.allowedWindows);
  return {
    allowed: false,
    reason: '허용 시간대 외',
    currentTime: currentTimeStr,
    nextAllowedTime: nextWindow,
  };
}

/**
 * 다음 허용 시간대 찾기
 */
function findNextAllowedWindow(currentMinutes: number, windows: TimeRange[]): string | undefined {
  // 현재 시간 이후의 가장 가까운 시작 시간 찾기
  let nearestStart: number | null = null;

  for (const window of windows) {
    const start = timeToMinutes(window.start);

    if (start > currentMinutes) {
      if (nearestStart === null || start < nearestStart) {
        nearestStart = start;
      }
    }
  }

  // 오늘 이후 시작 시간이 없으면 내일 첫 윈도우
  if (nearestStart === null && windows.length > 0) {
    nearestStart = timeToMinutes(windows[0].start);
    // "내일"을 표시하기 위해 +24시간 (표시용)
    return `내일 ${windows[0].start}`;
  }

  if (nearestStart !== null) {
    return `${String(Math.floor(nearestStart / 60)).padStart(2, '0')}:${String(nearestStart % 60).padStart(2, '0')}`;
  }

  return undefined;
}

/**
 * 현재 시간 포맷
 */
function formatCurrentTime(): string {
  const now = new Date();
  const kstOffset = 9 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const kstMinutes = (utcMinutes + kstOffset) % (24 * 60);

  return `${String(Math.floor(kstMinutes / 60)).padStart(2, '0')}:${String(kstMinutes % 60).padStart(2, '0')} KST`;
}

/**
 * 현재 시장 상태 반환
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

  // 장전 시간외: 08:30 ~ 09:00
  if (totalMinutes >= 510 && totalMinutes < 540) {
    return {
      status: 'pre_market',
      description: '장전 시간외 (08:30~09:00)',
      canWork: false,
    };
  }

  // 정규장: 09:00 ~ 15:30
  if (totalMinutes >= 540 && totalMinutes < 930) {
    return {
      status: 'regular',
      description: '정규장 (09:00~15:30)',
      canWork: false,
    };
  }

  // 장후 시간외: 15:40 ~ 18:00
  if (totalMinutes >= 940 && totalMinutes < 1080) {
    return {
      status: 'post_market',
      description: '장후 시간외 (15:40~18:00)',
      canWork: false,
    };
  }

  // 폐장
  return {
    status: 'closed',
    description: '폐장 (작업 가능)',
    canWork: true,
  };
}

/**
 * 작업 전 시간 확인 (가드 함수)
 * 차단 시 에러 throw
 */
export function assertWorkAllowed(taskName?: string): void {
  const result = isWorkAllowed();

  if (!result.allowed) {
    const msg = taskName
      ? `[TimeWindow] "${taskName}" 작업 차단: ${result.reason} (현재: ${result.currentTime})`
      : `[TimeWindow] 작업 차단: ${result.reason} (현재: ${result.currentTime})`;

    const nextTime = result.nextAllowedTime
      ? ` 다음 허용 시간: ${result.nextAllowedTime}`
      : '';

    throw new Error(msg + nextTime);
  }
}

/**
 * 시간 윈도우 상태 요약 (디스코드 보고용)
 */
export function getTimeWindowSummary(): string {
  const work = isWorkAllowed();
  const market = getMarketStatus();

  const icon = work.allowed ? '🟢' : '🔴';
  const status = work.allowed ? '작업 가능' : '작업 차단';

  return `${icon} **${status}**
현재: ${work.currentTime}
상태: ${market.description}
${!work.allowed && work.nextAllowedTime ? `다음 허용: ${work.nextAllowedTime}` : ''}`.trim();
}

/**
 * 설정을 외부에서 업데이트할 수 있도록
 */
let currentConfig: TimeWindowConfig = { ...DEFAULT_TIME_WINDOW };

export function setTimeWindowConfig(config: Partial<TimeWindowConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

export function getTimeWindowConfig(): TimeWindowConfig {
  return { ...currentConfig };
}

/**
 * isWorkAllowed를 현재 설정으로 실행
 */
export function checkWorkAllowed(): ReturnType<typeof isWorkAllowed> {
  return isWorkAllowed(currentConfig);
}
