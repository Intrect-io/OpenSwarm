// ============================================
// OpenSwarm - Locale Type Definitions
// ============================================

/**
 * All user-facing strings organized by module.
 * Both en.ts and ko.ts must implement this interface fully.
 */
export interface LocaleMessages {
  // ── Common ──────────────────────────────
  common: {
    timeAgo: {
      justNow: string;
      minutesAgo: string;   // {{n}} minutes ago
      hoursAgo: string;     // {{n}} hours ago
    };
    duration: {
      seconds: string;      // {{n}}s
      minutes: string;      // {{n}}min
      hours: string;        // {{n}}h
      days: string;         // {{n}}d
    };
    fallback: {
      noSummary: string;
      noDescription: string;
      noFeedback: string;
      noResponse: string;
      none: string;
      unknown: string;
    };
    moreItems: string;      // +{{n}} more
  };

  // ── Discord Command Handlers ────────────
  discord: {
    errors: {
      serviceNotInitialized: string;
      sessionNotFound: string;       // {{name}}
      unknownCommand: string;        // {{command}}
      commandError: string;          // {{error}}
      issueNotFound: string;         // {{id}}
      linearFetchFailed: string;     // {{error}}
      threadCreateFailed: string;    // {{error}}
      repoNotFound: string;          // {{repo}}
      taskNotFound: string;          // {{id}}
      runnerNotStarted: string;
      statsQueryFailed: string;      // {{error}}
      startFailed: string;           // {{error}}
    };
    status: {
      title: string;
      noAgents: string;
      noIssueAssigned: string;
      lastHeartbeat: string;         // {{time}}
      stateLabel: string;            // {{state}}
    };
    list: {
      noSessions: string;
      activeSessions: string;
    };
    run: {
      usage: string;
      sessionNotExist: string;       // {{name}}
      taskSent: string;              // {{session}}, {{task}}
      output: string;                // {{session}}
    };
    pause: {
      usage: string;
      paused: string;                // {{name}}
    };
    resume: {
      usage: string;
      resumed: string;               // {{name}}
    };
    issues: {
      title: string;
      myIssues: string;
      sessionIssues: string;             // {{session}}
      noIssues: string;
      stateLabel: string;                // {{state}}
      priorityLabel: string;             // {{priority}}
      projectLabel: string;              // {{project}}
      labelsLabel: string;               // {{labels}}
      commentsCount: string;             // {{count}}
      page: string;                      // {{current}}, {{total}}
      usage: string;
      fetchError: string;                // {{error}}
    };
    issue: {
      title: string;
      stateLabel: string;                 // {{state}}
      notFound: string;                  // {{id}}
      fetchError: string;                // {{error}}
      noDescription: string;
      noComments: string;
      commentAuthor: string;             // {{author}}
      commentDate: string;               // {{date}}
    };
    log: {
      usage: string;
      sessionNotExist: string;       // {{name}}
      recentLines: string;           // {{session}}, {{lines}}
    };
    ci: {
      noRepos: string;
      checking: string;
    };
    notifications: {
      checking: string;
    };
    dev: {
      usage: string;
      noRepos: string;
      repoList: string;
      taskStarting: string;          // {{repo}}, {{path}}, {{task}}
      inProgress: string;            // {{repo}}
      completed: string;             // {{repo}}, {{exitCode}}
      noOutput: string;
      outputTooLong: string;         // {{total}}, {{shown}}
    };
    repos: {
      title: string;
      description: string;
      available: string;
      unavailable: string;
      tip: string;
      tipContent: string;
    };
    tasks: {
      noTasks: string;
      title: string;
      elapsed: string;               // {{seconds}}
      requester: string;             // {{user}}
      path: string;                  // {{path}}
      cancelHint: string;
    };
    cancel: {
      usage: string;
      cancelled: string;             // {{id}}
      notFound: string;              // {{id}}
    };
    limits: {
      title: string;
      issueCreation: string;
      remaining: string;             // {{n}}
      resetNote: string;
    };
    schedule: {
      title: string;
      runUsage: string;
      runStarted: string;            // {{name}}
      notFound: string;              // {{name}}
      toggleUsage: string;
      toggleEnabled: string;         // {{name}}
      toggleDisabled: string;        // {{name}}
      addUsage: string;
      addSuccess: string;            // {{name}}, {{schedule}}
      addFailed: string;             // {{error}}
      removeUsage: string;
      removeSuccess: string;         // {{name}}
      helpText: string;
    };
    codex: {
      noSessions: string;
      title: string;
      saveUsage: string;
      saving: string;                // {{title}}, {{tags}}
      noTags: string;
      saveSuccess: string;           // {{path}}
      saveFailed: string;            // {{error}}
      pathLabel: string;             // {{path}}
      helpText: string;
    };
    auto: {
      title: string;
      statusLabel: string;
      statusRunning: string;
      statusStopped: string;
      completedFailed: string;       // {{completed}}, {{failed}}
      pendingApprovalLabel: string;
      pendingApproval: string;
      noPending: string;
      lastHeartbeatLabel: string;    // {{time}}
      notInitialized: string;
      startingPair: string;
      startingSolo: string;
      startedPair: string;
      startedSolo: string;
      stopped: string;
      runningHeartbeat: string;
      approved: string;
      noPendingApproval: string;
      rejected: string;
      helpText: string;
    };
    pair: {
      noActiveSessions: string;
      activeSessionsTitle: string;
      noPendingIssues: string;
      usage: string;
      sessionStarted: string;        // {{thread}}
      taskStartTitle: string;        // {{title}}
      sessionStartMsg: string;
      loopError: string;             // {{error}}
      workerStarting: string;        // {{attempt}}, {{max}}
      reviewerStarting: string;
      maxAttemptsExceeded: string;
      workApproved: string;
      workRejected: string;
      revisionNeeded: string;
      sessionCancelled: string;
      maxAttemptsEnd: string;
      cancelledMsg: string;          // {{id}}
      cancelNotFound: string;        // {{id}}
      noHistory: string;
      historyTitle: string;
      helpText: string;
      stats: {
        title: string;
        totalSessions: string;       // {{n}}
        successRate: string;         // {{n}}
        firstAttemptRate: string;    // {{n}}
        approved: string;            // {{n}}
        rejected: string;            // {{n}}
        failed: string;              // {{n}}
        cancelled: string;           // {{n}}
        avgAttempts: string;         // {{n}}
        avgDuration: string;         // {{duration}}
        avgFiles: string;            // {{n}}
        dailyTitle: string;
        noData: string;
      };
      summary: {
        completed: string;
        rejected: string;
        failed: string;
        cancelled: string;
        statsLabel: string;
        attempts: string;            // {{n}}, {{max}}
        duration: string;            // {{duration}}
        filesChanged: string;        // {{n}}
        filesLabel: string;
        reviewerFeedback: string;
        decisionLabel: string;       // {{decision}}
        feedbackLabel: string;       // {{feedback}}
        discussionSummary: string;   // {{count}}
        noFiles: string;
      };
    };
    help: string; // Full help text block
    toolCalls: string;               // {{n}}
    chatError: string;
    projectContext: string;           // {{path}}
    chatContext: string;
  };

