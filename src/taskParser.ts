// ============================================
// Claude Swarm - Task Parser
// Linear 이슈를 분석하여 실행 가능한 서브태스크로 분해
// ============================================

import { resolve } from 'path';
import { homedir } from 'os';
import * as fs from 'fs/promises';
import { WorkflowConfig, WorkflowStep } from './workflow.js';

// ============================================
// Types
// ============================================

/**
 * 파싱된 태스크 구조
 */
export interface ParsedTask {
  /** 원본 이슈 정보 */
  original: {
    id: string;
    title: string;
    description: string;
  };

  /** 분석 결과 */
  analysis: {
    type: TaskType;
    complexity: 'simple' | 'medium' | 'complex';
    estimatedSteps: number;
    requiresHumanReview: boolean;
    risks: string[];
  };

  /** 분해된 서브태스크 */
  subtasks: Subtask[];

  /** 생성된 워크플로우 */
  workflow: WorkflowConfig;

  /** 파싱 타임스탬프 */
  parsedAt: number;
}

/**
 * 태스크 타입
 */
export type TaskType =
  | 'bug_fix'
  | 'feature'
  | 'refactor'
  | 'docs'
  | 'test'
  | 'ci_cd'
  | 'investigation'
  | 'unknown';

/**
 * 서브태스크
 */
export interface Subtask {
  id: string;
  order: number;
  title: string;
  description: string;
  prompt: string;
  dependsOn: string[];
  type: 'analysis' | 'implementation' | 'test' | 'review' | 'documentation';
  optional: boolean;
}

// ============================================
// Task Type Detection
// ============================================

const TYPE_PATTERNS: { type: TaskType; patterns: RegExp[] }[] = [
  {
    type: 'bug_fix',
    patterns: [
      /버그|bug|fix|수정|오류|에러|error|crash|깨짐|안됨|실패/i,
    ],
  },
  {
    type: 'feature',
    patterns: [
      /기능|feature|추가|구현|implement|add|새로운|new/i,
    ],
  },
  {
    type: 'refactor',
    patterns: [
      /리팩|refactor|개선|improve|정리|clean|optimize|최적화/i,
    ],
  },
  {
    type: 'docs',
    patterns: [
      /문서|docs|documentation|readme|주석|comment/i,
    ],
  },
  {
    type: 'test',
    patterns: [
      /테스트|test|coverage|검증|validate/i,
    ],
  },
  {
    type: 'ci_cd',
    patterns: [
      /ci|cd|pipeline|배포|deploy|빌드|build|github action/i,
    ],
  },
  {
    type: 'investigation',
    patterns: [
      /조사|investigate|분석|analyze|research|확인|check|왜/i,
    ],
  },
];

/**
 * 태스크 타입 감지
 */
function detectTaskType(title: string, description: string): TaskType {
  const text = `${title} ${description}`.toLowerCase();

  for (const { type, patterns } of TYPE_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return type;
      }
    }
  }

  return 'unknown';
}

// ============================================
// Complexity Analysis
// ============================================

/**
 * 복잡도 분석
 */
function analyzeComplexity(title: string, description: string): {
  complexity: 'simple' | 'medium' | 'complex';
  estimatedSteps: number;
  risks: string[];
} {
  const text = `${title} ${description}`;
  const risks: string[] = [];

  // 길이 기반 초기 판단
  let complexity: 'simple' | 'medium' | 'complex' = 'simple';
  let estimatedSteps = 2;

  if (description.length > 500) {
    complexity = 'medium';
    estimatedSteps = 4;
  }
  if (description.length > 1500) {
    complexity = 'complex';
    estimatedSteps = 6;
  }

  // 키워드 기반 조정
  const complexityIndicators = [
    { pattern: /여러|multiple|다수|많은/i, add: 1 },
    { pattern: /전체|all|모든|entire/i, add: 2 },
    { pattern: /마이그레이션|migration|이전/i, add: 2, risk: '데이터 마이그레이션 위험' },
    { pattern: /데이터베이스|database|db|스키마/i, add: 1, risk: 'DB 변경 필요' },
    { pattern: /api|인터페이스|interface/i, add: 1, risk: 'API 변경으로 인한 호환성' },
    { pattern: /보안|security|인증|auth/i, add: 1, risk: '보안 관련 변경' },
    { pattern: /성능|performance|속도/i, add: 1 },
    { pattern: /테스트|test/i, add: 1 },
  ];

  for (const { pattern, add, risk } of complexityIndicators) {
    if (pattern.test(text)) {
      estimatedSteps += add;
      if (risk) risks.push(risk);
    }
  }

  // 최종 복잡도 결정
  if (estimatedSteps >= 6) complexity = 'complex';
  else if (estimatedSteps >= 4) complexity = 'medium';

  return { complexity, estimatedSteps, risks };
}

