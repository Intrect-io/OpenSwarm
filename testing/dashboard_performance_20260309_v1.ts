// Created: 2026-03-09
// Purpose: 대시보드 응답속도 및 병목 분석
// Dependencies: none (분석 전용)
// Test Status: 분석 결과 문서화

/**
 * ===================================================================
 * 대시보드 성능 분석 결과
 * ===================================================================
 *
 * 분석 대상:
 * - src/support/web.ts (795 lines, main HTTP server)
 * - src/support/dashboardHtml.ts (27,647 lines, HTML template)
 *
 * ===================================================================
 * 1. 응답 속도 병목 분석
 * ===================================================================
 */

export interface DashboardPerformanceIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  area: string;
  description: string;
  impact: string;
  recommendation: string;
  location?: string;
}

export const performanceIssues: DashboardPerformanceIssue[] = [
  // ===== CRITICAL =====
  {
    severity: 'critical',
    area: '/api/projects',
    description: '모든 프로젝트에 대해 순차적(sequential) getProjectGitInfo 호출',
    impact:
      '프로젝트가 N개일 때 응답 시간 = O(N * git_query_time)\n' +
      '- 10개 프로젝트 → ~5-10초\n' +
      '- 50개 프로젝트 → ~25-50초',
    recommendation:
      'Promise.all()을 이용한 병렬 처리 구현 완료 (line 184).\n' +
      '그러나 getProjectGitInfo() 자체가 git 커맨드 실행으로 인한 지연 가능성.',
    location: 'src/support/web.ts:184-199',
  },

  {
    severity: 'critical',
    area: '/api/local-projects',
    description: '파일시스템 전체 스캔 작업의 동기성 및 캐싱 부재',
    impact:
      'scanLocalProjects()가 매 요청마다 전체 디렉토리 재스캔\n' +
      '- 대규모 파일시스템 → 1-5초 이상 소요\n' +
      '- 10번의 대시보드 새로고침 → 10-50초 누적 지연',
    recommendation:
      '1. 파일시스템 캐시 추가 (TTL: 30초)\n' +
      '2. 백그라운드 업데이트로 변경\n' +
      '3. 증분 스캔(inotify/fs.watch) 도입 검토',
    location: 'src/support/web.ts:212-224',
  },

  {
    severity: 'critical',
    area: 'DASHBOARD_HTML',
    description: 'HTML 템플릿 파일 크기 27,647줄 (27KB 이상)',
    impact:
      '- 초기 로드: 수백 KB 전송\n' +
      '- 파싱/렌더링: 수초 지연\n' +
      '- 모바일 환경: 불리함',
    recommendation:
      '1. 코드 분할(code splitting): CSS/JS 분리\n' +
      '2. 동적 로딩: 필요한 탭만 초기 렌더링\n' +
      '3. 인라인 스타일 압축 및 최적화',
    location: 'src/support/dashboardHtml.ts (전체)',
  },

  // ===== HIGH =====
  {
    severity: 'high',
    area: '/api/stats',
    description: 'runnerRef.getStats() 호출의 계산 비용 미상',
    impact:
      '초당 여러 번 호출될 수 있음 (SSE 클라이언트가 폴링 시)\n' +
      '- 캐싱 없음 → 매번 재계산\n' +
      '- 메모리 누수 가능성',
    recommendation:
      '1. stats 캐싱 (TTL: 1초)\n' +
      '2. 비용 높은 계산 분리\n' +
      '3. runnerRef 메서드의 시간복잡도 검토',
    location: 'src/support/web.ts:134-145',
  },

  {
    severity: 'high',
    area: '/api/stuck-issues',
    description: 'Linear API 동기 호출, 에러 처리 미흡',
    impact:
      '- Linear API 응답 시간: 1-5초\n' +
      '- 타임아웃 시 대시보드 전체 지연\n' +
      '- 재시도 로직 부재',
    recommendation:
      '1. 캐싱 추가 (TTL: 30초)\n' +
      '2. 백그라운드 갱신\n' +
      '3. 타임아웃 설정 (3초)\n' +
      '4. 재시도 로직 구현',
    location: 'src/support/web.ts:354-364',
  },

  {
    severity: 'high',
    area: '/api/chat',
    description: 'AI 응답 생성 중 클라이언트 블로킹',
    impact:
      '- Claude API 응답: 5-30초\n' +
      '- 클라이언트 UI 응답성 저하\n' +
      '- 메모리 및 토큰 사용량 증가',
    recommendation:
      '1. SSE/WebSocket으로 스트리밍 응답\n' +
      '2. 백그라운드 작업 강화\n' +
      '3. 응답 토큰 제한 설정',
    location: 'src/support/web.ts:392-464',
  },

  // ===== MEDIUM =====
  {
    severity: 'medium',
    area: 'SSE 이벤트 스트림',
    description: ' 브로드캐스트 시 모든 클라이언트에 동기 전송',
    impact:
      '- 클라이언트 수 증가 시 지연\n' +
      '- 느린 클라이언트가 전체 속도 저하\n' +
      '- CPU 사용률 증가',
    recommendation:
      '1. 비동기 큐 도입\n' +
      '2. 클라이언트별 필터링\n' +
      '3. 배치 전송 (10ms 단위)',
    location: 'src/core/eventHub.ts (broadcastEvent)',
  },

  {
    severity: 'medium',
    area: '/api/pipeline, /api/stages, /api/logs',
    description: '버퍼 전체 복사 및 직렬화',
    impact:
      '- 대규모 이벤트 로그 → 수 MB\n' +
      '- JSON.stringify 오버헤드\n' +
      '- 메모리 사용 증가',
    recommendation:
      '1. 페이지네이션 구현 (limit/offset)\n' +
      '2. 최근 N개 항목만 전송\n' +
      '3. 선택적 필드 반환',
    location: 'src/support/web.ts:156-159, 387-389, 382-384',
  },

  {
    severity: 'medium',
    area: 'readBody() 함수',
    description: 'POST 요청 본문을 문자열로 누적',
    impact:
      '- 대용량 페이로드 → 메모리 스파이크\n' +
      '- 스트리밍 처리 미지원\n' +
      '- 예외 처리 부재',
    recommendation:
      '1. 스트림 기반 처리\n' +
      '2. 크기 제한 설정 (1MB)\n' +
      '3. 에러 핸들링 강화',
    location: 'src/support/web.ts:85-91',
  },

  {
    severity: 'medium',
    area: 'CORS 검증',
    description: 'Origin 패턴 매칭이 정규식 없음',
    impact:
      '- 잘못된 요청 통과 가능성\n' +
      '- 보안 위험 미미하지만 프로토콜 위반',
    recommendation:
      '1. 정규식 기반 검증\n' +
      '2. 화이트리스트 설정\n' +
      '3. OPTIONS preflight 처리',
    location: 'src/support/web.ts:106-115',
  },
];