  // ── Agent Prompts & Formatting ──────────
  agents: {
    worker: {
      report: {
        completed: string;
        failed: string;
        summary: string;             // {{text}}
        filesChanged: string;        // {{count}}, {{list}}
        commands: string;            // {{list}}
        error: string;               // {{text}}
      };
    };
    reviewer: {
      report: {
        decision: string;            // {{emoji}}, {{text}}
        feedback: string;            // {{text}}
        issues: string;
        suggestions: string;
      };
      revision: {
        header: string;
        decision: string;            // {{text}}
        feedback: string;            // {{text}}
        issuesToFix: string;
        suggestionsToConsider: string;
        applyFeedback: string;
      };
    };
    planner: {
      report: {
        analysisFailed: string;
        noDecomposition: string;
        reason: string;              // {{text}}
        estimatedTime: string;       // {{n}}
        decompositionDone: string;
        original: string;            // {{text}}
        subTasksHeader: string;      // {{count}}, {{totalMinutes}}
        dependency: string;          // {{deps}}
      };
    };
  };

  // ── Coordination board ─────────────────
  coordination: {
    stage: {
      takingOn: string;             // {{title}}
      failed: string;               // {{seconds}}, {{detail}}
      finished: string;             // {{seconds}}
      didNotPass: string;           // {{seconds}}
    };
    instructionSnapshot: string;    // {{digest}}, {{count}}
    mcpDenied: string;              // {{name}}, {{reason}}
    threadAction: {
      created: string;              // {{subject}}
      replied: string;              // {{subject}}
      resolved: string;             // {{subject}}
    };
    humanQuestion: {
      operatorPaged: string;
      humanAnswered: string;
      supervisorAnswered: string;
      siblingAnswered: string;
    };
    periodicReview: {
      title: string;
      description: string;
      noChangesReason: string;
      started: string;              // {{profile}}
      noOutput: string;             // {{profile}}
    };
    orchestrator: {
      adapterRejected: string;      // {{adapter}}
      routed: string;               // {{adapter}}, {{model}}
      discoveryFailed: string;      // {{error}}
      mcpUnavailable: string;
      started: string;              // {{trigger}}
      completed: string;            // {{granted}}, {{denied}}
      failed: string;               // {{error}}
    };
    council: {
      update: string;               // {{action}}, {{subject}}
      actions: {
        opened: string;
        evidence: string;
        ballot: string;
        finalized: string;
        expired: string;
        consumed: string;
      };
      outcomes: {
        selected: string;
        tieBreak: string;
        noQuorum: string;
      };
      opened: string;               // {{id}}, {{snapshot}}, {{options}}, {{quorum}}, {{taskQuorum}}, {{roleQuorum}}
      evidence: string;             // {{id}}, {{option}}, {{summary}}, {{refs}}
      ballot: string;               // {{id}}, {{actor}}, {{role}}, {{ranking}}, {{confidence}}, {{evidence}}
      finalized: string;            // {{id}}, {{outcome}}, {{selection}}, {{tally}}, {{missing}}
      selected: string;             // {{option}}, {{ranking}}
      consumed: string;             // {{id}}, {{actor}}, {{snapshot}}, {{version}}
      none: string;
      unknownRole: string;
    };
  };

