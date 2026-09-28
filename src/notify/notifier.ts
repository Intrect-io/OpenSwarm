// ============================================
// OpenSwarm - Notifier abstraction
// ============================================
//
// Outbound notifications were hardwired to Discord. This abstracts the send
// path so Slack/Telegram/generic-webhook are BYO drop-ins (INT-1576). Only the
// OUTBOUND notification path is abstracted; interactive Discord bot commands
// (!status etc.) remain Discord-specific.

import type { EmbedBuilder } from 'discord.js';
import { isIP } from 'node:net';
import { isPrivateIp, publicFetch } from '../support/outboundUrl.js';
import { isHumanSurfaceReadOnlyEnabled } from '../mcp/humanSurfacePolicy.js';

/**
 * Validates a webhook URL.
 *
 * Returns `true` if the URL is acceptable (global IP or DNS name).
 * Returns `false` if the URL targets a non-global special-use address — IPv4 or
 * IPv6, in any of the encodings that reach the same host — or is malformed.
 *
 * Classification is delegated to the shared `isPrivateIp` predicate rather than
 * a local range table. The table this replaces understood IPv4 only, so every
 * equivalent IPv6 spelling walked straight through: `[::ffff:7f00:1]`,
 * `[0:0:0:0:0:0:0:1]` and the IPv4-compatible `[::127.0.0.1]` all reach
 * 127.0.0.1 while reading as ordinary IPv6 literals, and the same held for a
 * private IPv4 embedded in 6to4 (2002::/16) or NAT64 (64:ff9b::/96) space.
 * The predicate already expands those forms, so the guard rejects them instead
 * of admitting them. Its ranges also cover the TEST-NET documentation blocks
 * the old table listed. (AGT-3432)
 */
export function validateWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    // `URL` already collapses the exotic IPv4 spellings (decimal, octal, hex,
    // short form) to a dotted quad, so what `isIP` sees is the literal that
    // would be dialled. Brackets are stripped because they are URL syntax, not
    // part of the address.
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (!isIP(hostname)) return true; // DNS name — cannot validate statically

    return !isPrivateIp(hostname);
  } catch {
    return false;
  }
}

export interface Notifier {
  /** Send one outbound notification. Implementations must not throw. */
  notify(message: string | EmbedBuilder): Promise<void>;
}

export interface NotificationsConfig {
  channel?: 'discord' | 'slack' | 'telegram' | 'webhook' | 'none';
  slackWebhookUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  webhookUrl?: string;
}

export function sanitizeNotificationError(err: unknown): string {
  if (err instanceof Error) {
    // Strip stack for log brevity
    return err.message;
  }
  return 'Internal error';
}

export function truncateNotificationText(text: string): string {
  if (text.length <= 2000) return text;
  return text.slice(0, 1997) + '...';
}

export function messageToText(message: string | EmbedBuilder): string {
  if (typeof message === 'string') return message;
  const embed = message as EmbedBuilder;
  const data = embed.data;
  if (!data) return '';
  const parts: string[] = [];
  if (data.title) parts.push(data.title);
  if (data.description) parts.push(data.description);
  if (data.fields) {
    for (const field of data.fields) {
      parts.push(`${field.name}: ${field.value}`);
    }
  }
  return parts.join('\n');
}

async function postJson(url: string, body: unknown): Promise<void> {
  // Restored: this branch dropped both fail-close guards. A change whose stated
  // purpose is restricting notification boundaries must not remove the boundary
  // that already exists — strict human-surface policy means no outbound send.
  if (isHumanSurfaceReadOnlyEnabled()) return;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await publicFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[Notify] HTTP ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`);
    }
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
      // Restored: this branch sent the raw message, but sendToChannel's contract
      // is Discord's content shape — a bare string arrives without `embeds` and
      // an EmbedBuilder arrives unwrapped. The string->Embed wrapping lives here
      // on purpose (moved from reportToDiscord).
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

/** Slack webhook channel. */
class SlackNotifier implements Notifier {
  constructor(private readonly url: string) {}

  async notify(message: string | EmbedBuilder): Promise<void> {
    try {
      await postJson(this.url, { text: messageToText(message) });
    } catch (err) {
      console.error('[Notify] Slack send failed:', sanitizeNotificationError(err));
    }
  }
}

/** Telegram bot channel. */
class TelegramNotifier implements Notifier {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
  ) {}

  async notify(message: string | EmbedBuilder): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      await postJson(url, {
        chat_id: this.chatId,
        text: messageToText(message),
      });
    } catch (err) {
      console.error('[Notify] Telegram send failed:', sanitizeNotificationError(err));
    }
  }
}

class WebhookNotifier implements Notifier {
  constructor(private readonly url: string) {
    if (!validateWebhookUrl(url)) {
      throw new Error(`Invalid webhook URL: ${url}`);
    }
  }
  async notify(message: string | EmbedBuilder): Promise<void> {
    try {
      await postJson(this.url, { text: messageToText(message) });
    } catch (err) {
      console.error('[Notify] Webhook send failed:', sanitizeNotificationError(err));
    }
  }
}

/** Discord's content shape (string or embeds) — the existing sendToChannel signature. */
type DiscordSend = (content: string | { embeds: EmbedBuilder[] }) => Promise<void>;

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
      if (!config?.webhookUrl) return new NoopNotifier();
      try {
        if (!validateWebhookUrl(config.webhookUrl)) {
          console.error('[Notify] Rejected webhook URL targeting a non-global address');
          return new NoopNotifier();
        }
        return new WebhookNotifier(config.webhookUrl);
      } catch {
        return new NoopNotifier();
      }
    case 'none':
    default:
      return new NoopNotifier();
  }
}