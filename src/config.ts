// ============================================
// Claude Swarm - Configuration
// ============================================

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import YAML from 'yaml';
import type { SwarmConfig, AgentSession, TimeWindowConfig } from './types.js';
import { setTimeWindowConfig, DEFAULT_TIME_WINDOW } from './timeWindow.js';

// ============================================
// Constants
// ============================================

const CONFIG_PATHS = [
  join(process.cwd(), 'config.yaml'),
  join(process.cwd(), 'config.yml'),
  join(process.cwd(), 'config.json'),
];

const DEFAULT_HEARTBEAT_INTERVAL = 30 * 60 * 1000; // 30분
const DEFAULT_GITHUB_CHECK_INTERVAL = 5 * 60 * 1000; // 5분

// ============================================
// Zod Schemas
// ============================================

const AgentSessionSchema = z.object({
  name: z.string().min(1, 'Agent name is required'),
  projectPath: z.string().min(1, 'Project path is required'),
  heartbeatInterval: z.number().positive().optional(),
  linearLabel: z.string().optional(),
  enabled: z.boolean().default(true),
  paused: z.boolean().default(false),
});

const DiscordConfigSchema = z.object({
  token: z.string().min(1, 'Discord token is required'),
  channelId: z.string().min(1, 'Discord channel ID is required'),
  webhookUrl: z.string().optional(),
});

const LinearConfigSchema = z.object({
  apiKey: z.string().min(1, 'Linear API key is required'),
  teamId: z.string().min(1, 'Linear team ID is required'),
});

const GitHubConfigSchema = z.object({
  repos: z.array(z.string()).default([]),
  checkInterval: z.number().positive().default(DEFAULT_GITHUB_CHECK_INTERVAL),
}).optional();

const TimeRangeSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/, 'Format: HH:MM'),
  end: z.string().regex(/^\d{2}:\d{2}$/, 'Format: HH:MM'),
});

const TimeWindowConfigSchema = z.object({
  enabled: z.boolean().default(true),
  allowedWindows: z.array(TimeRangeSchema).default([]),
  blockedWindows: z.array(TimeRangeSchema).default([]),
  restrictedDays: z.array(z.number().min(0).max(6)).optional(),
  timezone: z.string().default('Asia/Seoul'),
}).optional();

const RawConfigSchema = z.object({
  discord: DiscordConfigSchema,
  linear: LinearConfigSchema,
  github: GitHubConfigSchema,
  timeWindow: TimeWindowConfigSchema,
  agents: z.array(AgentSessionSchema).min(1, 'At least one agent is required'),
  defaultHeartbeatInterval: z.number().positive().default(DEFAULT_HEARTBEAT_INTERVAL),
});

export type RawConfig = z.infer<typeof RawConfigSchema>;

// ============================================
// Environment Variable Substitution
// ============================================

/**
 * 환경변수 패턴: ${VAR_NAME} 또는 ${VAR_NAME:-default}
 */
const ENV_VAR_PATTERN = /\$\{([^}:]+)(?::-([^}]*))?\}/g;

/**
 * 문자열 내 환경변수 치환
 */
function substituteEnvVars(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (match, varName, defaultValue) => {
    const envValue = process.env[varName];
    if (envValue !== undefined) {
      return envValue;
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    // 환경변수가 없고 기본값도 없으면 빈 문자열 반환
    console.warn(`Environment variable ${varName} is not set`);
    return '';
  });
}

/**
 * 객체 내 모든 문자열에 환경변수 치환 적용
 */
function substituteEnvVarsDeep(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return substituteEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(substituteEnvVarsDeep);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVarsDeep(value);
    }
    return result;
  }
  return obj;
}

/**
 * 경로 확장 (~/ 처리)
 */