  // ── Service ─────────────────────────────
  service: {
    startComplete: string;
    agentCount: string;              // {{n}}
    repoCount: string;               // {{n}}
    heartbeatInterval: string;       // {{n}}
    startedMessage: string;          // {{agents}}, {{schedules}}, {{autoStatus}}
    autoModeActive: string;          // {{mode}}
    scheduler: {
      noSchedules: string;
      lastRunLabel: string;          // {{time}}
    };
    issueContext: {
      continueWork: string;
      issue: string;                 // {{id}}, {{title}}
      description: string;
      recentProgress: string;
      instructions: string;
    };
    events: {
      issueStarted: string;          // {{id}}, {{title}}
      issueCompleted: string;        // {{id}}, {{detail}}
      issueBlocked: string;          // {{id}}, {{reason}}
      commit: string;                // {{detail}}
      ciFailDetected: string;        // {{repo}}, {{failures}}
      ciRecovered: string;           // {{repo}}, {{duration}}
      ciStillFailing: string;        // {{repo}}, {{days}}, {{failures}}
    };
  };

  // ── Time Window ─────────────────────────
  timeWindow: {
    disabled: string;
    weekendOrUnrestricted: string;
    blockedWindow: string;           // {{start}}, {{end}}
    allowedWindow: string;           // {{start}}, {{end}}
    outsideAllowed: string;
    tomorrowAt: string;              // {{time}}
    marketStatus: {
      preMarket: string;
      regular: string;
      postMarket: string;
      closed: string;
    };
    workAllowed: string;
    workBlocked: string;
    currentTime: string;             // {{time}}
    status: string;                  // {{description}}
    nextAllowed: string;             // {{time}}
    taskBlocked: string;             // {{task}}, {{reason}}, {{time}}
    taskBlockedNoName: string;       // {{reason}}, {{time}}
    nextAllowedTime: string;         // {{time}}
  };

  // ── Autonomous Runner ───────────────────
  runner: {
    modeStarted: string;
    pipelineError: string;           // {{title}}, {{error}}
    consecutiveErrors: string;       // {{count}}, {{error}}
    decomposition: {
      starting: string;              // {{title}}, {{estimated}}, {{threshold}}
      plannerRunning: string;
      completed: string;             // {{original}}, {{count}}, {{list}}, {{totalMinutes}}
      prerequisite: string;          // {{deps}}
      autoDecomposed: string;        // {{parentTitle}}
      estimatedTime: string;         // {{n}}
    };
    pipeline: {
      starting: string;              // {{title}}, {{project}}, {{stages}}
      revisionNeeded: string;        // {{stage}}
    };
    approval: {
      title: string;
      question: string;              // {{project}}, {{title}}
      reason: string;                // {{text}}
      footer: string;
    };
    result: {
      taskCompleted: string;
      taskFailed: string;
      taskLabel: string;
      duration: string;
      completedSteps: string;
      failedStep: string;
      rollback: string;
    };
    taskStarting: string;
    analysisResult: string;
    reviewRejected: string;          // {{feedback}}
    projectMappingFailed: string;    // {{title}}, {{project}}
  };
}

