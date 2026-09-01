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

/**
 * Non-global special-use IPv4 ranges that must be rejected as notification
 * destinations.  Based on IANA IPv4 Special-Purpose Address Registry and
 * RFC 6890 / RFC 8190.
 *
 * - 127.0.0.0/8       — Loopback
 * - 169.254.0.0/16    — Link-local
 * - 10.0.0.0/8        — Private (Class A)
 * - 172.16.0.0/12     — Private (Class B)
 * - 192.168.0.0/16    — Private (Class C)
 * - 100.64.0.0/10     — Carrier-grade NAT (CGNAT, RFC 6598)
 */
const NON_GLOBAL_IPV4_RANGES: ReadonlyArray<{
  prefix: number;
  mask: number;
  maskBits: number;
}> = [
  { prefix: 0x7f000000, mask: 0xff000000, maskBits: 8 },   // 127.0.0.0/8
  { prefix: 0xa9fe0000, mask: 0xffff0000, maskBits: 16 },   // 169.254.0.0/16
  { prefix: 0x0a000000, mask: 0xff000000, maskBits: 8 },    // 10.0.0.0/8
  { prefix: 0xac100000, mask: 0xfff00000, maskBits: 12 },   // 172.16.0.0/12
  { prefix: 0xc0a80000, mask: 0xffff0000, maskBits: 16 },   // 192.168.0.0/16
  { prefix: 0x64400000, mask: 0xffc00000, maskBits: 10 },   // 100.64.0.0/10 (CGNAT)
];

function octetsToInt(a: number, b: number, c: number, d: number): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/**
 * Validates a webhook URL.
 *
 * Returns `true` if the URL is acceptable (global IP or DNS name).
 * Returns `false` if the URL resolves to a non-global special-use IPv4 address
 * or is malformed.
 */
function validateWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    const hostname = parsed.hostname;
    // Basic IPv4 regex
    const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!ipMatch) return true; // DNS name — cannot validate statically

    const octets = ipMatch.slice(1).map(Number);
    if (octets.some(o => o < 0 || o > 255)) return false;

    const [a, b, c, d] = octets;
    const addr = octetsToInt(a, b, c, d);

    // Check all non-global IPv4 ranges including CGNAT (100.64.0.0/10)
    for (const range of NON_GLOBAL_IPV4_RANGES) {
      if ((addr & range.mask) === range.prefix) return false;
    }

    return true;
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
  const embed = message;
  const parts: string[] = [];
  if (embed.data.title) parts.push(embed.data.title);
  if (embed.data.description) parts.push(embed.data.description);
  if (embed.data.fields) {
    for (const field of embed.data.fields) {
      parts.push(`${field.name}: ${field.value}`);
    }
  }
  return parts.join('\n');
}

async function postJson(url: string, body: unknown): Promise<void> {
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
    try {
      await this.send(message);
    } catch (err) {
      console.error('[Notify] Discord send failed:', sanitizeNotificationError(err));
    }
  }
}

/** Slack webhook. */
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

/** Telegram bot. */
class TelegramNotifier implements Notifier {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
  ) {}
  async notify(message: string | EmbedBuilder): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
      await postJson(url, { chat_id: this.chatId, text: messageToText(message) });
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

type DiscordSend = (message: string | EmbedBuilder) => Promise<void>;

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
          console.error('[Notify] Rejected webhook URL targeting non-global IPv4 address');
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