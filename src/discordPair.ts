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
  await msg.reply(
    '**👥 Worker/Reviewer 페어 명령어:**\n' +
    '`!pair` - 현재 페어 세션 상태\n' +
    '`!pair start [taskId]` - 페어 세션 시작\n' +
    '`!pair run <taskId> [project]` - 직접 페어 실행\n' +
    '`!pair stop [sessionId]` - 세션 중지\n' +
    '`!pair history [n]` - 최근 n개 히스토리\n' +
    '`!pair stats` - 통계 조회'
  );
}

/**
 * !pair stats - 통계 조회
 */
async function handlePairStats(msg: Message): Promise<void> {
  try {
    const summary = await pairMetrics.getSummary();
    const daily = await pairMetrics.getDailyMetrics(7);

    const embed = new EmbedBuilder()
      .setTitle('📊 페어 모드 통계')
      .setColor(0x5865F2)
      .setTimestamp();

    // 전체 요약
    embed.addFields(
      {
        name: '📈 전체 통계',
        value: [
          `**총 세션:** ${summary.totalSessions}개`,
          `**성공률:** ${summary.successRate}%`,
          `**첫 시도 성공률:** ${summary.firstAttemptSuccessRate}%`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '📋 결과 분포',
        value: [
          `✅ 승인: ${summary.approved}`,
          `❌ 거부: ${summary.rejected}`,
          `💥 실패: ${summary.failed}`,
          `🚫 취소: ${summary.cancelled}`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '⏱️ 평균 지표',
        value: [
          `**시도 횟수:** ${summary.avgAttempts}회`,
          `**소요 시간:** ${formatDuration(summary.avgDurationMs)}`,
          `**변경 파일:** ${summary.avgFilesChanged}개`,
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
        name: '📅 일별 통계 (최근 7일)',
        value: dailyLines.join('\n') || '(데이터 없음)',
        inline: false,
      });
    }

    await msg.reply({ embeds: [embed] });
  } catch (err) {
    await msg.reply(`❌ 통계 조회 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 시간 포맷팅 (ms → 읽기 쉬운 형식)
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}초`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}분`;
  return `${Math.round(ms / 3600000)}시간`;
}

/**
 * !pair status - 현재 페어 세션 상태
 */
async function handlePairStatus(msg: Message): Promise<void> {
  const sessions = agentPair.getActiveSessions();

  if (sessions.length === 0) {
    await msg.reply('👥 활성 페어 세션이 없습니다.\n`!pair start` 로 시작하세요.');
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('👥 활성 페어 세션')
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
      await msg.reply(`❌ 이슈를 찾을 수 없습니다: \`${taskId}\``);
      return;
    }
  } else {
    // 첫 번째 대기 중 이슈 선택
    try {
      const issues = await linear.getMyIssues();
      if (issues.length === 0) {
        await msg.reply('❌ 대기 중인 이슈가 없습니다.');
        return;
      }
      task = issues[0];
    } catch (err) {
      await msg.reply(`❌ Linear 조회 실패: ${err instanceof Error ? err.message : String(err)}`);
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
    await msg.reply('사용법: `!pair run <taskId> [project]`');
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
    await msg.reply(`❌ 스레드 생성 실패: ${err instanceof Error ? err.message : String(err)}`);
    agentPair.cancelSession(session.id);
    return;
  }

  // 3. 시작 메시지
  const startEmbed = new EmbedBuilder()
    .setTitle(`📋 페어 작업 시작: ${options.taskTitle.slice(0, 80)}`)
    .setColor(0x00AE86)
    .addFields(
      { name: 'Session ID', value: session.id, inline: true },
      { name: 'Task', value: options.taskId, inline: true },
      { name: 'Project', value: options.projectPath, inline: true },
    )
    .setTimestamp();

  await thread.send({ embeds: [startEmbed] });
  agentPair.addMessage(session.id, 'system', '페어 세션이 시작되었습니다.');

  // 4. Worker/Reviewer 루프 시작 (비동기)
  runPairLoop(session.id, thread).catch((err) => {
    console.error('[Pair] Loop error:', err);
    thread.send(`❌ 페어 루프 오류: ${err instanceof Error ? err.message : String(err)}`);
    agentPair.updateSessionStatus(session.id, 'failed');
  });

  // 5. 메인 채널에 알림
  await msg.reply(`👥 페어 세션 시작됨: ${thread}`);
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
      await thread.send('🚫 세션이 취소되었습니다.');
      return;
    }

    // === Worker 실행 ===
    agentPair.updateSessionStatus(sessionId, 'working');
    await thread.send(`🔨 **[Worker]** 작업 시작... (시도 ${session.worker.attempts + 1}/${session.worker.maxAttempts})`);

    const previousFeedback = session.reviewer.feedback
      ? reviewer.buildRevisionPrompt(session.reviewer.feedback)
      : undefined;

    const workerResult = await worker.runWorker({
      taskTitle: session.taskTitle,
      taskDescription: session.taskDescription,
      projectPath: session.projectPath,
      previousFeedback,
      timeoutMs: 300000, // 5분
    });

    lastWorkerResult = workerResult;
    agentPair.saveWorkerResult(sessionId, workerResult);
    await thread.send(worker.formatWorkReport(workerResult));

    // Worker 실패 시 재시도 또는 종료
    if (!workerResult.success) {
      if (!agentPair.canRetry(sessionId)) {
        agentPair.updateSessionStatus(sessionId, 'failed');
        await thread.send('❌ **[System]** 최대 시도 횟수 초과. 작업 실패.');

        // Linear에 실패 기록
        try {
          await linear.logPairFailed(session.taskId, sessionId, 'max_attempts',
            `Worker 작업 실패 후 최대 시도 횟수(${session.worker.maxAttempts}회) 초과`);
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
    await thread.send('🔍 **[Reviewer]** 리뷰 시작...');

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
      await thread.send('✅ **[System]** 작업이 승인되었습니다!');

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
      await thread.send('❌ **[System]** 작업이 거부되었습니다. 수동 개입이 필요합니다.');

      // Linear에 거부 기록
      try {
        await linear.logPairFailed(session.taskId, sessionId, 'rejected',
          `피드백: ${reviewResult.feedback}\n문제점: ${reviewResult.issues?.join(', ') || '없음'}`);
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
      await thread.send('❌ **[System]** 최대 시도 횟수 초과. 수정 실패.');

      try {
        await linear.logPairFailed(session.taskId, sessionId, 'max_attempts',
          `최대 시도 횟수(${session.worker.maxAttempts}회) 초과`);
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
    await thread.send('🔄 **[System]** 수정이 필요합니다. Worker가 재작업합니다...');
  }

  // 최대 시도 초과
  session = agentPair.getPairSession(sessionId);
  if (session) {
    agentPair.updateSessionStatus(sessionId, 'failed');
    await thread.send('❌ **[System]** 최대 시도 횟수 초과. 작업 종료.');

    try {
      await linear.logPairFailed(session.taskId, sessionId, 'max_attempts',
        `최대 시도 횟수(${session.worker.maxAttempts}회) 초과`);
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
    ? `${duration}초`
    : `${Math.floor(duration / 60)}분 ${duration % 60}초`;

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
    approved: { color: 0x00FF00, emoji: '✅', title: '작업 완료' },
    rejected: { color: 0xFF0000, emoji: '❌', title: '작업 거부됨' },
    failed: { color: 0xFF6600, emoji: '💥', title: '작업 실패' },
    cancelled: { color: 0x808080, emoji: '🚫', title: '작업 취소됨' },
  }[result];

  // 변경된 파일 목록
  const filesChanged = session.worker.result?.filesChanged || [];
  const filesStr = filesChanged.length > 0
    ? filesChanged.slice(0, 10).map(f => `\`${f}\``).join(', ')
    : '없음';

  // 실행된 명령어 (미사용이지만 향후 확장용)
  const _commands = session.worker.result?.commands || [];

  // Embed 생성
  const embed = new EmbedBuilder()
    .setTitle(`${config.emoji} ${config.title}: ${session.taskTitle.slice(0, 60)}`)
    .setColor(config.color)
    .addFields(
      { name: '📊 통계', value: [
        `**시도 횟수:** ${session.worker.attempts}/${session.worker.maxAttempts}`,
        `**소요 시간:** ${durationStr}`,
        `**변경 파일:** ${filesChanged.length}개`,
      ].join('\n'), inline: false },
      { name: '📁 변경된 파일', value: filesStr.slice(0, 1000) || '없음', inline: false },
    )
    .setFooter({ text: `Session: ${session.id} | Task: ${session.taskId}` })
    .setTimestamp();

  // Reviewer 피드백이 있으면 추가
  if (session.reviewer.feedback) {
    const feedback = session.reviewer.feedback;
    const feedbackStr = [
      `**결정:** ${feedback.decision.toUpperCase()}`,
      `**피드백:** ${feedback.feedback.slice(0, 200)}`,
    ].join('\n');
    embed.addFields({ name: '🔍 Reviewer 피드백', value: feedbackStr, inline: false });
  }

  await thread.send({ embeds: [embed] });

  // 토론 요약 (메시지가 있으면)
  if (session.messages.length > 0) {
    const discussionSummary = formatDiscussionSummary(session);
    if (discussionSummary.length <= 2000) {
      await thread.send(`📜 **토론 요약**\n${discussionSummary}`);
    } else {
      // 너무 길면 분할
      await thread.send(`📜 **토론 요약** (${session.messages.length}개 메시지)`);
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
    const time = new Date(msg.timestamp).toLocaleTimeString('ko-KR', {
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
    await msg.reply('활성 페어 세션이 없습니다.');
    return;
  }

  // sessionId 지정 안 하면 가장 최근 세션
  const targetId = sessionId || sessions[0].id;
  const success = agentPair.cancelSession(targetId);

  if (success) {
    await msg.reply(`🚫 페어 세션 취소됨: \`${targetId}\``);
  } else {
    await msg.reply(`❌ 세션을 찾을 수 없거나 이미 종료됨: \`${targetId}\``);
  }
}

/**
 * !pair history [n] - 히스토리 조회
 */
async function handlePairHistory(msg: Message, limit: number): Promise<void> {
  const history = agentPair.getSessionHistory(limit);

  if (history.length === 0) {
    await msg.reply('📚 페어 세션 히스토리가 없습니다.');
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('📚 페어 세션 히스토리')
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
