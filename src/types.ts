// ============================================
// Claude Swarm - Type Definitions
// ============================================

/**
 * 에이전트 세션 설정
 */
export type AgentSession = {
  /** tmux 세션 이름 */
  name: string;
  /** 프로젝트 경로 */
  projectPath: string;
  /** Heartbeat 간격 (ms) */
  heartbeatInterval: number;
  /** Linear 프로젝트/팀 라벨 */
  linearLabel?: string;
  /** 활성화 여부 */
  enabled: boolean;
  /** 일시 중지 여부 */
  paused: boolean;
};

/**
 * 에이전트 상태
 */
export type AgentStatus = {
  name: string;
  /** 현재 작업 중인 Linear 이슈 */
  currentIssue?: {
    id: string;
    identifier: string;
    title: string;
  };
  /** 마지막 heartbeat 시간 */
  lastHeartbeat?: number;
  /** 마지막 보고 내용 */
  lastReport?: string;
  /** 상태 */
  state: 'idle' | 'working' | 'blocked' | 'paused';
};

/**
 * Linear 프로젝트 정보
 */
export type LinearProjectInfo = {
  id: string;
  name: string;
  icon?: string;
  color?: string;
};

/**
 * Linear 이슈 간략 정보
 */
export type LinearIssueInfo = {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state: string;
  priority: number;
  labels: string[];
  comments: LinearComment[];
  /** Linear 프로젝트 정보 */
  project?: LinearProjectInfo;
};

/**
 * Linear 코멘트
 */
export type LinearComment = {
  id: string;
  body: string;
  createdAt: string;
  user?: string;
};

/**
 * Discord 이벤트 (보고용)
 */
export type SwarmEvent = {
  type: 'issue_started' | 'issue_completed' | 'issue_blocked' | 'build_failed' | 'test_failed' | 'commit' | 'error' | 'ci_failed' | 'github_notification';
  session: string;
  message: string;
  issueId?: string;
  timestamp: number;
  url?: string;
};

/**
 * 전역 설정
 */
export type SwarmConfig = {
  /** Discord bot token */
  discordToken: string;
  /** Discord 채널 ID (보고용) */
  discordChannelId: string;
  /** Discord Webhook URL (선택적) */
  discordWebhookUrl?: string;
  /** Linear API 키 */
  linearApiKey: string;
  /** Linear 팀 ID */
  linearTeamId: string;
  /** 에이전트 세션 목록 */
  agents: AgentSession[];
  /** 기본 heartbeat 간격 (ms) */
  defaultHeartbeatInterval: number;
  /** GitHub 레포 목록 (CI 모니터링용) */
  githubRepos?: string[];
  /** GitHub CI 체크 간격 (ms) */
  githubCheckInterval?: number;
  /** 시간 윈도우 설정 (에이전트 자율 작업 제한) */
  timeWindow?: TimeWindowConfig;
};

/**
 * 서비스 상태
 */
export type ServiceState = {
  running: boolean;
  startedAt?: number;
  agents: Map<string, AgentStatus>;
  timers: Map<string, NodeJS.Timeout>;
};

/**
 * 시간 범위
 */
export type TimeRange = {
  start: string; // "HH:MM" (24시간 형식)
  end: string;
};

/**
 * 시간 윈도우 설정
 */
export type TimeWindowConfig = {
  /** 시간 제한 활성화 여부 */
  enabled: boolean;
  /** 허용된 작업 시간대 */
  allowedWindows: TimeRange[];
  /** 차단된 시간대 (장중 등) */
  blockedWindows: TimeRange[];
  /** 제한 적용 요일 (0=일, 1=월, ..., 6=토) */
  restrictedDays?: number[];
  /** 타임존 */
  timezone?: string;
};