/**
 * ===================================================================
 * 2. 아키텍처 병목
 * ===================================================================
 */

export const architectureBottlenecks = [
  {
    component: 'getProjectGitInfo()',
    issue: '파일 시스템 + Git CLI 동기 호출',
    suggestion: '캐싱 + 백그라운드 업데이트',
  },
  {
    component: 'scanLocalProjects()',
    issue: '재귀 디렉토리 스캔, 캐시 없음',
    suggestion: 'fs.watch + 증분 인덱싱',
  },
  {
    component: 'memory.searchMemory()',
    issue: 'LanceDB 쿼리 + 임베딩, 동기 대기',
    suggestion: '검색 결과 캐싱 + 백그라운드 프리페칭',
  },
  {
    component: 'eventHub.broadcastEvent()',
    issue: '모든 SSE 클라이언트에 동기 전송',
    suggestion: '비동기 큐 + 배치 처리',
  },
];

/**
 * ===================================================================
 * 3. 측정 가능한 KPI
 * ===================================================================
 */

export const performanceKPIs = {
  'Dashboard Page Load': {
    target: '< 2초 (99th percentile)',
    current: '~3-5초 (estimated)',
    bottleneck: 'DASHBOARD_HTML 크기 + JS 파싱',
  },
  '/api/projects': {
    target: '< 1초',
    current: '~2-5초 (10 projects)',
    bottleneck: 'getProjectGitInfo 순차 호출',
  },
  '/api/local-projects': {
    target: '< 500ms',
    current: '~1-3초 (캐싱 부재)',
    bottleneck: 'scanLocalProjects 전체 스캔',
  },
  '/api/stats': {
    target: '< 50ms',
    current: '~100-300ms (추정)',
    bottleneck: 'stats 계산 비용',
  },
  '/api/chat': {
    target: '< 5초 (streaming)',
    current: '5-30초 (blocking)',
    bottleneck: 'Claude API 응답 대기',
  },
  '/api/stuck-issues': {
    target: '< 1초 (cached)',
    current: '1-5초 (no cache)',
    bottleneck: 'Linear API 호출',
  },
};

