// ============================================
// Claude Swarm - Korean Locale Messages
// ============================================

import { LocaleMessages } from './types.js';

export const ko: LocaleMessages = {
  // ── Common ──────────────────────────────
  common: {
    timeAgo: {
      justNow: '방금 전',
      minutesAgo: '{{n}}분 전',
      hoursAgo: '{{n}}시간 전',
    },
    duration: {
      seconds: '{{n}}초',
      minutes: '{{n}}분',
      hours: '{{n}}시간',
      days: '{{n}}일',
    },
    fallback: {
      noSummary: '(요약 없음)',
      noDescription: '(없음)',
      noFeedback: '(피드백 없음)',
      noResponse: '(응답 없음)',
      none: '없음',
      unknown: '알 수 없음',
    },
    moreItems: '+{{n}}개 더',
  },

  // ── Discord Command Handlers ────────────
  discord: {
    errors: {
      serviceNotInitialized: '서비스가 초기화되지 않았습니다.',
      sessionNotFound: '세션 "{{name}}"을 찾을 수 없습니다.',
      unknownCommand: '알 수 없는 명령어: {{command}}. !help로 도움말 확인',
      commandError: '오류 발생: {{error}}',
      issueNotFound: '이슈를 찾을 수 없습니다: `{{id}}`',
      linearFetchFailed: 'Linear 조회 실패: {{error}}',
      threadCreateFailed: '스레드 생성 실패: {{error}}',
      repoNotFound: '저장소를 찾을 수 없습니다: `{{repo}}`\n\n`!dev list`로 사용 가능한 저장소를 확인하세요.',
      taskNotFound: '작업을 찾을 수 없습니다: `{{id}}`',
      runnerNotStarted: 'Runner가 시작되지 않았습니다. `!auto start` 먼저 실행하세요.',
      statsQueryFailed: '통계 조회 실패: {{error}}',
      startFailed: '시작 실패: {{error}}',
    },
    status: {
      title: '🤖 Claude Swarm 상태',
      noAgents: '활성 에이전트가 없습니다.',
      noIssueAssigned: '📋 할당된 이슈 없음',
      lastHeartbeat: '🕐 마지막 heartbeat: {{time}}',
      stateLabel: '상태: {{state}}',
    },
    list: {
      noSessions: '활성 세션이 없습니다.',
      activeSessions: '**활성 세션:**',
    },
    run: {
      usage: '사용법: !run <session> "<task>"',
      sessionNotExist: '세션 "{{name}}"이 존재하지 않습니다.',
      taskSent: '✅ **{{session}}**에 작업 전송:\n`{{task}}`',
      output: '**[{{session}}] 출력:**',
    },
    pause: {
      usage: '사용법: !pause <session>',
      paused: '⏸️ **{{name}}** 자율 작업 일시 중지',
    },
    resume: {
      usage: '사용법: !resume <session>',
      resumed: '▶️ **{{name}}** 자율 작업 재개',
    },
    issues: {
      notImplemented: 'Linear 이슈 조회 기능 구현 예정',
    },
    log: {
      usage: '사용법: !log <session> [lines]',
      sessionNotExist: '세션 "{{name}}"이 존재하지 않습니다.',
      recentLines: '**[{{session}}] 최근 {{lines}}줄:**',
    },
    ci: {
      noRepos: '설정된 GitHub 레포가 없습니다.',
      checking: '🔍 CI 상태 확인 중...',
    },
    notifications: {
      checking: '🔍 GitHub 알림 확인 중...',
    },
    dev: {
      usage: '**사용법:** `!dev <repo> "<task>"`\n**예시:** `!dev pykis "get_balance API 파라미터 확인해줘"`\n\n`!dev list` - 알려진 저장소 목록\n`!dev scan` - ~/dev 폴더 스캔',
      noRepos: '~/dev에서 Git 저장소를 찾을 수 없습니다.',
      repoList: '**~/dev 저장소 목록:**',
      taskStarting: '🚀 **{{repo}}**에서 작업 시작...\n📁 `{{path}}`\n📝 `{{task}}`',
      inProgress: '**[{{repo}}] 진행 중...**',
      completed: '**[{{repo}}] 완료** (exit: {{exitCode}})',
      noOutput: '(출력 없음)',
      outputTooLong: '...(출력이 너무 깁니다. 전체 {{total}}개 청크 중 {{shown}}개만 표시)',
    },
    repos: {
      title: '📁 알려진 저장소',
      description: '`!dev <별칭> "<작업>"` 형식으로 사용',
      available: '✅ 사용 가능',
      unavailable: '❌ 경로 없음',
      tip: '💡 팁',
      tipContent: '`!dev scan`으로 ~/dev 폴더 전체 스캔\n상대경로도 가능: `!dev tools/pykis "..."`',
    },
    tasks: {
      noTasks: '실행 중인 dev 작업이 없습니다.',
      title: '🔄 실행 중인 작업',
      elapsed: '경과: {{seconds}}초',
      requester: '요청자: {{user}}',
      path: '경로: {{path}}',
      cancelHint: '!cancel <taskId>로 취소 가능',
    },
    cancel: {
      usage: '사용법: `!cancel <taskId>`\n`!tasks`로 작업 ID 확인',
      cancelled: '⏹️ 작업 취소됨: `{{id}}`',
      notFound: '❌ 작업을 찾을 수 없습니다: `{{id}}`',
    },
    limits: {
      title: '📊 에이전트 일일 제한',
      issueCreation: 'Linear 이슈 생성',
      remaining: '남은 횟수: **{{n}}**개',
      resetNote: '매일 자정(UTC) 리셋',
    },
    schedule: {
      title: '📅 스케줄 목록',
      runUsage: '사용법: `!schedule run <name>`',
      runStarted: '▶️ **{{name}}** 스케줄 즉시 실행 시작',
      notFound: '❌ 스케줄을 찾을 수 없습니다: `{{name}}`',
      toggleEnabled: '🟢 활성화: **{{name}}**',
      toggleDisabled: '⏸️ 비활성화: **{{name}}**',
      addUsage: '**사용법:**\n`!schedule add <name> <project_path> <interval> "<prompt>"`\n\n**예시:**\n`!schedule add myproject-check ~/dev/myproject 30m "테스트 실행하고 결과 보고해줘"`\n\n**interval:** `30m`, `1h`, `2h`, `1d` 또는 cron 표현식',
      addSuccess: '✅ 스케줄 추가됨: **{{name}}** ({{schedule}})',
      addFailed: '❌ 스케줄 추가 실패: {{error}}',
      removeUsage: '사용법: `!schedule remove <name>`',
      removeSuccess: '🗑️ 스케줄 삭제됨: **{{name}}**',
      helpText: '**스케줄 명령어:**\n`!schedule` - 스케줄 목록\n`!schedule run <name>` - 즉시 실행\n`!schedule toggle <name>` - 활성화/비활성화\n`!schedule add <name> <path> <interval> "<prompt>"` - 추가\n`!schedule remove <name>` - 삭제',
    },
    codex: {
      noSessions: '📚 기록된 세션이 없습니다.\n`!codex save "<제목>"` 으로 현재 세션을 저장하세요.',
      title: '📚 Codex - 최근 세션',
      saveUsage: '사용법: `!codex save "<제목>" [tags...]`\n예시: `!codex save "pykis CI 수정" ci fix`',
      saving: '📝 세션 저장 중...\n제목: **{{title}}**\n태그: {{tags}}',
      noTags: '없음',
      saveSuccess: '✅ 세션 저장 완료!\n📄 `{{path}}`',
      saveFailed: '❌ 저장 실패: {{error}}',
      pathLabel: '📁 Codex 경로: `{{path}}`',
      helpText: '**📚 Codex 명령어:**\n`!codex` - 최근 세션 목록\n`!codex save "<제목>" [tags]` - 세션 저장\n`!codex path` - 저장 경로 확인',
    },
    auto: {
      title: '🤖 자율 실행 상태',
      statusRunning: '✅ 실행 중',
      statusStopped: '⏹️ 중지',
      completedFailed: '{{completed}}/{{failed}}',
      pendingApproval: '⏳ 있음',
      noPending: '없음',
      lastHeartbeatLabel: '마지막 Heartbeat',
      notInitialized: '🤖 자율 실행이 초기화되지 않았습니다.\n`!auto start` 로 시작하세요.',
      startingPair: '🚀 자율 실행 모드 시작 중... (Worker/Reviewer 페어 모드)',
      startingSolo: '🚀 자율 실행 모드 시작 중... (단일 에이전트)',
      startedPair: '✅ 자율 실행 모드 (페어)가 시작되었습니다.\nWorker가 작업하고 Reviewer가 검토합니다.',
      startedSolo: '✅ 자율 실행 모드가 시작되었습니다.',
      stopped: '⏹️ 자율 실행 모드가 중지되었습니다.',
      runningHeartbeat: '🔄 Heartbeat 실행 중...',
      approved: '✅ 작업이 승인되어 실행됩니다.',
      noPendingApproval: '⏳ 승인 대기 중인 작업이 없습니다.',
      rejected: '❌ 작업이 거부되었습니다.',
      helpText: '**🤖 자율 실행 명령어:**\n`!auto` - 상태 확인\n`!auto start [cron] [--pair]` - 시작 (기본: 30분마다)\n  예: `!auto start */30 * * * * --pair` (페어 모드)\n`!auto stop` - 중지\n`!auto run` - 즉시 실행\n`!approve` - 대기 중인 작업 승인\n`!reject` - 대기 중인 작업 거부',
    },
    pair: {
      noActiveSessions: '👥 활성 페어 세션이 없습니다.\n`!pair start` 로 시작하세요.',
      activeSessionsTitle: '👥 활성 페어 세션',
      noPendingIssues: '❌ 대기 중인 이슈가 없습니다.',
      usage: '사용법: `!pair run <taskId> [project]`',
      sessionStarted: '👥 페어 세션 시작됨: {{thread}}',
      taskStartTitle: '📋 페어 작업 시작: {{title}}',
      sessionStartMsg: '페어 세션이 시작되었습니다.',
      loopError: '❌ 페어 루프 오류: {{error}}',
      workerStarting: '🔨 **[Worker]** 작업 시작... (시도 {{attempt}}/{{max}})',
      reviewerStarting: '🔍 **[Reviewer]** 리뷰 시작...',
      maxAttemptsExceeded: '❌ **[System]** 최대 시도 횟수 초과. 작업 실패.',
      workApproved: '✅ **[System]** 작업이 승인되었습니다!',
      workRejected: '❌ **[System]** 작업이 거부되었습니다. 수동 개입이 필요합니다.',
      revisionNeeded: '🔄 **[System]** 수정이 필요합니다. Worker가 재작업합니다...',
      sessionCancelled: '🚫 세션이 취소되었습니다.',
      maxAttemptsEnd: '❌ **[System]** 최대 시도 횟수 초과. 작업 종료.',
      cancelledMsg: '🚫 페어 세션 취소됨: `{{id}}`',
      cancelNotFound: '❌ 세션을 찾을 수 없거나 이미 종료됨: `{{id}}`',
      noHistory: '📚 페어 세션 히스토리가 없습니다.',
      historyTitle: '📚 페어 세션 히스토리',
      helpText: '**👥 Worker/Reviewer 페어 명령어:**\n`!pair` - 현재 페어 세션 상태\n`!pair start [taskId]` - 페어 세션 시작\n`!pair run <taskId> [project]` - 직접 페어 실행\n`!pair stop [sessionId]` - 세션 중지\n`!pair history [n]` - 최근 n개 히스토리\n`!pair stats` - 통계 조회',
      stats: {
        title: '📊 페어 모드 통계',
        totalSessions: '**총 세션:** {{n}}개',
        successRate: '**성공률:** {{n}}%',
        firstAttemptRate: '**첫 시도 성공률:** {{n}}%',
        approved: '✅ 승인: {{n}}',
        rejected: '❌ 거부: {{n}}',
        failed: '💥 실패: {{n}}',
        cancelled: '🚫 취소: {{n}}',
        avgAttempts: '**시도 횟수:** {{n}}회',
        avgDuration: '**소요 시간:** {{duration}}',
        avgFiles: '**변경 파일:** {{n}}개',
        dailyTitle: '📅 일별 통계 (최근 7일)',
        noData: '(데이터 없음)',
      },
      summary: {
        completed: '작업 완료',
        rejected: '작업 거부됨',
        failed: '작업 실패',
        cancelled: '작업 취소됨',
        statsLabel: '📊 통계',
        attempts: '**시도 횟수:** {{n}}/{{max}}',
        duration: '**소요 시간:** {{duration}}',
        filesChanged: '**변경 파일:** {{n}}개',
        filesLabel: '📁 변경된 파일',
        reviewerFeedback: '🔍 Reviewer 피드백',
        decisionLabel: '**결정:** {{decision}}',
        feedbackLabel: '**피드백:** {{feedback}}',
        discussionSummary: '📜 **토론 요약** ({{count}}개 메시지)',
        noFiles: '없음',
      },
    },
    help: `**Claude Swarm 명령어**

**Dev 작업** (Claude 디스패치)
\`!dev <repo> "<task>"\` - 저장소에서 dev 작업 실행
\`!dev list\` - 알려진 저장소 목록
\`!dev scan\` - ~/dev 폴더 스캔
\`!repos\` - 저장소 목록 (상세)
\`!tasks\` - 실행 중인 작업 목록
\`!cancel <taskId>\` - 작업 취소

**에이전트 관리**
\`!status [session]\` - 에이전트 상태 확인
\`!list\` - 세션 목록 (deprecated)
\`!run <session> "<task>"\` - 특정 작업 실행
\`!pause <session>\` - 자율 작업 일시 중지
\`!resume <session>\` - 자율 작업 재개
\`!log <session> [lines]\` - 최근 출력 확인

**Linear**
\`!issues [session]\` - Linear 이슈 목록
\`!limits\` - 에이전트 일일 제한

**스케줄**
\`!schedule\` - 스케줄 목록
\`!schedule run <name>\` - 즉시 실행
\`!schedule toggle <name>\` - 활성화/비활성화
\`!schedule add <name> <path> <interval> "<prompt>"\` - 추가
\`!schedule remove <name>\` - 삭제

**GitHub**
\`!ci\` - CI 실패 상태
\`!notif\` - GitHub 알림

**Codex (세션 기록)**
\`!codex\` - 최근 세션
\`!codex save "<제목>"\` - 세션 저장
\`!codex path\` - 저장 경로

**자율 실행**
\`!auto\` - 실행 상태
\`!auto start [cron] [--pair]\` - 시작 (기본: 30분마다, --pair로 페어 모드)
\`!auto stop\` - 중지
\`!auto run\` - 즉시 heartbeat 실행
\`!approve\` - 대기 중인 작업 승인
\`!reject\` - 대기 중인 작업 거부

**Worker/Reviewer 페어**
\`!pair\` - 페어 세션 상태
\`!pair start [taskId]\` - 페어 세션 시작
\`!pair run <taskId> [project]\` - 직접 페어 실행
\`!pair stop [sessionId]\` - 세션 중지
\`!pair history [n]\` - 히스토리 확인
\`!pair stats\` - 통계 확인

\`!help\` - 이 도움말

---
**예시:**
\`!dev pykis "get_balance 함수 파라미터 확인"\`
\`!dev tools/pykiwoom "실시간 구독 로직 분석"\``,
    toolCalls: '🔧 **도구 호출 ({{n}}개)**',
    chatError: '오류가 발생했습니다. 다시 시도해주세요.',
    projectContext: '## 프로젝트 컨텍스트\n- **작업 디렉토리**: {{path}}\n- 이 프로젝트의 코드베이스에서 작업 중입니다.',
    chatContext: '## 대화 컨텍스트',
  },

  // ── Agent Prompts & Formatting ──────────
  agents: {
    worker: {
      report: {
        completed: '✅ **Worker 작업 완료**',
        failed: '❌ **Worker 작업 실패**',
        summary: '**요약:** {{text}}',
        filesChanged: '**변경 파일 ({{count}}):** {{list}}',
        commands: '**실행 명령:** {{list}}',
        error: '**에러:** {{text}}',
      },
    },
    reviewer: {
      report: {
        decision: '**Reviewer 결정: {{text}}**',
        feedback: '**피드백:** {{text}}',
        issues: '**문제점:**',
        suggestions: '**개선 제안:**',
      },
      revision: {
        header: '## Reviewer Feedback',
        decision: '**결정:** {{text}}',
        feedback: '**피드백:** {{text}}',
        issuesToFix: '### 해결해야 할 문제점:',
        suggestionsToConsider: '### 개선 제안:',
        applyFeedback: '위 피드백을 반영하여 코드를 수정하라.',
      },
    },
    planner: {
      report: {
        analysisFailed: '❌ **Planner 분석 실패**',
        noDecomposition: '✅ **분해 불필요**',
        reason: '이유: {{text}}',
        estimatedTime: '예상 시간: {{n}}분',
        decompositionDone: '📋 **작업 분해 완료**',
        original: '원본: {{text}}',
        subTasksHeader: '**Sub-tasks ({{count}}개, 총 {{totalMinutes}}분):**',
        dependency: ' (선행: {{deps}})',
      },
    },
  },

  // ── Service ─────────────────────────────
  service: {
    startComplete: 'Claude Swarm 서비스 시작 완료!',
    agentCount: '에이전트: {{n}}개',
    repoCount: 'GitHub 레포: {{n}}개',
    heartbeatInterval: '기본 heartbeat: {{n}}분',
    startedMessage: 'Claude Swarm 시작됨. {{agents}}개 에이전트, {{schedules}}개 스케줄 활성화{{autoStatus}}.',
    autoModeActive: ', 자율모드 활성 ({{mode}})',
    scheduler: {
      noSchedules: '등록된 스케줄이 없습니다.',
      lastRunLabel: '마지막: {{time}}',
    },
    issueContext: {
      continueWork: 'Linear 이슈 작업 계속:',
      issue: '이슈: {{id}} - {{title}}',
      description: '설명:',
      recentProgress: '최근 진행 상황:',
      instructions: '위 컨텍스트를 바탕으로 작업을 계속해줘.\n진행상황이 있으면 알려주고, 완료되면 "DONE: <요약>"으로 알려줘.\n막히면 "BLOCKED: <이유>"로 알려줘.',
    },
    events: {
      issueStarted: '이슈 시작: {{id}} {{title}}',
      issueCompleted: '이슈 완료: {{id}} {{detail}}',
      issueBlocked: '이슈 막힘: {{id}}\n이유: {{reason}}',
      commit: '커밋: {{detail}}',
      ciFailDetected: '**{{repo}}** CI 실패 감지\n{{failures}}',
      ciRecovered: '**{{repo}}** CI 복구됨 ({{duration}} 만에)',
      ciStillFailing: '**{{repo}}** CI 여전히 실패 중 ({{days}}일째)\n{{failures}}',
    },
  },

  // ── Time Window ─────────────────────────
  timeWindow: {
    disabled: '시간 제한 비활성화',
    weekendOrUnrestricted: '주말/제한 없는 요일',
    blockedWindow: '차단 시간대 ({{start}} ~ {{end}})',
    allowedWindow: '허용 시간대 ({{start}} ~ {{end}})',
    outsideAllowed: '허용 시간대 외',
    tomorrowAt: '내일 {{time}}',
    marketStatus: {
      preMarket: '장전 시간외 (08:30~09:00)',
      regular: '정규장 (09:00~15:30)',
      postMarket: '장후 시간외 (15:40~18:00)',
      closed: '폐장 (작업 가능)',
    },
    workAllowed: '작업 가능',
    workBlocked: '작업 차단',
    currentTime: '현재: {{time}}',
    status: '상태: {{description}}',
    nextAllowed: '다음 허용: {{time}}',
    taskBlocked: '[TimeWindow] "{{task}}" 작업 차단: {{reason}} (현재: {{time}})',
    taskBlockedNoName: '[TimeWindow] 작업 차단: {{reason}} (현재: {{time}})',
    nextAllowedTime: ' 다음 허용 시간: {{time}}',
  },

  // ── Autonomous Runner ───────────────────
  runner: {
    modeStarted: '🤖 **자율 실행 모드 시작**',
    pipelineError: '❌ **파이프라인 에러**: {{title}}\n```{{error}}```',
    consecutiveErrors: '⚠️ **자율 실행 오류** (연속 {{count}}회)\n```{{error}}```',
    decomposition: {
      starting: '📋 **작업 분해 시작**\n작업: {{title}}\n예상 시간: {{estimated}}분 (>{{threshold}}분)\nPlanner가 sub-tasks로 분해 중...',
      plannerRunning: 'Planner 분석 중...',
      completed: '✅ **작업 분해 완료**\n\n원본: {{original}}\n생성된 sub-issues ({{count}}개):\n{{list}}\n\n총 예상 시간: {{totalMinutes}}분',
      prerequisite: '**선행 작업:** {{deps}}',
      autoDecomposed: '---\n_Planner에 의해 "{{parentTitle}}"에서 자동 분해됨_',
      estimatedTime: '**예상 시간:** {{n}}분',
    },
    pipeline: {
      starting: '🚀 파이프라인 시작',
      revisionNeeded: '🔄 수정이 필요합니다. {{stage}} 피드백으로 Worker가 재작업합니다...',
    },
    approval: {
      title: '⏳ 승인 대기',
      question: '다음 작업을 실행할까요?\n\n{{project}}**{{title}}**',
      reason: '사유',
      footer: '!approve 또는 !reject 로 응답',
    },
    result: {
      taskCompleted: '✅ 작업 완료',
      taskFailed: '❌ 작업 실패',
      taskLabel: '작업',
      duration: '소요 시간',
      completedSteps: '완료 Step',
      failedStep: '실패 Step',
      rollback: 'Rollback',
    },
    taskStarting: '🚀 작업 시작',
    analysisResult: '📋 **분석 결과**',
    reviewRejected: '리뷰 거부됨: {{feedback}}',
    projectMappingFailed: '❌ **프로젝트 매핑 실패**: {{title}}\n프로젝트: {{project}}',
  },
};