/**
 * Prompt template functions for each agent role.
 */
/** Worker에 주입할 코드 컨텍스트 (반복 횟수 감소 목적) */
export interface WorkerContext {
  /**
   * Durable task write boundary. This is rendered to the worker so it can plan
   * inside the same scope the runner will enforce after execution.
   */
  fileScope?: string[];
  /**
   * Pull requests already merged or closed for this issue. The attempt exists
   * because the issue was reopened; the worker must not redo delivered work.
   */
  priorDeliveries?: string[];
  /**
   * What the repository's other worktrees are editing right now, so a worker
   * can see an overlap before its branch collides with theirs at integration.
   */
  siblingWork?: { identifier: string; files: string[] }[];
  /** Repository/toolchain capsule captured before a fix worker mutates files. */
  repository?: {
    packageManager?: string;
    workspaces: string[];
    manifests: string[];
    verificationCommands: string[];
    sharedPaths: string[];
    dependencyGraphAvailable: boolean;
  };
  /** Knowledge Graph 기반 영향 분석 */
  impactAnalysis?: {
    directModules: string[];
    dependentModules: string[];
    testFiles: string[];
    estimatedScope: 'small' | 'medium' | 'large';
  };
  /** 변경 대상 파일별 entity 상태 요약 */
  registryBriefs?: Array<{
    filePath: string;
    summary: string;  // "5 entities, 1 deprecated, 2 untested"
    highlights: string[];  // deprecated/broken/critical warning 엔티티명
    /** 파일 내 entity 목록 (Worker가 파일을 읽지 않고 구조 파악 가능) */
    entities?: Array<{
      kind: string;    // function, class, type, etc.
      name: string;
      signature?: string;  // 시그니처 (파라미터, 반환타입)
      status: string;  // active, deprecated, broken
      hasTests: boolean;
    }>;
  }>;
  /** Draft Analyzer 사전 분석 결과 (Haiku) */
  draftAnalysis?: {
    taskType: string;
    intentSummary: string;
    relevantFiles: string[];
    suggestedApproach: string;
    projectStats?: string;
    /** Execution-grounded definition of done (INT-1914). */
    completionCriteria?: string[];
    /** drafter hard gate (INT-1917): false when the brief is incomplete. */
    sufficient?: boolean;
  };
  /** Repo knowledge accumulated from past tasks (memory/repoKnowledge.recallRepoKnowledge) */
  repoMemories?: Array<{
    type: string;     // system_pattern (success pattern) | constraint (pitfall) | fact ...
    title: string;
    content: string;
  }>;
}

export interface PromptTemplates {
  systemPrompt: string;
  /** Coordination-only system guidance, appended only when those tools are exposed. */
  coordinationConsultationPrompt: string;
  buildWorkerPrompt: (opts: {
    taskTitle: string;
    taskDescription: string;
    authoritativeOperatorFeedback?: string;
    previousFeedback?: string;
    context?: WorkerContext;
  }) => string;
  buildReviewerPrompt: (opts: {
    taskTitle: string;
    taskDescription: string;
    workerReport: string;
    authoritativeOperatorFeedback?: string;
    /** Execution-grounded definition of done the reviewer hard-gates on (INT-1914). */
    completionCriteria?: string[];
    /** Pre-rendered deterministic harness evidence; empty when verification is unavailable. */
    verificationEvidence?: string;
    /** Repository-local results from earlier review commands, rendered as untrusted data. */
    priorReviewContext?: string;
    /**
     * 'change' (default): review a worker's diff against requirements — the pair
     * pipeline. 'audit': evaluate existing files with no diff/worker — the
     * `review --max` codebase audit. (INT-2006)
     */
    mode?: 'change' | 'audit' | 'direct';
  }) => string;
  buildRevisionPromptFromReview: (opts: {
    decision: string;
    feedback: string;
    issues: string[];
    suggestions: string[];
  }) => string;
  buildPlannerPrompt: (opts: {
    taskTitle: string;
    taskDescription: string;
    projectName: string;
    targetMinutes: number;
    authoritativeOperatorFeedback?: string;
    impactAnalysis?: {
      directModules: string[];
      dependentModules: string[];
      testFiles: string[];
      estimatedScope: 'small' | 'medium' | 'large';
    };
    draftAnalysis?: {
      taskType: string;
      intentSummary: string;
      relevantFiles: string[];
      suggestedApproach: string;
      projectStats?: string;
    };
  }) => string;
}

export type SupportedLocale = 'en' | 'ko';
