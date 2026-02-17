// ============================================
// Claude Swarm - Pair Mode Webhook Notifications
// Send notifications to external Webhooks on completion/failure
// ============================================

import type { PairSession } from './agentPair.js';

// ============================================
// Types
// ============================================

export interface WebhookPayload {
  event: 'pair_started' | 'pair_approved' | 'pair_rejected' | 'pair_failed' | 'pair_cancelled';
  timestamp: string;
  session: {
    id: string;
    taskId: string;
    taskTitle: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    durationMs: number;
  };
  worker?: {
    success: boolean;
    summary: string;
    filesChanged: string[];
  };
  reviewer?: {
    decision: string;
    feedback: string;
    issues?: string[];
  };
  metadata?: Record<string, unknown>;
}

export interface WebhookResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

// ============================================
// Webhook Functions
// ============================================

/**
 * Validate Webhook URL
 */
export function isValidWebhookUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Notify pair session started
 */
export async function notifyPairStarted(
  webhookUrl: string,
  session: PairSession
): Promise<WebhookResult> {
  const payload: WebhookPayload = {
    event: 'pair_started',
    timestamp: new Date().toISOString(),
    session: {
      id: session.id,
      taskId: session.taskId,
      taskTitle: session.taskTitle,
      status: session.status,
      attempts: session.worker.attempts,
      maxAttempts: session.worker.maxAttempts,
      durationMs: 0,
    },
  };

  return sendWebhook(webhookUrl, payload);
}

/**
 * Notify pair session approved
 */
export async function notifyPairApproved(
  webhookUrl: string,
  session: PairSession
): Promise<WebhookResult> {
  const payload: WebhookPayload = {
    event: 'pair_approved',
    timestamp: new Date().toISOString(),
    session: {
      id: session.id,
      taskId: session.taskId,
      taskTitle: session.taskTitle,
      status: session.status,
      attempts: session.worker.attempts,
      maxAttempts: session.worker.maxAttempts,
      durationMs: session.finishedAt ? session.finishedAt - session.startedAt : 0,
    },
    worker: session.worker.result ? {
      success: session.worker.result.success,
      summary: session.worker.result.summary,
      filesChanged: session.worker.result.filesChanged,
    } : undefined,
    reviewer: session.reviewer.feedback ? {
      decision: session.reviewer.feedback.decision,
      feedback: session.reviewer.feedback.feedback,
      issues: session.reviewer.feedback.issues,
    } : undefined,
  };

  return sendWebhook(webhookUrl, payload);
}

/**
 * Notify pair session rejected
 */
export async function notifyPairRejected(
  webhookUrl: string,
  session: PairSession
): Promise<WebhookResult> {
  const payload: WebhookPayload = {
    event: 'pair_rejected',
    timestamp: new Date().toISOString(),
    session: {
      id: session.id,
      taskId: session.taskId,
      taskTitle: session.taskTitle,
      status: session.status,
      attempts: session.worker.attempts,
      maxAttempts: session.worker.maxAttempts,
      durationMs: session.finishedAt ? session.finishedAt - session.startedAt : 0,
    },
    worker: session.worker.result ? {
      success: session.worker.result.success,
      summary: session.worker.result.summary,
      filesChanged: session.worker.result.filesChanged,
    } : undefined,
    reviewer: session.reviewer.feedback ? {
      decision: session.reviewer.feedback.decision,
      feedback: session.reviewer.feedback.feedback,
      issues: session.reviewer.feedback.issues,
    } : undefined,
  };

  return sendWebhook(webhookUrl, payload);
}

/**
 * Notify pair session failed
 */
export async function notifyPairFailed(
  webhookUrl: string,
  session: PairSession,
  error?: string
): Promise<WebhookResult> {
  const payload: WebhookPayload = {
    event: 'pair_failed',
    timestamp: new Date().toISOString(),
    session: {
      id: session.id,
      taskId: session.taskId,
      taskTitle: session.taskTitle,
      status: session.status,
      attempts: session.worker.attempts,
      maxAttempts: session.worker.maxAttempts,
      durationMs: session.finishedAt ? session.finishedAt - session.startedAt : 0,
    },
    worker: session.worker.result ? {
      success: session.worker.result.success,
      summary: session.worker.result.summary,
      filesChanged: session.worker.result.filesChanged,
    } : undefined,
    reviewer: session.reviewer.feedback ? {
      decision: session.reviewer.feedback.decision,
      feedback: session.reviewer.feedback.feedback,
      issues: session.reviewer.feedback.issues,
    } : undefined,
    metadata: error ? { error } : undefined,
  };

  return sendWebhook(webhookUrl, payload);
}

/**
 * Notify pair session cancelled
 */
export async function notifyPairCancelled(
  webhookUrl: string,
  session: PairSession,
  reason?: string
): Promise<WebhookResult> {
  const payload: WebhookPayload = {
    event: 'pair_cancelled',
    timestamp: new Date().toISOString(),
    session: {
      id: session.id,
      taskId: session.taskId,
      taskTitle: session.taskTitle,
      status: session.status,
      attempts: session.worker.attempts,
      maxAttempts: session.worker.maxAttempts,
      durationMs: session.finishedAt ? session.finishedAt - session.startedAt : 0,
    },
    metadata: reason ? { reason } : undefined,
  };

  return sendWebhook(webhookUrl, payload);
}

/**
 * Send Webhook (common)
 */
async function sendWebhook(url: string, payload: WebhookPayload): Promise<WebhookResult> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Claude-Swarm/1.0',
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      return {
        success: true,
        statusCode: response.status,
      };
    }

    return {
      success: false,
      statusCode: response.status,
      error: `HTTP ${response.status}: ${response.statusText}`,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Send as Discord Webhook format (with Embed)
 */
export async function sendDiscordWebhook(
  webhookUrl: string,
  session: PairSession,
  title: string,
  color: number
): Promise<WebhookResult> {
  const embed = {
    title,
    color,
    fields: [
      {
        name: 'Task',
        value: `[${session.taskId}] ${session.taskTitle}`,
        inline: false,
      },
      {
        name: 'Status',
        value: session.status,
        inline: true,
      },
      {
        name: 'Attempts',
        value: `${session.worker.attempts}/${session.worker.maxAttempts}`,
        inline: true,
      },
    ],
    timestamp: new Date().toISOString(),
  };

  // Add Worker result
  if (session.worker.result) {
    embed.fields.push({
      name: 'Worker Summary',
      value: session.worker.result.summary.slice(0, 200),
      inline: false,
    });
  }

  // Add Reviewer feedback
  if (session.reviewer.feedback) {
    embed.fields.push({
      name: `Reviewer: ${session.reviewer.feedback.decision}`,
      value: session.reviewer.feedback.feedback.slice(0, 200),
      inline: false,
    });
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ embeds: [embed] }),
    });

    return {
      success: response.ok,
      statusCode: response.status,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
