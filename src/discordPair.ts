// ============================================
// Claude Swarm - Discord Pair System
//
// Worker/Reviewer pair session management.
// ============================================

import {
  TextChannel,
  Message,
  EmbedBuilder,
  ThreadChannel,
  ChannelType,
} from 'discord.js';
import * as linear from './linear.js';
import * as dev from './dev.js';
import * as agentPair from './agentPair.js';
import * as worker from './worker.js';
import * as reviewer from './reviewer.js';
import * as pairMetrics from './pairMetrics.js';
import * as pairWebhook from './pairWebhook.js';

import {
  pairModeConfig,
} from './discordCore.js';
import { t, getDateLocale } from './locale/index.js';

/**
 * !pair 명령어 핸들러
 */
export async function handlePair(msg: Message, args: string[]): Promise<void> {
  const subCommand = args[0];

  // !pair 또는 !pair status - 현재 상태
  if (!subCommand || subCommand === 'status') {
    await handlePairStatus(msg);
    return;
  }

  // !pair start [taskId] - 페어 세션 시작
  if (subCommand === 'start') {
    const taskId = args[1];
    await handlePairStart(msg, taskId);
    return;
  }

  // !pair stop [sessionId] - 페어 세션 중지
  if (subCommand === 'stop') {
    const sessionId = args[1];
    await handlePairStop(msg, sessionId);
    return;
  }

  // !pair history [n] - 히스토리 조회
  if (subCommand === 'history') {
    const limit = parseInt(args[1]) || 5;
    await handlePairHistory(msg, limit);
    return;
  }

  // !pair run <taskId> <project> - 직접 페어 실행
  if (subCommand === 'run') {
    const taskId = args[1];
    const project = args[2] || '~/dev';
    await handlePairRun(msg, taskId, project);
    return;
  }

  // !pair stats - 통계 조회
  if (subCommand === 'stats') {
    await handlePairStats(msg);
    return;
  }

  // 도움말
  await msg.reply(t('discord.pair.helpText'));
}

/**
 * !pair stats - 통계 조회
 */