// ============================================
// Subtask Generation
// ============================================

/**
 * 서브태스크 템플릿
 */
const SUBTASK_TEMPLATES: Record<TaskType, Subtask[]> = {
  bug_fix: [
    {
      id: 'analyze',
      order: 1,
      title: '버그 분석',
      description: '버그 원인 파악 및 재현',
      prompt: '버그를 분석하고 원인을 파악해줘. 재현 방법과 영향 범위도 확인.',
      dependsOn: [],
      type: 'analysis',
      optional: false,
    },
    {
      id: 'fix',
      order: 2,
      title: '버그 수정',
      description: '버그 수정 코드 작성',
      prompt: '분석 결과를 바탕으로 버그를 수정해줘. 최소한의 변경으로.',
      dependsOn: ['analyze'],
      type: 'implementation',
      optional: false,
    },
    {
      id: 'test',
      order: 3,
      title: '테스트',
      description: '수정 검증 및 회귀 테스트',
      prompt: '수정사항 테스트하고 기존 기능에 영향 없는지 확인해줘.',
      dependsOn: ['fix'],
      type: 'test',
      optional: false,
    },
  ],

  feature: [
    {
      id: 'design',
      order: 1,
      title: '설계 검토',
      description: '기능 설계 및 구현 방향 결정',
      prompt: '기능 요구사항을 분석하고 구현 방향을 설계해줘. 기존 코드와의 통합 방법도.',
      dependsOn: [],
      type: 'analysis',
      optional: false,
    },
    {
      id: 'implement',
      order: 2,
      title: '구현',
      description: '기능 구현',
      prompt: '설계대로 기능을 구현해줘.',
      dependsOn: ['design'],
      type: 'implementation',
      optional: false,
    },
    {
      id: 'test',
      order: 3,
      title: '테스트 작성',
      description: '기능 테스트 코드 작성',
      prompt: '구현한 기능에 대한 테스트를 작성해줘.',
      dependsOn: ['implement'],
      type: 'test',
      optional: false,
    },
    {
      id: 'docs',
      order: 4,
      title: '문서 업데이트',
      description: '관련 문서 업데이트',
      prompt: '새 기능에 대한 문서를 업데이트해줘. 필요한 경우에만.',
      dependsOn: ['implement'],
      type: 'documentation',
      optional: true,
    },
  ],

  refactor: [
    {
      id: 'analyze',
      order: 1,
      title: '현재 코드 분석',
      description: '리팩토링 대상 코드 분석',
      prompt: '리팩토링 대상 코드를 분석하고 개선점을 파악해줘.',
      dependsOn: [],
      type: 'analysis',
      optional: false,
    },
    {
      id: 'refactor',
      order: 2,
      title: '리팩토링',
      description: '코드 개선',
      prompt: '분석 결과를 바탕으로 리팩토링해줘. 기능 변경 없이 구조만 개선.',
      dependsOn: ['analyze'],
      type: 'implementation',
      optional: false,
    },
    {
      id: 'verify',
      order: 3,
      title: '검증',
      description: '기존 동작 유지 확인',
      prompt: '리팩토링 후 기존 동작이 유지되는지 확인해줘.',
      dependsOn: ['refactor'],
      type: 'test',
      optional: false,
    },
  ],

  docs: [
    {
      id: 'review',
      order: 1,
      title: '현재 문서 검토',
      description: '기존 문서 상태 파악',
      prompt: '현재 문서 상태를 검토하고 업데이트가 필요한 부분을 파악해줘.',
      dependsOn: [],
      type: 'analysis',
      optional: false,
    },
    {
      id: 'update',
      order: 2,
      title: '문서 업데이트',
      description: '문서 작성/수정',
      prompt: '파악한 내용을 바탕으로 문서를 업데이트해줘.',
      dependsOn: ['review'],
      type: 'documentation',
      optional: false,
    },
  ],

  test: [
    {
      id: 'analyze',
      order: 1,
      title: '테스트 범위 분석',
      description: '테스트가 필요한 부분 파악',
      prompt: '테스트 커버리지를 분석하고 추가가 필요한 부분을 파악해줘.',
      dependsOn: [],
      type: 'analysis',
      optional: false,
    },
    {
      id: 'write',
      order: 2,
      title: '테스트 작성',
      description: '테스트 코드 작성',
      prompt: '분석 결과를 바탕으로 테스트를 작성해줘.',
      dependsOn: ['analyze'],
      type: 'test',
      optional: false,
    },
    {
      id: 'run',
      order: 3,
      title: '테스트 실행',
      description: '전체 테스트 실행 및 결과 확인',
      prompt: '작성한 테스트를 포함해 전체 테스트를 실행하고 결과를 확인해줘.',
      dependsOn: ['write'],
      type: 'test',
      optional: false,
    },
  ],

  ci_cd: [
    {
      id: 'analyze',
      order: 1,
      title: '현재 CI/CD 분석',
      description: '현재 설정 파악',
      prompt: '현재 CI/CD 설정을 분석하고 변경이 필요한 부분을 파악해줘.',
      dependsOn: [],
      type: 'analysis',
      optional: false,
    },
    {
      id: 'implement',
      order: 2,
      title: 'CI/CD 수정',
      description: '설정 변경',
      prompt: '분석 결과를 바탕으로 CI/CD 설정을 수정해줘.',
      dependsOn: ['analyze'],
      type: 'implementation',
      optional: false,
    },
    {
      id: 'test',
      order: 3,
      title: '파이프라인 테스트',
      description: '변경된 파이프라인 테스트',
      prompt: '변경된 CI/CD 파이프라인이 정상 동작하는지 확인해줘.',
      dependsOn: ['implement'],
      type: 'test',
      optional: false,
    },
  ],

  investigation: [
    {
      id: 'gather',
      order: 1,
      title: '정보 수집',
      description: '관련 정보 수집',
      prompt: '조사에 필요한 정보를 수집해줘. 코드, 로그, 문서 등.',
      dependsOn: [],
      type: 'analysis',
      optional: false,
    },
    {
      id: 'analyze',
      order: 2,
      title: '분석',
      description: '수집한 정보 분석',
      prompt: '수집한 정보를 분석하고 결론을 도출해줘.',
      dependsOn: ['gather'],
      type: 'analysis',
      optional: false,
    },
    {
      id: 'report',
      order: 3,
      title: '결과 보고',
      description: '분석 결과 정리',
      prompt: '분석 결과를 정리해서 보고해줘.',
      dependsOn: ['analyze'],
      type: 'documentation',
      optional: false,
    },
  ],

  unknown: [
    {
      id: 'understand',
      order: 1,
      title: '요구사항 파악',
      description: '정확한 요구사항 이해',
      prompt: '이슈 내용을 분석하고 정확히 무엇을 해야 하는지 파악해줘.',
      dependsOn: [],
      type: 'analysis',
      optional: false,
    },
    {
      id: 'plan',
      order: 2,
      title: '작업 계획',
      description: '실행 계획 수립',
      prompt: '파악한 내용을 바탕으로 작업 계획을 세워줘.',
      dependsOn: ['understand'],
      type: 'analysis',
      optional: false,
    },
    {
      id: 'execute',
      order: 3,
      title: '실행',
      description: '계획대로 실행',
      prompt: '계획대로 작업을 실행해줘.',
      dependsOn: ['plan'],
      type: 'implementation',
      optional: false,
    },
  ],
};

