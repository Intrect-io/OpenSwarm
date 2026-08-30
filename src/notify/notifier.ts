// ============================================
// OpenSwarm - Notifier abstraction
// ============================================
//
// Outbound notifications were hardwired to Discord. This abstracts the send
// path so Slack/Telegram/generic-webhook are BYO drop-ins (INT-1576). Only the
// OUTBOUND notification path is abstracted; interactive Discord bot commands
// (!status etc.) remain Discord-specific.

import type { EmbedBuilder } from 'discord.js';
import { publicFetch } from '../support/outboundUrl.js';
import { isHumanSurfaceReadOnlyEnabled } from '../mcp/humanSurfacePolicy.js';

export interface Notifier {
  /** Send one outbound notification. Implementations must not throw. */
  notify(message: string | EmbedBuilder): Promise<void>;
}

export type NotificationsConfig = {
  channel: 'discord' | 'slack' | 'telegram' | 'webhook' | 'none';
  slackWebhookUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  webhookUrl?: string;
};

/** Discord's content shape (string or embeds) — the existing sendToChannel signature. */
type DiscordSend = (content: string | { embeds: EmbedBuilder[] }) => Promise<void>;

const NOTIFICATION_TEXT_LIMIT = 4096;
const NOTIFICATION_POST_TIMEOUT_MS = 10_000;
const TRUNCATED_SUFFIX = '\n[truncated]';

function sanitizeNotificationError(err: unknown): string {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return message.replace(/https?:\/\/\S+/gi, '[redacted-url]');
}

function truncateNotificationText(text: string): string {
  if (text.length <= NOTIFICATION_TEXT_LIMIT) return text;
  return `${text.slice(0, NOTIFICATION_TEXT_LIMIT - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
}

/** Flatten a string|Embed into readable plain text for non-Discord channels. */
export function messageToText(message: string | EmbedBuilder): string {
  if (typeof message === 'string') return truncateNotificationText(message);
  const d = message.data;
  const parts: string[] = [];
  if (d.title) parts.push(d.title);
  if (d.description) parts.push(d.description);
  for (const f of d.fields ?? []) parts.push(`${f.name}: ${f.value}`);
  return truncateNotificationText(parts.join('\n') || '(notification)');
}

async function postJson(url: string, body: unknown): Promise<void> {
  if (isHumanSurfaceReadOnlyEnabled()) return;
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`notification webhook timed out after ${NOTIFICATION_POST_TIMEOUT_MS}ms`));
    }, NOTIFICATION_POST_TIMEOUT_MS);
  });
  try {
    const res = await Promise.race([
      publicFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'OpenSwarm/0.7' },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'manual',
      }),
      timeout,
    ]);
    await Promise.race([res.body?.cancel() ?? Promise.resolve(), timeout]);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** Logs only — used when no channel is configured. */
class NoopNotifier implements Notifier {
  async notify(_message: string | EmbedBuilder): Promise<void> {
    console.log('[Notify] Notification skipped because channel is disabled');
  }
}

/** Discord bot channel. Owns the string→Embed wrapping (moved here from reportToDiscord). */
class DiscordNotifier implements Notifier {
  constructor(private readonly send: DiscordSend) {}
  async notify(message: string | EmbedBuilder): Promise<void> {
    if (isHumanSurfaceReadOnlyEnabled()) return;
    try {
      if (typeof message === 'string') {
        // Lazy import keeps discord.js out of the load path for non-Discord users.
        const { EmbedBuilder } = await import('discord.js');
        const embed = new EmbedBuilder().setDescription(messageToText(message)).setColor(0x00ff41).setTimestamp();
        await this.send({ embeds: [embed] });
      } else {
        await this.send({ embeds: [message] });
      }
    } catch (err) {
      console.error('[Notify] Discord send failed:', sanitizeNotificationError(err));
    }
  }
}

class SlackNotifier implements Notifier {
  constructor(private readonly webhookUrl: string) {}
  async notify(message: string | EmbedBuilder): Promise<void> {
    try {
      await postJson(this.webhookUrl, { text: messageToText(message) });
    } catch (err) {
      console.error('[Notify] Slack send failed:', sanitizeNotificationError(err));
    }
  }
}

class TelegramNotifier implements Notifier {
  constructor(private readonly botToken: string, private readonly chatId: string) {}
  async notify(message: string | EmbedBuilder): Promise<void> {
    try {
      await postJson(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        chat_id: this.chatId,
        text: messageToText(message),
      });
    } catch (err) {
      console.error('[Notify] Telegram send failed:', sanitizeNotificationError(err));
    }
  }
}

class WebhookNotifier implements Notifier {
  constructor(private readonly url: string) {}
  async notify(message: string | EmbedBuilder): Promise<void> {
    try {
      await postJson(this.url, { text: messageToText(message) });
    } catch (err) {
      console.error('[Notify] Webhook send failed:', sanitizeNotificationError(err));
    }
  }
}

/**
 * Build the notifier for the configured channel. `discordSend` is injected (not
 * imported) so this module stays decoupled from discordCore and Discord stays
 * optional. Falls back to Noop when the chosen channel lacks its credential.
 */
export function createNotifier(config: NotificationsConfig | undefined, discordSend?: DiscordSend): Notifier {
  if (isHumanSurfaceReadOnlyEnabled()) return new NoopNotifier();
  const channel = config?.channel ?? (discordSend ? 'discord' : 'none');
  switch (channel) {
    case 'discord':
      return discordSend ? new DiscordNotifier(discordSend) : new NoopNotifier();
    case 'slack':
      return config?.slackWebhookUrl ? new SlackNotifier(config.slackWebhookUrl) : new NoopNotifier();
    case 'telegram':
      return config?.telegramBotToken && config?.telegramChatId
        ? new TelegramNotifier(config.telegramBotToken, config.telegramChatId)
        : new NoopNotifier();
    case 'webhook':
      return config?.webhookUrl ? new WebhookNotifier(config.webhookUrl) : new NoopNotifier();
    case 'none':
    default:
      return new NoopNotifier();
  }
}