function expandPath(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

// ============================================
// Config Loading
// ============================================

/**
 * 설정 파일 찾기
 */
function findConfigFile(): string | null {
  for (const path of CONFIG_PATHS) {
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

/**
 * 설정 파일 파싱
 */
function parseConfigFile(path: string): unknown {
  const content = readFileSync(path, 'utf-8');

  if (path.endsWith('.json')) {
    return JSON.parse(content);
  }

  // YAML 파싱
  return YAML.parse(content);
}

/**
 * Raw config를 SwarmConfig로 변환
 */
function transformConfig(raw: RawConfig): SwarmConfig {
  return {
    discordToken: raw.discord.token,
    discordChannelId: raw.discord.channelId,
    discordWebhookUrl: raw.discord.webhookUrl,
    linearApiKey: raw.linear.apiKey,
    linearTeamId: raw.linear.teamId,
    agents: raw.agents.map(agent => ({
      ...agent,
      projectPath: expandPath(agent.projectPath),
      heartbeatInterval: agent.heartbeatInterval ?? raw.defaultHeartbeatInterval,
      linearLabel: agent.linearLabel ?? agent.name,
    })),
    defaultHeartbeatInterval: raw.defaultHeartbeatInterval,
    githubRepos: raw.github?.repos,
    githubCheckInterval: raw.github?.checkInterval,
    timeWindow: raw.timeWindow ? {
      enabled: raw.timeWindow.enabled,
      allowedWindows: raw.timeWindow.allowedWindows,
      blockedWindows: raw.timeWindow.blockedWindows,
      restrictedDays: raw.timeWindow.restrictedDays,
      timezone: raw.timeWindow.timezone,
    } : undefined,
  };
}

/**
 * 설정 로드 (환경변수 치환 + Zod 검증)
 */
export function loadConfig(customPath?: string): SwarmConfig {
  // 1. 설정 파일 찾기
  const configPath = customPath ?? findConfigFile();

  if (!configPath) {
    throw new Error(
      `Config file not found. Create one of: ${CONFIG_PATHS.join(', ')}`
    );
  }

  console.log(`Loading config from: ${configPath}`);

  // 2. 파일 파싱
  let rawData: unknown;
  try {
    rawData = parseConfigFile(configPath);
  } catch (err) {
    throw new Error(`Failed to parse config file: ${err}`);
  }

  // 3. 환경변수 치환
  const substituted = substituteEnvVarsDeep(rawData);

  // 4. Zod 스키마 검증
  const parseResult = RawConfigSchema.safeParse(substituted);

  if (!parseResult.success) {
    const errors = parseResult.error.issues
      .map((e) => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Config validation failed:\n${errors}`);
  }

  // 5. SwarmConfig로 변환
  const config = transformConfig(parseResult.data);

  // 6. 시간 윈도우 설정 적용
  if (config.timeWindow) {
    setTimeWindowConfig(config.timeWindow);
    console.log(`[Config] TimeWindow 설정 로드됨 (enabled: ${config.timeWindow.enabled})`);
  } else {
    setTimeWindowConfig(DEFAULT_TIME_WINDOW);
    console.log(`[Config] TimeWindow 기본 설정 사용`);
  }

  return config;
}

/**
 * 설정 유효성 검사 (이미 Zod에서 수행하지만 추가 검증용)
 */
export function validateConfig(config: SwarmConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // 에이전트 경로 존재 확인
  for (const agent of config.agents) {
    if (!existsSync(agent.projectPath)) {
      errors.push(`Agent "${agent.name}" project path does not exist: ${agent.projectPath}`);
    }
  }

  // GitHub 레포 형식 확인
  if (config.githubRepos) {
    for (const repo of config.githubRepos) {
      if (!repo.includes('/')) {
        errors.push(`Invalid GitHub repo format: ${repo} (expected: owner/repo)`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 기본 에이전트 세션 생성
 */
export function createAgentSession(
  name: string,
  projectPath: string,
  options?: Partial<AgentSession>
): AgentSession {
  return {
    name,
    projectPath: expandPath(projectPath),
    heartbeatInterval: options?.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL,
    linearLabel: options?.linearLabel ?? name,
    enabled: options?.enabled ?? true,
    paused: options?.paused ?? false,
  };
}

/**
 * 샘플 설정 파일 생성
 */
export function generateSampleConfig(): string {
  return `# Claude Swarm Configuration
# 환경변수는 \${VAR_NAME} 또는 \${VAR_NAME:-default} 형식으로 사용

discord:
  token: \${DISCORD_TOKEN}
  channelId: \${DISCORD_CHANNEL_ID}
  webhookUrl: \${DISCORD_WEBHOOK_URL:-}  # 선택적

linear:
  apiKey: \${LINEAR_API_KEY}
  teamId: \${LINEAR_TEAM_ID}

github:
  repos:
    - owner/repo1
    - owner/repo2
  checkInterval: 300000  # 5분 (ms)

# 에이전트 목록
agents:
  - name: main
    projectPath: ~/dev/my-project
    heartbeatInterval: 1800000  # 30분 (ms)
    linearLabel: main  # Linear 이슈 필터용 라벨
    enabled: true
    paused: false

  - name: backend
    projectPath: ~/dev/backend-api
    linearLabel: backend
    enabled: true

# 기본 heartbeat 간격 (ms)
defaultHeartbeatInterval: 1800000
`;
}
