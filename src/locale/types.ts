// ============================================
// Claude Swarm - Locale Type Definitions
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
      seconds: string;      // {{n}}s / {{n}}초
      minutes: string;      // {{n}}min / {{n}}분
      hours: string;        // {{n}}h / {{n}}시간
      days: string;         // {{n}}d / {{n}}일
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
      notImplemented: string;
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
      statusRunning: string;
      statusStopped: string;
      completedFailed: string;       // {{completed}}, {{failed}}
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
export interface PromptTemplates {
  vegaSystem: string;
  buildWorkerPrompt: (opts: {
    taskTitle: string;
    taskDescription: string;
    previousFeedback?: string;
  }) => string;
  buildReviewerPrompt: (opts: {
    taskTitle: string;
    taskDescription: string;
    workerReport: string;
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
  }) => string;
}

export type SupportedLocale = 'en' | 'ko';
