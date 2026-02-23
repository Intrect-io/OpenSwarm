// ============================================
// OpenSwarm - Knowledge Graph Analyzer
// 이슈 영향 분석, 모듈 헬스, 리뷰 포커스
// ============================================

import type { KnowledgeGraph } from './graph.js';
import type { ImpactAnalysis, ProjectSummary } from './types.js';

// ============================================
// Issue Impact Analysis
// ============================================

/**
 * 이슈 텍스트를 분석하여 영향받는 모듈 식별
 */
export function analyzeIssueImpact(
  graph: KnowledgeGraph,
  issueTitle: string,
  issueDescription?: string,
): ImpactAnalysis {
  const text = `${issueTitle} ${issueDescription ?? ''}`.toLowerCase();

  // 1단계: 이슈 텍스트에서 직접 참조된 모듈 찾기
  const directModules: string[] = [];
  const allModules = graph.getNodesByType('module');

  for (const mod of allModules) {
    // 파일명, 경로 일부, 모듈명으로 매칭
    const name = mod.name.replace(/\.[^.]+$/, ''); // 확장자 제거
    const pathParts = mod.path.split('/');

    // 파일명 매칭 (e.g., "decisionEngine" → decisionEngine.ts)
    if (text.includes(name.toLowerCase())) {
      directModules.push(mod.id);
      continue;
    }

    // camelCase → 단어 분리 매칭 (e.g., "decision engine" → decisionEngine.ts)
    const words = name.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
    if (words.includes(' ') && text.includes(words)) {
      directModules.push(mod.id);
      continue;
    }

    // 디렉토리/파일 경로 매칭 (e.g., "orchestration/taskParser")
    if (pathParts.length >= 2) {
      const pathRef = pathParts.slice(-2).join('/').toLowerCase().replace(/\.[^.]+$/, '');
      if (text.includes(pathRef)) {
        directModules.push(mod.id);
      }
    }
  }

  // 2단계: 직접 모듈을 import하는 의존 모듈 찾기
  const dependentModules = new Set<string>();
  for (const modId of directModules) {
    const deps = graph.getDependents(modId);
    for (const dep of deps) {
      if (!directModules.includes(dep.id)) {
        dependentModules.add(dep.id);
      }
    }
  }

  // 3단계: 관련 테스트 파일 찾기
  const testFiles = new Set<string>();
  const allAffected = [...directModules, ...dependentModules];
  for (const modId of allAffected) {
    const tests = graph.getTests(modId);
    for (const test of tests) {
      testFiles.add(test.id);
    }
  }

  // 4단계: 영향 범위 추정
  const totalAffected = directModules.length + dependentModules.size;
  let estimatedScope: 'small' | 'medium' | 'large';
  if (totalAffected <= 2) estimatedScope = 'small';
  else if (totalAffected <= 8) estimatedScope = 'medium';
  else estimatedScope = 'large';

  return {
    directModules,
    dependentModules: Array.from(dependentModules),
    testFiles: Array.from(testFiles),
    estimatedScope,
  };
}

// ============================================
// Module Health
// ============================================

export interface ModuleHealth {
  moduleId: string;
  hasTests: boolean;
  dependentCount: number;     // 이 모듈에 의존하는 모듈 수
  importCount: number;        // 이 모듈이 import하는 수
  churnScore: number;         // 최근 변경 빈도
  loc: number;
  risk: 'low' | 'medium' | 'high';
}

/**
 * 개별 모듈의 헬스 점검
 */
export function getModuleHealth(graph: KnowledgeGraph, moduleId: string): ModuleHealth | null {
  const mod = graph.getNode(moduleId);
  if (!mod || (mod.type !== 'module' && mod.type !== 'test_file')) return null;

  const tests = graph.getTests(moduleId);
  const dependents = graph.getDependents(moduleId);
  const imports = graph.getImports(moduleId);

  const hasTests = tests.length > 0;
  const dependentCount = dependents.length;
  const importCount = imports.length;
  const churnScore = mod.gitInfo?.churnScore ?? 0;
  const loc = mod.metrics?.loc ?? 0;

  // 위험도 평가
  let risk: 'low' | 'medium' | 'high' = 'low';

  // 고변경 + 테스트 없음 → high
  if (churnScore > 0.5 && !hasTests) risk = 'high';
  // 많은 의존성 + 테스트 없음 → high
  else if (dependentCount >= 5 && !hasTests) risk = 'high';
  // 고변경 또는 많은 의존성 → medium
  else if (churnScore > 0.3 || dependentCount >= 3) risk = 'medium';
  // 테스트 없는 큰 파일 → medium
  else if (!hasTests && loc > 200) risk = 'medium';

  return {
    moduleId,
    hasTests,
    dependentCount,
    importCount,
    churnScore,
    loc,
    risk,
  };
}

// ============================================
// Review Focus
// ============================================

export interface ReviewFocus {
  criticalModules: string[];   // 리뷰 집중 필요한 모듈
  suggestedTests: string[];    // 반드시 실행해야 할 테스트
  reasons: string[];           // 리뷰 포인트
}

/**
 * 변경 파일 기반 리뷰 포커스 제안
 */
export function suggestReviewFocus(
  graph: KnowledgeGraph,
  changedFiles: string[],
): ReviewFocus {
  const criticalModules: string[] = [];
  const suggestedTests = new Set<string>();
  const reasons: string[] = [];

  for (const file of changedFiles) {
    const mod = graph.getNode(file);
    if (!mod) continue;

    // 의존하는 모듈이 많은 파일 → 리뷰 집중
    const dependents = graph.getDependents(file);
    if (dependents.length >= 3) {
      criticalModules.push(file);
      reasons.push(`${mod.name}: ${dependents.length}개 모듈이 의존 — 변경 영향 넓음`);
    }

    // 고빈도 변경 파일 → 주의
    if (mod.gitInfo && mod.gitInfo.churnScore > 0.5) {
      if (!criticalModules.includes(file)) criticalModules.push(file);
      reasons.push(`${mod.name}: 최근 변경 빈번 (churn=${mod.gitInfo.churnScore})`);
    }

    // 관련 테스트 수집
    const tests = graph.getTests(file);
    for (const t of tests) {
      suggestedTests.add(t.id);
    }

    // 테스트 없는 변경 파일 경고
    if (tests.length === 0 && mod.type === 'module') {
      reasons.push(`${mod.name}: 테스트 없음 — 수동 검증 필요`);
    }
  }

  return {
    criticalModules,
    suggestedTests: Array.from(suggestedTests),
    reasons,
  };
}

/**
 * 프로젝트 전체 헬스 요약
 */
export function getProjectHealth(graph: KnowledgeGraph): {
  summary: ProjectSummary;
  riskModules: ModuleHealth[];
} {
  const summary = graph.buildSummary();
  const modules = graph.getNodesByType('module');

  const riskModules: ModuleHealth[] = [];
  for (const mod of modules) {
    const health = getModuleHealth(graph, mod.id);
    if (health && health.risk !== 'low') {
      riskModules.push(health);
    }
  }

  // risk 순으로 정렬 (high → medium)
  riskModules.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.risk] - order[b.risk];
  });

  return { summary, riskModules };
}