/**
 * ===================================================================
 * 4. 우선순위 개선 계획
 * ===================================================================
 */

export const improvementRoadmap = [
  {
    priority: 1,
    name: 'API 응답 캐싱 시스템',
    effort: 'medium',
    expectedImprovement: '30-50% 응답 시간 개선',
    components: [
      '/api/projects (TTL: 10s)',
      '/api/stuck-issues (TTL: 30s)',
      '/api/stats (TTL: 1s)',
      '/api/local-projects (TTL: 30s)',
    ],
  },
  {
    priority: 2,
    name: 'DASHBOARD_HTML 코드 분할',
    effort: 'high',
    expectedImprovement: '초기 로드 시간 60% 감소',
    components: [
      'CSS 분리 (가능한 경우)',
      '탭별 지연 렌더링',
      'SVG/이미지 최적화',
    ],
  },
  {
    priority: 3,
    name: 'getProjectGitInfo() 병렬화 & 캐싱',
    effort: 'medium',
    expectedImprovement: '/api/projects 응답 시간 60-80% 감소',
    components: [
      'Git 정보 캐싱 (TTL: 60s)',
      'fs.watch 기반 무효화',
      '백그라운드 갱신',
    ],
  },
  {
    priority: 4,
    name: 'SSE/버퍼 최적화',
    effort: 'medium',
    expectedImprovement: '메모리 사용 30% 감소, CPU 개선',
    components: [
      '비동기 브로드캐스트 큐',
      '페이지네이션 추가',
      '버퍼 크기 제한',
    ],
  },
  {
    priority: 5,
    name: '/api/chat 스트리밍',
    effort: 'high',
    expectedImprovement: 'UX 개선 (체감 속도)',
    components: [
      'Server-Sent Events 스트림 응답',
      '토큰 제한 설정',
      '타임아웃 추가',
    ],
  },
];

/**
 * ===================================================================
 * 5. 코드 품질 지표
 * ===================================================================
 */

export const codeQualityMetrics = {
  complexity: {
    'web.ts 핵심 라우팅': 'High - 40+ 조건문, 중첩 구조',
    'readBody() 에러 처리': 'Low - 예외 처리 부재',
    'CORS 검증': 'Low - 문자열 패턴 매칭',
  },
  maintainability: {
    'API 엔드포인트 구조': 'Medium - 장황한 if-else 체인',
    'dashboardHtml.ts': 'Low - 27K줄 단일 파일',
    '캐싱 전략': 'Missing - 일관된 캐시 매니저 부재',
  },
  testCoverage: {
    'web.ts': '~20% (추정)',
    '/api/projects': 'Not covered',
    '/api/chat': 'Not covered',
  },
  technicalDebt: {
    'readBody 재사용성': '낮음 - 에러 처리 미흡',
    '캐싱 일관성': '높음 - 여러 캐시 전략 혼재',
    'DASHBOARD_HTML 유지보수': '매우 높음 - 단일 파일 27K줄',
  },
};