async function handlePairStats(msg: Message): Promise<void> {
  try {
    const summary = await pairMetrics.getSummary();
    const daily = await pairMetrics.getDailyMetrics(7);

    const embed = new EmbedBuilder()
      .setTitle(t('discord.pair.stats.title'))
      .setColor(0x5865F2)
      .setTimestamp();

    // 전체 요약
    embed.addFields(
      {
        name: '📈 전체 통계',
        value: [
          t('discord.pair.stats.totalSessions', { n: summary.totalSessions }),
          t('discord.pair.stats.successRate', { n: summary.successRate }),
          t('discord.pair.stats.firstAttemptRate', { n: summary.firstAttemptSuccessRate }),
        ].join('\n'),
        inline: true,
      },
      {
        name: '📋 결과 분포',
        value: [
          `✅ ${t('discord.pair.stats.approved', { n: summary.approved })}`,
          `❌ ${t('discord.pair.stats.rejected', { n: summary.rejected })}`,
          `💥 ${t('discord.pair.stats.failed', { n: summary.failed })}`,
          `🚫 ${t('discord.pair.stats.cancelled', { n: summary.cancelled })}`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '⏱️ 평균 지표',
        value: [
          t('discord.pair.stats.avgAttempts', { n: summary.avgAttempts }),
          t('discord.pair.stats.avgDuration', { duration: formatDuration(summary.avgDurationMs) }),
          t('discord.pair.stats.avgFiles', { n: summary.avgFilesChanged }),
        ].join('\n'),
        inline: true,
      }
    );

    // 일별 통계
    if (daily.length > 0) {
      const dailyLines = daily.map(d => {
        const rate = d.sessions > 0 ? Math.round((d.approved / d.sessions) * 100) : 0;
        return `**${d.date}**: ${d.sessions}개 (✅${d.approved} ❌${d.rejected} 💥${d.failed}) ${rate}%`;
      });

      embed.addFields({
        name: t('discord.pair.stats.dailyTitle'),
        value: dailyLines.join('\n') || t('discord.pair.stats.noData'),
        inline: false,
      });
    }

    await msg.reply({ embeds: [embed] });
  } catch (err) {
    await msg.reply(`❌ ${t('discord.errors.statsQueryFailed', { error: err instanceof Error ? err.message : String(err) })}`);
  }
}

/**
 * 시간 포맷팅 (ms → 읽기 쉬운 형식)
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return t('common.duration.seconds', { n: Math.round(ms / 1000) });
  if (ms < 3600000) return t('common.duration.minutes', { n: Math.round(ms / 60000) });
  return t('common.duration.hours', { n: Math.round(ms / 3600000) });
}

/**
 * !pair status - 현재 페어 세션 상태
 */
async function handlePairStatus(msg: Message): Promise<void> {
  const sessions = agentPair.getActiveSessions();

  if (sessions.length === 0) {
    await msg.reply(t('discord.pair.noActiveSessions'));
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(t('discord.pair.activeSessionsTitle'))
    .setColor(0x00AE86)
    .setTimestamp();

  for (const session of sessions) {
    embed.addFields({
      name: `${session.id}: ${session.taskTitle.slice(0, 50)}`,
      value: agentPair.formatSessionSummary(session),
      inline: false,
    });
  }

  await msg.reply({ embeds: [embed] });
}

/**
 * !pair start [taskId] - 페어 세션 시작
 */
async function handlePairStart(msg: Message, taskId?: string): Promise<void> {
  // Linear에서 작업 가져오기
  let task: any = null;

  if (taskId) {
    // 특정 이슈 조회
    try {
      task = await linear.getIssue(taskId);
    } catch {
      await msg.reply(`❌ ${t('discord.errors.issueNotFound', { id: taskId || '' })}`);
      return;
    }
  } else {
    // 첫 번째 대기 중 이슈 선택
    try {
      const issues = await linear.getMyIssues();
      if (issues.length === 0) {
        await msg.reply(`❌ ${t('discord.pair.noPendingIssues')}`);
        return;
      }
      task = issues[0];
    } catch (err) {
      await msg.reply(`❌ ${t('discord.errors.linearFetchFailed', { error: err instanceof Error ? err.message : String(err) })}`);
      return;
    }
  }

  // 프로젝트 경로 결정
  const projectPath = task.project?.name
    ? dev.resolveRepoPath(task.project.name) || '~/dev'
    : '~/dev';

  await startPairSession(msg, {
    taskId: task.identifier || task.id,
    taskTitle: task.title,
    taskDescription: task.description || '',
    projectPath,
  });
}

/**
 * !pair run <taskId> [project] - 직접 페어 실행
 */
async function handlePairRun(msg: Message, taskId: string, project: string): Promise<void> {
  if (!taskId) {
    await msg.reply(t('discord.pair.usage'));
    return;
  }

  // 프로젝트 경로 확인
  const projectPath = dev.resolveRepoPath(project) || project;

  // Linear에서 이슈 정보 가져오기
  let taskTitle = taskId;
  let taskDescription = '';

  try {
    const issue = await linear.getIssue(taskId);
    if (issue) {
      taskTitle = issue.title;
      taskDescription = issue.description || '';
    }
  } catch {
    // Linear 조회 실패해도 계속 진행 (taskId를 제목으로 사용)
  }

  await startPairSession(msg, {
    taskId,
    taskTitle,
    taskDescription,
    projectPath,
  });
}

/**
 * 페어 세션 시작 및 실행
 */
async function startPairSession(
  msg: Message,
  options: agentPair.CreatePairSessionOptions
): Promise<void> {
  const channel = msg.channel as TextChannel;

  // pairModeConfig에서 기본값 적용
  const sessionOptions: agentPair.CreatePairSessionOptions = {
    ...options,
    webhookUrl: options.webhookUrl ?? pairModeConfig?.webhookUrl,
    maxAttempts: options.maxAttempts ?? pairModeConfig?.maxAttempts,
  };

  // 1. 세션 생성
  const session = agentPair.createPairSession(sessionOptions);

  // 2. Discord 스레드 생성
  let thread: ThreadChannel;
  try {
    thread = await channel.threads.create({
      name: `[${session.id}] ${options.taskTitle.slice(0, 50)}`,
      autoArchiveDuration: 1440, // 24시간
      type: ChannelType.PublicThread,
    });

    agentPair.setSessionThreadId(session.id, thread.id);
  } catch (err) {
    await msg.reply(`❌ ${t('discord.errors.threadCreateFailed', { error: err instanceof Error ? err.message : String(err) })}`);
    agentPair.cancelSession(session.id);
    return;
  }

  // 3. 시작 메시지
  const startEmbed = new EmbedBuilder()
    .setTitle(`📋 ${t('discord.pair.taskStartTitle', { title: options.taskTitle.slice(0, 80) })}`)
    .setColor(0x00AE86)
    .addFields(
      { name: 'Session ID', value: session.id, inline: true },
      { name: 'Task', value: options.taskId, inline: true },
      { name: 'Project', value: options.projectPath, inline: true },
    )
    .setTimestamp();

  await thread.send({ embeds: [startEmbed] });
  agentPair.addMessage(session.id, 'system', t('discord.pair.sessionStartMsg'));

  // 4. Worker/Reviewer 루프 시작 (비동기)
  runPairLoop(session.id, thread).catch((err) => {
    console.error('[Pair] Loop error:', err);
    thread.send(`❌ ${t('discord.pair.loopError', { error: err instanceof Error ? err.message : String(err) })}`);
    agentPair.updateSessionStatus(session.id, 'failed');
  });

  // 5. 메인 채널에 알림
  await msg.reply(`👥 ${t('discord.pair.sessionStarted', { thread: String(thread) })}`);
}

/**
 * Worker/Reviewer 루프 실행
 */
async function runPairLoop(sessionId: string, thread: ThreadChannel): Promise<void> {
  let session = agentPair.getPairSession(sessionId);
  if (!session) return;

  // Linear에 페어 세션 시작 기록
  try {
    await linear.logPairStart(session.taskId, sessionId, session.projectPath);
  } catch (err) {
    console.error('[Pair] Linear logPairStart failed:', err);
  }

  // 마지막 Worker 결과 저장 (통계용)
  let lastWorkerResult: agentPair.WorkerResult | null = null;

  while (agentPair.canRetry(sessionId)) {
    session = agentPair.getPairSession(sessionId);
    if (!session) break;

    // 취소 체크
    if (session.status === 'cancelled') {
      await thread.send(`🚫 ${t('discord.pair.sessionCancelled')}`);
      return;
    }

    // === Worker 실행 ===
    agentPair.updateSessionStatus(sessionId, 'working');
    await thread.send(t('discord.pair.workerStarting', { attempt: session.worker.attempts + 1, max: session.worker.maxAttempts }));

    const previousFeedback = session.reviewer.feedback
      ? reviewer.buildRevisionPrompt(session.reviewer.feedback)
      : undefined;

    const workerResult = await worker.runWorker({
      taskTitle: session.taskTitle,
      taskDescription: session.taskDescription,
      projectPath: session.projectPath,
      previousFeedback,
      timeoutMs: 300000, // 5분
      issueIdentifier: session.taskId,
    });

    lastWorkerResult = workerResult;
    agentPair.saveWorkerResult(sessionId, workerResult);
    await thread.send(worker.formatWorkReport(workerResult, {
      issueIdentifier: session.taskId,
      projectPath: session.projectPath,
    }));

    // Worker 실패 시 재시도 또는 종료
    if (!workerResult.success) {
      if (!agentPair.canRetry(sessionId)) {
        agentPair.updateSessionStatus(sessionId, 'failed');
        await thread.send(t('discord.pair.maxAttemptsExceeded'));

        // Linear에 실패 기록
        try {
          await linear.logPairFailed(session.taskId, sessionId, 'max_attempts',
            `Worker failed after max attempts (${session.worker.maxAttempts}) exceeded`);
        } catch (err) {
          console.error('[Pair] Linear logPairFailed failed:', err);
        }

        // 최종 요약 전송
        await sendFinalSummary(thread, session, 'failed');
        return;
      }
      continue;
    }

    // === Reviewer 실행 ===
    agentPair.updateSessionStatus(sessionId, 'reviewing');
    await thread.send(t('discord.pair.reviewerStarting'));

    // Linear에 리뷰 시작 기록
    try {
      await linear.logPairReview(session.taskId, sessionId, session.worker.attempts);
    } catch (err) {
      console.error('[Pair] Linear logPairReview failed:', err);
    }

    const reviewResult = await reviewer.runReviewer({
      taskTitle: session.taskTitle,
      taskDescription: session.taskDescription,
      workerResult,
      projectPath: session.projectPath,
      timeoutMs: 180000, // 3분
    });

    agentPair.saveReviewerResult(sessionId, reviewResult);
    await thread.send(reviewer.formatReviewFeedback(reviewResult));

    // === 결정 처리 ===
    if (reviewResult.decision === 'approve') {
      agentPair.updateSessionStatus(sessionId, 'approved');
      await thread.send(t('discord.pair.workApproved'));

      // Linear에 완료 기록
      try {
        const duration = Math.round((Date.now() - session.startedAt) / 1000);
        await linear.logPairComplete(session.taskId, sessionId, {
          attempts: session.worker.attempts,
          duration,
          filesChanged: lastWorkerResult?.filesChanged || [],
        });
      } catch (err) {
        console.error('[Pair] Linear logPairComplete failed:', err);
      }

      // 최종 요약 전송
      await sendFinalSummary(thread, session, 'approved');
      return;
    }

    if (reviewResult.decision === 'reject') {
      agentPair.updateSessionStatus(sessionId, 'rejected');
      await thread.send(t('discord.pair.workRejected'));

      // Linear에 거부 기록
      try {
        await linear.logPairFailed(session.taskId, sessionId, 'rejected',
          `Feedback: ${reviewResult.feedback}\nIssues: ${reviewResult.issues?.join(', ') || 'none'}`);
      } catch (err) {
        console.error('[Pair] Linear logPairFailed failed:', err);
      }

      // 최종 요약 전송
      await sendFinalSummary(thread, session, 'rejected');
      return;
    }

    // revise: 다음 루프에서 Worker가 수정
    if (!agentPair.canRetry(sessionId)) {
      agentPair.updateSessionStatus(sessionId, 'failed');
      await thread.send(t('discord.pair.maxAttemptsEnd'));

      try {
        await linear.logPairFailed(session.taskId, sessionId, 'max_attempts',
          `Max attempts (${session.worker.maxAttempts}) exceeded`);
      } catch (err) {
        console.error('[Pair] Linear logPairFailed failed:', err);
      }

      await sendFinalSummary(thread, session, 'failed');
      return;
    }

    // Linear에 수정 요청 기록
    try {
      await linear.logPairRevision(session.taskId, sessionId,
        reviewResult.feedback, reviewResult.issues || []);
    } catch (err) {
      console.error('[Pair] Linear logPairRevision failed:', err);
    }

    agentPair.updateSessionStatus(sessionId, 'revising');
    await thread.send(t('discord.pair.revisionNeeded'));
  }

  // 최대 시도 초과
  session = agentPair.getPairSession(sessionId);
  if (session) {
    agentPair.updateSessionStatus(sessionId, 'failed');
    await thread.send(t('discord.pair.maxAttemptsEnd'));

    try {
      await linear.logPairFailed(session.taskId, sessionId, 'max_attempts',
        `Max attempts (${session.worker.maxAttempts}) exceeded`);
    } catch (err) {
      console.error('[Pair] Linear logPairFailed failed:', err);
    }

    await sendFinalSummary(thread, session, 'failed');
  }
}

/**
 * 최종 요약 Embed 전송
 */
async function sendFinalSummary(
  thread: ThreadChannel,
  session: agentPair.PairSession,
  result: 'approved' | 'rejected' | 'failed' | 'cancelled'
): Promise<void> {
  const finishedAt = Date.now();
  const durationMs = finishedAt - session.startedAt;
  const duration = Math.round(durationMs / 1000);
  const durationStr = duration < 60
    ? t('common.duration.seconds', { n: duration })
    : `${Math.floor(duration / 60)}m ${duration % 60}s`;

  // 메트릭 기록
  try {
    await pairMetrics.recordSession({
      sessionId: session.id,
      taskId: session.taskId,
      taskTitle: session.taskTitle,
      result,
      attempts: session.worker.attempts,
      maxAttempts: session.worker.maxAttempts,
      durationMs,
      filesChanged: session.worker.result?.filesChanged.length || 0,
      startedAt: session.startedAt,
      finishedAt,
    });
  } catch (err) {
    console.error('[Pair] Metrics recording failed:', err);
  }

  // Webhook 알림
  if (session.webhookUrl && pairWebhook.isValidWebhookUrl(session.webhookUrl)) {
    try {
      const webhookFn = {
        approved: pairWebhook.notifyPairApproved,
        rejected: pairWebhook.notifyPairRejected,
        failed: pairWebhook.notifyPairFailed,
        cancelled: pairWebhook.notifyPairCancelled,
      }[result];

      const webhookResult = await webhookFn(session.webhookUrl, session);
      if (!webhookResult.success) {
        console.error('[Pair] Webhook notification failed:', webhookResult.error);
      }
    } catch (err) {
      console.error('[Pair] Webhook notification error:', err);
    }
  }

  // 결과별 색상 및 이모지
  const config = {
    approved: { color: 0x00FF00, emoji: '✅', title: t('discord.pair.summary.completed') },
    rejected: { color: 0xFF0000, emoji: '❌', title: t('discord.pair.summary.rejected') },
    failed: { color: 0xFF6600, emoji: '💥', title: t('discord.pair.summary.failed') },
    cancelled: { color: 0x808080, emoji: '🚫', title: t('discord.pair.summary.cancelled') },
  }[result];

  // 변경된 파일 목록
  const filesChanged = session.worker.result?.filesChanged || [];
  const filesStr = filesChanged.length > 0
    ? filesChanged.slice(0, 10).map(f => `\`${f}\``).join(', ')
    : t('discord.pair.summary.noFiles');

  // 실행된 명령어 (미사용이지만 향후 확장용)
  const _commands = session.worker.result?.commands || [];

  // Embed 생성
  const embed = new EmbedBuilder()
    .setTitle(`${config.emoji} ${config.title}: ${session.taskTitle.slice(0, 60)}`)
    .setColor(config.color)
    .addFields(
      { name: t('discord.pair.summary.statsLabel'), value: [
        t('discord.pair.summary.attempts', { n: session.worker.attempts, max: session.worker.maxAttempts }),
        t('discord.pair.summary.duration', { duration: durationStr }),
        t('discord.pair.summary.filesChanged', { n: filesChanged.length }),
      ].join('\n'), inline: false },
      { name: t('discord.pair.summary.filesLabel'), value: filesStr.slice(0, 1000) || t('discord.pair.summary.noFiles'), inline: false },
    )
    .setFooter({ text: `Session: ${session.id} | Task: ${session.taskId}` })
    .setTimestamp();

  // Reviewer 피드백이 있으면 추가
  if (session.reviewer.feedback) {
    const feedback = session.reviewer.feedback;
    const feedbackStr = [
      t('discord.pair.summary.decisionLabel', { decision: feedback.decision.toUpperCase() }),
      t('discord.pair.summary.feedbackLabel', { feedback: feedback.feedback.slice(0, 200) }),
    ].join('\n');
    embed.addFields({ name: t('discord.pair.summary.reviewerFeedback'), value: feedbackStr, inline: false });
  }

  await thread.send({ embeds: [embed] });

  // 토론 요약 (메시지가 있으면)
  if (session.messages.length > 0) {
    const discussionSummary = formatDiscussionSummary(session);
    if (discussionSummary.length <= 2000) {
      await thread.send(`📜 ${t('discord.pair.summary.discussionSummary', { count: session.messages.length })}\n${discussionSummary}`);
    } else {
      // 너무 길면 분할
      await thread.send(`📜 ${t('discord.pair.summary.discussionSummary', { count: session.messages.length })}`);
      await thread.send(`\`\`\`\n${discussionSummary.slice(0, 1900)}\n...\n\`\`\``);
    }
  }
}

/**
 * 토론 요약 포맷
 */
function formatDiscussionSummary(session: agentPair.PairSession): string {
  return session.messages.map((msg, _idx) => {
    const roleEmoji = { worker: '🔨', reviewer: '🔍', system: '⚙️' }[msg.role];
    const time = new Date(msg.timestamp).toLocaleTimeString(getDateLocale(), {
      hour: '2-digit',
      minute: '2-digit',
    });
    const content = msg.content.slice(0, 200) + (msg.content.length > 200 ? '...' : '');
    return `[${time}] ${roleEmoji} ${msg.role}: ${content}`;
  }).join('\n');
}

/**
 * !pair stop [sessionId] - 페어 세션 중지
 */
async function handlePairStop(msg: Message, sessionId?: string): Promise<void> {
  const sessions = agentPair.getActiveSessions();

  if (sessions.length === 0) {
    await msg.reply(t('discord.pair.noActiveSessions'));
    return;
  }

  // sessionId 지정 안 하면 가장 최근 세션
  const targetId = sessionId || sessions[0].id;
  const success = agentPair.cancelSession(targetId);

  if (success) {
    await msg.reply(`🚫 ${t('discord.pair.cancelledMsg', { id: targetId })}`);
  } else {
    await msg.reply(`❌ ${t('discord.pair.cancelNotFound', { id: targetId })}`);
  }
}

/**
 * !pair history [n] - 히스토리 조회
 */
async function handlePairHistory(msg: Message, limit: number): Promise<void> {
  const history = agentPair.getSessionHistory(limit);

  if (history.length === 0) {
    await msg.reply(t('discord.pair.noHistory'));
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(t('discord.pair.historyTitle'))
    .setColor(0x9b59b6)
    .setTimestamp();

  for (const session of history) {
    embed.addFields({
      name: `${session.id}: ${session.taskTitle.slice(0, 40)}`,
      value: agentPair.formatSessionSummary(session),
      inline: false,
    });
  }

  await msg.reply({ embeds: [embed] });
}