/**
 * 서브태스크 생성
 */
function generateSubtasks(
  type: TaskType,
  title: string,
  description: string,
  complexity: 'simple' | 'medium' | 'complex'
): Subtask[] {
  const templates = SUBTASK_TEMPLATES[type] || SUBTASK_TEMPLATES.unknown;
  const subtasks: Subtask[] = [];

  for (const template of templates) {
    // 간단한 작업이면 optional 스킵
    if (complexity === 'simple' && template.optional) {
      continue;
    }

    // 컨텍스트 추가
    const contextualPrompt = `
## 원본 이슈
**제목:** ${title}
**설명:** ${description}

## 현재 단계: ${template.title}
${template.prompt}

## 지침
- 범위를 벗어나는 추가 작업 금지
- 완료 후 변경 내용 보고
`.trim();

    subtasks.push({
      ...template,
      id: `${type}-${template.id}`,
      prompt: contextualPrompt,
    });
  }

  return subtasks;
}

// ============================================
// Main Parser
// ============================================

/**
 * Linear 이슈를 파싱하여 실행 가능한 구조로 변환
 */
export function parseTask(issue: {
  id: string;
  title: string;
  description?: string;
  projectPath?: string;
}): ParsedTask {
  const description = issue.description || '';

  // 1. 타입 감지
  const type = detectTaskType(issue.title, description);

  // 2. 복잡도 분석
  const { complexity, estimatedSteps, risks } = analyzeComplexity(issue.title, description);

  // 3. 서브태스크 생성
  const subtasks = generateSubtasks(type, issue.title, description, complexity);

  // 4. 워크플로우 생성
  const workflow = subtasksToWorkflow(issue, subtasks);

  // 5. 결과 조합
  return {
    original: {
      id: issue.id,
      title: issue.title,
      description,
    },
    analysis: {
      type,
      complexity,
      estimatedSteps,
      requiresHumanReview: complexity === 'complex' || risks.length > 0,
      risks,
    },
    subtasks,
    workflow,
    parsedAt: Date.now(),
  };
}

