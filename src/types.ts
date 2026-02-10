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
  type: 'issue_started' | 'issue_completed' | 'issue_blocked' | 'build_failed' | 'test_failed' | 'commit' | 'error' | 'ci_failed' | 'ci_recovered' | 'github_notification' | 'pr_improved' | 'pr_failed';
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
  /** Worker/Reviewer 페어 모드 설정 */
  pairMode?: PairModeConfig;
  /** 자율 실행 모드 설정 */
  autonomous?: AutonomousStartupConfig;
  /** PR Auto-Improvement 설정 */
  prProcessor?: PRProcessorConfig;
};

/**
 * PR 자동 개선 설정
 */
export type PRProcessorConfig = {
  /** 활성화 */
  enabled: boolean;
  /** 체크 스케줄 (cron) */
  schedule: string;
  /** 처리 후 쿨다운 (시간) */
  cooldownHours: number;
  /** Worker-Reviewer 최대 반복 횟수 */
  maxIterations: number;
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

/**
 * Worker/Reviewer 페어 모드 설정
 */
export type PairModeConfig = {
  /** 페어 모드 활성화 */
  enabled: boolean;
  /** Worker 최대 시도 횟수 */
  maxAttempts: number;
  /** Worker 타임아웃 (ms) */
  workerTimeoutMs: number;
  /** Reviewer 타임아웃 (ms) */
  reviewerTimeoutMs: number;
  /** Webhook URL (완료/실패 시 알림) */
  webhookUrl?: string;
  /** 자동 Linear 상태 업데이트 */
  autoLinearUpdate: boolean;
};

/**
 * 모델 설정
 */
export type ModelConfig = {
  /** Worker 에이전트 모델 */
  worker: string;
  /** Reviewer 에이전트 모델 */
  reviewer: string;
};

/**
 * 역할별 설정
 */
export type RoleConfig = {
  /** 역할 활성화 여부 */
  enabled: boolean;
  /** 모델 ID */
  model: string;
  /** 타임아웃 (ms), 0 = 무제한 */
  timeoutMs: number;
};

/**
 * 파이프라인 스테이지
 */
export type PipelineStage = 'worker' | 'reviewer' | 'tester' | 'documenter';

/**
 * 프로젝트별 에이전트 설정
 */
export type ProjectAgentConfig = {
  /** 프로젝트 경로 */
  projectPath: string;
  /** Linear 프로젝트 ID (선택) */
  linearProjectId?: string;
  /** 역할별 설정 오버라이드 */
  roles?: {
    worker?: Partial<RoleConfig>;
    reviewer?: Partial<RoleConfig>;
    tester?: Partial<RoleConfig>;
    documenter?: Partial<RoleConfig>;
  };
};

/**
 * 기본 역할 설정
 */
export type DefaultRolesConfig = {
  worker: RoleConfig;
  reviewer: RoleConfig;
  tester?: RoleConfig;
  documenter?: RoleConfig;
};

/**
 * 작업 분해(Planner) 설정
 */
export type DecompositionConfig = {
  /** 분해 활성화 */
  enabled: boolean;
  /** 분해 기준 시간 (분) - 이 시간 초과 예상 작업은 분해 */
  thresholdMinutes: number;
  /** Planner 모델 */
  plannerModel: string;
};

/**
 * 자율 실행 모드 설정
 */
export type AutonomousStartupConfig = {
  /** 서비스 시작 시 자동 활성화 */
  enabled: boolean;
  /** Worker/Reviewer 페어 모드 사용 */
  pairMode: boolean;
  /** 실행 스케줄 (cron 표현식) */
  schedule: string;
  /** 페어 모드 최대 시도 횟수 */
  maxAttempts: number;
  /** 허용된 프로젝트 경로 */
  allowedProjects: string[];
  /** 모델 설정 (레거시) */
  models?: ModelConfig;
  /** Worker 타임아웃 (ms), 0 = 무제한 (레거시) */
  workerTimeoutMs?: number;
  /** Reviewer 타임아웃 (ms), 0 = 무제한 (레거시) */
  reviewerTimeoutMs?: number;
  /** 동시 실행 가능한 최대 태스크 수 */
  maxConcurrentTasks?: number;
  /** 기본 역할 설정 */
  defaultRoles?: DefaultRolesConfig;
  /** 프로젝트별 에이전트 설정 */
  projectAgents?: ProjectAgentConfig[];
  /** 작업 분해 설정 (Planner Agent) */
  decomposition?: DecompositionConfig;
};