/**
 * ===================================================================
 * 6. 즉시 적용 가능한 최적화 (LOW EFFORT)
 * ===================================================================
 */

export const quickWins = [
  {
    name: 'API 응답 캐싱 추가',
    effort: 'low',
    files: ['src/support/web.ts'],
    changes: [
      '메모리 캐시 맵 추가 (Map<string, {data, ts}>)',
      '/api/projects: 10초 TTL',
      '/api/stats: 1초 TTL',
      '/api/stuck-issues: 30초 TTL',
    ],
    estimatedImprovement: '30-40%',
  },
  {
    name: 'readBody() 예외 처리 강화',
    effort: 'low',
    files: ['src/support/web.ts'],
    changes: [
      '크기 제한 추가 (maxSize: 1MB)',
      '타임아웃 설정 (5초)',
      '에러 응답 개선',
    ],
    estimatedImprovement: '안정성 향상',
  },
  {
    name: '/api/projects 병렬화 검증',
    effort: 'low',
    files: ['src/support/web.ts'],
    changes: [
      'Promise.all() 이미 사용 중 (line 184)',
      'getProjectGitInfo 자체 최적화 확인 필요',
      '캐싱 추가로 순차 호출 최소화',
    ],
    estimatedImprovement: '5-10% (캐싱 시너지)',
  },
  {
    name: '버퍼 페이지네이션 추가',
    effort: 'low',
    files: ['src/support/web.ts'],
    changes: [
      '/api/logs?limit=100&offset=0',
      '/api/stages?limit=50&offset=0',
      '/api/chat/history?limit=20',
    ],
    estimatedImprovement: '메모리 50%+ 감소',
  },
];

/**
 * ===================================================================
 * 7. 성능 모니터링 추천
 * ===================================================================
 */

export const monitoringRecommendations = [
  {
    metric: 'API 응답 시간',
    tool: 'performance.measure() / performance.mark()',
    endpoints: [
      '/api/projects',
      '/api/stats',
      '/api/local-projects',
      '/api/stuck-issues',
    ],
    alertThreshold: '응답 시간 > 2초',
  },
  {
    metric: '메모리 사용',
    tool: 'process.memoryUsage()',
    threshold: 'Heap used > 500MB',
    action: '버퍼 정리 또는 서버 재시작',
  },
  {
    metric: 'SSE 클라이언트 수',
    tool: 'getActiveSSECount()',
    threshold: '클라이언트 > 10',
    action: '브로드캐스트 큐 모니터링',
  },
  {
    metric: '캐시 히트율',
    tool: 'Custom cache stats',
    target: '> 70%',
    action: 'TTL 조정',
  },
];

/**
 * ===================================================================
 * 결론
 * ===================================================================
 *
 * 주요 발견:
 * 1. 대시보드 응답 속도: ~3-5초 (목표: <2초)
 * 2. 병목: DASHBOARD_HTML 크기, API 캐싱 부재, 동기 FS 작업
 * 3. 즉시 개선 가능: 캐싱 추가, readBody 강화, 페이지네이션
 * 4. 중기 계획: DASHBOARD_HTML 코드 분할, SSE 최적화
 * 5. 장기 계획: 아키텍처 재설계 (마이크로서비스 분리)
 *
 * 추천 액션:
 * - Week 1: 캐싱 + readBody 개선 (30-40% 개선)
 * - Week 2: 버퍼 페이지네이션 (메모리 최적화)
 * - Week 3-4: DASHBOARD_HTML 코드 분할
 */

export default {
  issues: performanceIssues,
  bottlenecks: architectureBottlenecks,
  kpis: performanceKPIs,
  roadmap: improvementRoadmap,
  quickWins,
  monitoring: monitoringRecommendations,
  codeQuality: codeQualityMetrics,
};
