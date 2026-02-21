// ============================================
// Claude Swarm - English Locale Messages
// ============================================

import { LocaleMessages } from './types.js';

export const en: LocaleMessages = {
  // ── Common ──────────────────────────────
  common: {
    timeAgo: {
      justNow: 'just now',
      minutesAgo: '{{n}} min ago',
      hoursAgo: '{{n}}h ago',
    },
    duration: {
      seconds: '{{n}}s',
      minutes: '{{n}}min',
      hours: '{{n}}h',
      days: '{{n}}d',
    },
    fallback: {
      noSummary: '(no summary)',
      noDescription: '(none)',
      noFeedback: '(no feedback)',
      noResponse: '(no response)',
      none: 'none',
      unknown: 'unknown',
    },
    moreItems: '+{{n}} more',
  },

  // ── Discord Command Handlers ────────────
  discord: {
    errors: {
      serviceNotInitialized: 'Service not initialized.',
      sessionNotFound: 'Session "{{name}}" not found.',
      unknownCommand: 'Unknown command: {{command}}. Use !help for help',
      commandError: 'Error: {{error}}',
      issueNotFound: 'Issue not found: `{{id}}`',
      linearFetchFailed: 'Linear query failed: {{error}}',
      threadCreateFailed: 'Thread creation failed: {{error}}',
      repoNotFound: 'Repository not found: `{{repo}}`\n\nUse `!dev list` to see available repositories.',
      taskNotFound: 'Task not found: `{{id}}`',
      runnerNotStarted: 'Runner not started. Run `!auto start` first.',
      statsQueryFailed: 'Stats query failed: {{error}}',
      startFailed: 'Start failed: {{error}}',
    },
    status: {
      title: 'Claude Swarm Status',
      noAgents: 'No active agents.',
      noIssueAssigned: 'No issue assigned',
      lastHeartbeat: 'Last heartbeat: {{time}}',
      stateLabel: 'State: {{state}}',
    },
    list: {
      noSessions: 'No active sessions.',
      activeSessions: '**Active sessions:**',
    },
    run: {
      usage: 'Usage: !run <session> "<task>"',
      sessionNotExist: 'Session "{{name}}" does not exist.',
      taskSent: 'Task sent to **{{session}}**:\n`{{task}}`',
      output: '**[{{session}}] Output:**',
    },
    pause: {
      usage: 'Usage: !pause <session>',
      paused: '**{{name}}** autonomous work paused',
    },
    resume: {
      usage: 'Usage: !resume <session>',
      resumed: '**{{name}}** autonomous work resumed',
    },
    issues: {
      notImplemented: 'Linear issue query coming soon',
    },
    log: {
      usage: 'Usage: !log <session> [lines]',
      sessionNotExist: 'Session "{{name}}" does not exist.',
      recentLines: '**[{{session}}] Last {{lines}} lines:**',
    },
    ci: {
      noRepos: 'No GitHub repos configured.',
      checking: 'Checking CI status...',
    },
    notifications: {
      checking: 'Checking GitHub notifications...',
    },
    dev: {
      usage: '**Usage:** `!dev <repo> "<task>"`\n**Example:** `!dev pykis "check get_balance API parameters"`\n\n`!dev list` - Show known repositories\n`!dev scan` - Scan ~/dev folder',
      noRepos: 'No Git repositories found in ~/dev.',
      repoList: '**~/dev repository list:**',
      taskStarting: 'Starting work on **{{repo}}**...\n`{{path}}`\n`{{task}}`',
      inProgress: '**[{{repo}}] In progress...**',
      completed: '**[{{repo}}] Completed** (exit: {{exitCode}})',
      noOutput: '(no output)',
      outputTooLong: '...(output too long. Showing {{shown}} of {{total}} chunks)',
    },
    repos: {
      title: 'Known Repositories',
      description: 'Use `!dev <alias> "<task>"` format',
      available: 'Available',
      unavailable: 'Path not found',
      tip: 'Tip',
      tipContent: 'Use `!dev scan` to scan entire ~/dev folder\nRelative paths also work: `!dev tools/pykis "..."`',
    },
    tasks: {
      noTasks: 'No running dev tasks.',
      title: 'Running Tasks',
      elapsed: 'Elapsed: {{seconds}}s',
      requester: 'Requested by: {{user}}',
      path: 'Path: {{path}}',
      cancelHint: 'Use !cancel <taskId> to cancel',
    },
    cancel: {
      usage: 'Usage: `!cancel <taskId>`\nUse `!tasks` to check task IDs',
      cancelled: 'Task cancelled: `{{id}}`',
      notFound: 'Task not found: `{{id}}`',
    },
    limits: {
      title: 'Agent Daily Limits',
      issueCreation: 'Linear Issue Creation',
      remaining: 'Remaining: **{{n}}**',
      resetNote: 'Resets daily at midnight (UTC)',
    },
    schedule: {
      title: 'Schedule List',
      runUsage: 'Usage: `!schedule run <name>`',
      runStarted: '**{{name}}** schedule executing now',
      notFound: 'Schedule not found: `{{name}}`',
      toggleEnabled: 'Enabled: **{{name}}**',
      toggleDisabled: 'Disabled: **{{name}}**',
      addUsage: '**Usage:**\n`!schedule add <name> <project_path> <interval> "<prompt>"`\n\n**Example:**\n`!schedule add myproject-check ~/dev/myproject 30m "run tests and report results"`\n\n**interval:** `30m`, `1h`, `2h`, `1d` or cron expression',
      addSuccess: 'Schedule added: **{{name}}** ({{schedule}})',
      addFailed: 'Schedule add failed: {{error}}',
      removeUsage: 'Usage: `!schedule remove <name>`',
      removeSuccess: 'Schedule deleted: **{{name}}**',
      helpText: '**Schedule commands:**\n`!schedule` - List schedules\n`!schedule run <name>` - Run now\n`!schedule toggle <name>` - Enable/disable\n`!schedule add <name> <path> <interval> "<prompt>"` - Add\n`!schedule remove <name>` - Remove',
    },
    codex: {
      noSessions: 'No recorded sessions.\nUse `!codex save "<title>"` to save the current session.',
      title: 'Codex - Recent Sessions',
      saveUsage: 'Usage: `!codex save "<title>" [tags...]`\nExample: `!codex save "pykis CI fix" ci fix`',
      saving: 'Saving session...\nTitle: **{{title}}**\nTags: {{tags}}',
      noTags: 'none',
      saveSuccess: 'Session saved!\n`{{path}}`',
      saveFailed: 'Save failed: {{error}}',
      pathLabel: 'Codex path: `{{path}}`',
      helpText: '**Codex commands:**\n`!codex` - Recent sessions\n`!codex save "<title>" [tags]` - Save session\n`!codex path` - Show save path',
    },
    auto: {
      title: 'Autonomous Execution Status',
      statusRunning: 'Running',
      statusStopped: 'Stopped',
      completedFailed: '{{completed}}/{{failed}}',
      pendingApproval: 'Pending',
      noPending: 'None',
      lastHeartbeatLabel: 'Last Heartbeat',
      notInitialized: 'Autonomous execution not initialized.\nUse `!auto start` to begin.',
      startingPair: 'Starting autonomous mode (Worker/Reviewer pair)...',
      startingSolo: 'Starting autonomous mode (single agent)...',
      startedPair: 'Autonomous mode (pair) started.\nWorker executes tasks, Reviewer validates.',
      startedSolo: 'Autonomous mode started.',
      stopped: 'Autonomous mode stopped.',
      runningHeartbeat: 'Running heartbeat...',
      approved: 'Task approved and executing.',
      noPendingApproval: 'No tasks pending approval.',
      rejected: 'Task rejected.',
      helpText: '**Autonomous execution commands:**\n`!auto` - Check status\n`!auto start [cron] [--pair]` - Start (default: every 30min)\n  e.g. `!auto start */30 * * * * --pair` (pair mode)\n`!auto stop` - Stop\n`!auto run` - Run immediately\n`!approve` - Approve pending task\n`!reject` - Reject pending task',
    },
    pair: {
      noActiveSessions: 'No active pair sessions.\nUse `!pair start` to begin.',
      activeSessionsTitle: 'Active Pair Sessions',
      noPendingIssues: 'No pending issues.',
      usage: 'Usage: `!pair run <taskId> [project]`',
      sessionStarted: 'Pair session started: {{thread}}',
      taskStartTitle: 'Pair task started: {{title}}',
      sessionStartMsg: 'Pair session started.',
      loopError: 'Pair loop error: {{error}}',
      workerStarting: '**[Worker]** Starting work... (attempt {{attempt}}/{{max}})',
      reviewerStarting: '**[Reviewer]** Starting review...',
      maxAttemptsExceeded: '**[System]** Max attempts exceeded. Task failed.',
      workApproved: '**[System]** Work approved!',
      workRejected: '**[System]** Work rejected. Manual intervention required.',
      revisionNeeded: '**[System]** Revision needed. Worker will rework...',
      sessionCancelled: 'Session cancelled.',
      maxAttemptsEnd: '**[System]** Max attempts exceeded. Task ended.',
      cancelledMsg: 'Pair session cancelled: `{{id}}`',
      cancelNotFound: 'Session not found or already ended: `{{id}}`',
      noHistory: 'No pair session history.',
      historyTitle: 'Pair Session History',
      helpText: '**Worker/Reviewer pair commands:**\n`!pair` - Current pair session status\n`!pair start [taskId]` - Start pair session\n`!pair run <taskId> [project]` - Direct pair run\n`!pair stop [sessionId]` - Stop session\n`!pair history [n]` - Recent n history\n`!pair stats` - View statistics',
      stats: {
        title: 'Pair Mode Statistics',
        totalSessions: '**Total sessions:** {{n}}',
        successRate: '**Success rate:** {{n}}%',
        firstAttemptRate: '**First attempt rate:** {{n}}%',
        approved: 'Approved: {{n}}',
        rejected: 'Rejected: {{n}}',
        failed: 'Failed: {{n}}',
        cancelled: 'Cancelled: {{n}}',
        avgAttempts: '**Attempts:** {{n}}',
        avgDuration: '**Duration:** {{duration}}',
        avgFiles: '**Files changed:** {{n}}',
        dailyTitle: 'Daily Statistics (Last 7 Days)',
        noData: '(no data)',
      },
      summary: {
        completed: 'Task Completed',
        rejected: 'Task Rejected',
        failed: 'Task Failed',
        cancelled: 'Task Cancelled',
        statsLabel: 'Statistics',
        attempts: '**Attempts:** {{n}}/{{max}}',
        duration: '**Duration:** {{duration}}',
        filesChanged: '**Files changed:** {{n}}',
        filesLabel: 'Changed Files',
        reviewerFeedback: 'Reviewer Feedback',
        decisionLabel: '**Decision:** {{decision}}',
        feedbackLabel: '**Feedback:** {{feedback}}',
        discussionSummary: '**Discussion Summary** ({{count}} messages)',
        noFiles: 'none',
      },
    },
    help: `**Claude Swarm Commands**

**Dev Tasks** (dispatch Claude)
\`!dev <repo> "<task>"\` - Run dev task on repository
\`!dev list\` - Known repository list
\`!dev scan\` - Scan ~/dev folder
\`!repos\` - Repository list (detailed)
\`!tasks\` - Running task list
\`!cancel <taskId>\` - Cancel task

**Agent Management**
\`!status [session]\` - Check agent status
\`!list\` - Session list (deprecated)
\`!run <session> "<task>"\` - Run specific task
\`!pause <session>\` - Pause autonomous work
\`!resume <session>\` - Resume autonomous work
\`!log <session> [lines]\` - View recent output

**Linear**
\`!issues [session]\` - Linear issue list
\`!limits\` - Agent daily limits

**Schedule**
\`!schedule\` - Schedule list
\`!schedule run <name>\` - Run immediately
\`!schedule toggle <name>\` - Enable/disable
\`!schedule add <name> <path> <interval> "<prompt>"\` - Add
\`!schedule remove <name>\` - Remove

**GitHub**
\`!ci\` - CI failure status
\`!notif\` - GitHub notifications

**Codex (Session Records)**
\`!codex\` - Recent sessions
\`!codex save "<title>"\` - Save session
\`!codex path\` - Save path

**Autonomous Execution**
\`!auto\` - Execution status
\`!auto start [cron] [--pair]\` - Start (default: every 30min, --pair for pair mode)
\`!auto stop\` - Stop
\`!auto run\` - Immediate heartbeat
\`!approve\` - Approve pending task
\`!reject\` - Reject pending task

**Worker/Reviewer Pair**
\`!pair\` - Pair session status
\`!pair start [taskId]\` - Start pair session
\`!pair run <taskId> [project]\` - Direct pair run
\`!pair stop [sessionId]\` - Stop session
\`!pair history [n]\` - View history
\`!pair stats\` - View statistics

\`!help\` - This help

---
**Examples:**
\`!dev pykis "check get_balance function parameters"\`
\`!dev tools/pykiwoom "analyze realtime subscription logic"\``,
    toolCalls: 'Tool calls ({{n}})',
    chatError: 'An error occurred. Please try again.',
    projectContext: 'Project context: {{path}}',
    chatContext: 'Chat Context',
  },

  // ── Agent Prompts & Formatting ──────────
  agents: {
    worker: {
      report: {
        completed: '**Worker Task Completed**',
        failed: '**Worker Task Failed**',
        summary: '**Summary:** {{text}}',
        filesChanged: '**Files changed ({{count}}):** {{list}}',
        commands: '**Commands run:** {{list}}',
        error: '**Error:** {{text}}',
      },
    },
    reviewer: {
      report: {
        decision: '**Reviewer Decision: {{text}}**',
        feedback: '**Feedback:** {{text}}',
        issues: '**Issues:**',
        suggestions: '**Suggestions:**',
      },
      revision: {
        header: '## Reviewer Feedback',
        decision: '**Decision:** {{text}}',
        feedback: '**Feedback:** {{text}}',
        issuesToFix: '### Issues to resolve:',
        suggestionsToConsider: '### Suggestions:',
        applyFeedback: 'Apply the above feedback and fix the code.',
      },
    },
    planner: {
      report: {
        analysisFailed: '**Planner Analysis Failed**',
        noDecomposition: '**No Decomposition Needed**',
        reason: 'Reason: {{text}}',
        estimatedTime: 'Estimated time: {{n}} min',
        decompositionDone: '**Task Decomposition Complete**',
        original: 'Original: {{text}}',
        subTasksHeader: '**Sub-tasks ({{count}}, total {{totalMinutes}} min):**',
        dependency: ' (depends on: {{deps}})',
      },
    },
  },

  // ── Service ─────────────────────────────
  service: {
    startComplete: 'Claude Swarm service started!',
    agentCount: 'Agents: {{n}}',
    repoCount: 'GitHub repos: {{n}}',
    heartbeatInterval: 'Default heartbeat: {{n}} min',
    startedMessage: 'Claude Swarm started. {{agents}} agents, {{schedules}} schedules active{{autoStatus}}.',
    autoModeActive: ', autonomous mode active ({{mode}})',
    scheduler: {
      noSchedules: 'No schedules registered.',
      lastRunLabel: 'Last: {{time}}',
    },
    issueContext: {
      continueWork: 'Continue working on Linear issue:',
      issue: 'Issue: {{id}} - {{title}}',
      description: 'Description:',
      recentProgress: 'Recent progress:',
      instructions: 'Based on the above context, continue the work.\nReport any progress. When done, respond with "DONE: <summary>".\nIf blocked, respond with "BLOCKED: <reason>".',
    },
    events: {
      issueStarted: 'Issue started: {{id}} {{title}}',
      issueCompleted: 'Issue completed: {{id}} {{detail}}',
      issueBlocked: 'Issue blocked: {{id}}\nReason: {{reason}}',
      commit: 'Commit: {{detail}}',
      ciFailDetected: '**{{repo}}** CI failure detected\n{{failures}}',
      ciRecovered: '**{{repo}}** CI recovered (after {{duration}})',
      ciStillFailing: '**{{repo}}** CI still failing ({{days}} days)\n{{failures}}',
    },
  },

  // ── Time Window ─────────────────────────
  timeWindow: {
    disabled: 'Time restriction disabled',
    weekendOrUnrestricted: 'Weekend/unrestricted day',
    blockedWindow: 'Blocked window ({{start}} ~ {{end}})',
    allowedWindow: 'Allowed window ({{start}} ~ {{end}})',
    outsideAllowed: 'Outside allowed window',
    tomorrowAt: 'tomorrow {{time}}',
    marketStatus: {
      preMarket: 'Pre-market (08:30~09:00)',
      regular: 'Regular session (09:00~15:30)',
      postMarket: 'Post-market (15:40~18:00)',
      closed: 'Market closed (work allowed)',
    },
    workAllowed: 'Work allowed',
    workBlocked: 'Work blocked',
    currentTime: 'Current: {{time}}',
    status: 'Status: {{description}}',
    nextAllowed: 'Next allowed: {{time}}',
    taskBlocked: '[TimeWindow] "{{task}}" blocked: {{reason}} (current: {{time}})',
    taskBlockedNoName: '[TimeWindow] Blocked: {{reason}} (current: {{time}})',
    nextAllowedTime: ' Next allowed: {{time}}',
  },

  // ── Autonomous Runner ───────────────────
  runner: {
    modeStarted: '**Autonomous mode started**',
    pipelineError: '**Pipeline error**: {{title}}\n```{{error}}```',
    consecutiveErrors: '**Autonomous execution error** ({{count}} consecutive)\n```{{error}}```',
    decomposition: {
      starting: '**Task decomposition started**\nTask: {{title}}\nEstimated time: {{estimated}} min (>{{threshold}} min)\nPlanner decomposing into sub-tasks...',
      plannerRunning: 'Planner analyzing...',
      completed: '**Task decomposition complete**\n\nOriginal: {{original}}\nCreated sub-issues ({{count}}):\n{{list}}\n\nTotal estimated time: {{totalMinutes}} min',
      prerequisite: '**Prerequisites:** {{deps}}',
      autoDecomposed: '---\n_Auto-decomposed from "{{parentTitle}}" by Planner_',
      estimatedTime: '**Estimated time:** {{n}} min',
    },
    pipeline: {
      starting: 'Pipeline Starting',
      revisionNeeded: 'Revision needed. {{stage}} feedback: Worker will rework...',
    },
    approval: {
      title: 'Awaiting Approval',
      question: 'Execute this task?\n\n{{project}}**{{title}}**',
      reason: 'Reason',
      footer: 'Respond with !approve or !reject',
    },
    result: {
      taskCompleted: 'Task Completed',
      taskFailed: 'Task Failed',
      taskLabel: 'Task',
      duration: 'Duration',
      completedSteps: 'Completed Steps',
      failedStep: 'Failed Step',
      rollback: 'Rollback',
    },
    taskStarting: 'Task Starting',
    analysisResult: '**Analysis Result**',
    reviewRejected: 'Review rejected: {{feedback}}',
    projectMappingFailed: '**Project mapping failed**: {{title}}\nProject: {{project}}',
  },
};