/**
 * 서브태스크를 워크플로우로 변환
 */
function subtasksToWorkflow(
  issue: { id: string; title: string; projectPath?: string },
  subtasks: Subtask[]
): WorkflowConfig {
  const steps: WorkflowStep[] = subtasks.map(st => ({
    id: st.id,
    name: st.title,
    prompt: st.prompt,
    dependsOn: st.dependsOn.length > 0 ? st.dependsOn : undefined,
    onFailure: st.type === 'analysis' ? 'abort' : 'notify',
  }));

  return {
    id: `parsed-${issue.id}-${Date.now()}`,
    name: `[Auto] ${issue.title}`,
    description: `Auto-generated workflow from issue ${issue.id}`,
    projectPath: issue.projectPath || '~',
    steps,
    onFailure: 'notify',
    linearIssue: issue.id,
  };
}

// ============================================
// Parsing Result Storage
// ============================================

const PARSED_TASKS_DIR = resolve(homedir(), '.claude-swarm/parsed-tasks');

/**
 * 파싱 결과 저장
 */
export async function saveParsedTask(parsed: ParsedTask): Promise<void> {
  await fs.mkdir(PARSED_TASKS_DIR, { recursive: true });
  const filePath = resolve(PARSED_TASKS_DIR, `${parsed.original.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(parsed, null, 2));
}

/**
 * 파싱 결과 로드
 */
export async function loadParsedTask(issueId: string): Promise<ParsedTask | null> {
  try {
    const filePath = resolve(PARSED_TASKS_DIR, `${issueId}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ============================================
// Utility Functions
// ============================================

/**
 * 파싱 결과 요약 생성 (Linear 코멘트용)
 */
export function formatParsedTaskSummary(parsed: ParsedTask): string {
  const parts: string[] = [];

  parts.push('## 🤖 자동 분석 결과');
  parts.push('');
  parts.push(`**타입:** ${parsed.analysis.type}`);
  parts.push(`**복잡도:** ${parsed.analysis.complexity}`);
  parts.push(`**예상 단계:** ${parsed.analysis.estimatedSteps}`);
  parts.push('');

  if (parsed.analysis.risks.length > 0) {
    parts.push('### ⚠️ 주의사항');
    parts.push(parsed.analysis.risks.map(r => `- ${r}`).join('\n'));
    parts.push('');
  }

  parts.push('### 📋 실행 계획');
  for (const st of parsed.subtasks) {
    const deps = st.dependsOn.length > 0 ? ` (← ${st.dependsOn.join(', ')})` : '';
    parts.push(`${st.order}. **${st.title}**${deps}`);
    parts.push(`   ${st.description}`);
  }
  parts.push('');

  if (parsed.analysis.requiresHumanReview) {
    parts.push('---');
    parts.push('⚠️ **복잡한 작업입니다. 실행 전 검토를 권장합니다.**');
  }

  parts.push('');
  parts.push('---');
  parts.push('_Claude Swarm Task Parser_');

  return parts.join('\n');
}
