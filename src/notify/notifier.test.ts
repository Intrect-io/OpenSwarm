import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbedBuilder } from 'discord.js';
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) }));
import { createNotifier, messageToText } from './notifier.js';
import { enableHumanSurfaceReadOnly, resetHumanSurfaceReadOnlyForTests } from '../mcp/humanSurfacePolicy.js';

// These suites cover parsing and backend selection, not the socket layer, so
// route publicFetch onto the global fetch they stub. The real implementation —
// including the undici dispatcher contract — is covered by outboundUrl.test.ts.
vi.mock('../support/outboundUrl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../support/outboundUrl.js')>();
  return { ...actual, publicFetch: (url: string | URL, init?: RequestInit) => fetch(String(url), init) };
});


afterEach(() => {
  resetHumanSurfaceReadOnlyForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('messageToText', () => {
  it('passes a string through', () => {
    expect(messageToText('hello')).toBe('hello');
  });

  it('flattens an Embed (title + description + fields)', () => {
    const embed = new EmbedBuilder()
      .setTitle('Title')
      .setDescription('Body')
      .addFields({ name: 'k', value: 'v' });
    const text = messageToText(embed);
    expect(text).toContain('Title');
    expect(text).toContain('Body');
    expect(text).toContain('k: v');
  });
});

describe('createNotifier — channel selection', () => {
  it('returns a Discord notifier when channel=discord and a sender is given', async () => {
    const send = vi.fn(async () => {});
    const n = createNotifier({ channel: 'discord' }, send);
    await n.notify('hi');
    expect(send).toHaveBeenCalledOnce();
    // string is wrapped into an embed
    expect(send.mock.calls[0][0]).toHaveProperty('embeds');
  });

  it('passes an Embed straight through on Discord', async () => {
    const send = vi.fn(async () => {});
    const n = createNotifier({ channel: 'discord' }, send);
    const embed = new EmbedBuilder().setDescription('x');
    await n.notify(embed);
    expect(send.mock.calls[0][0]).toEqual({ embeds: [embed] });
  });

  it('Slack posts {text} to the webhook', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const n = createNotifier({ channel: 'slack', slackWebhookUrl: 'https://hooks.slack/x' });
    await n.notify('deployed');
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://hooks.slack/x');
    expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body)).toEqual({ text: 'deployed' });
  });

  it('Telegram posts to the bot sendMessage endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const n = createNotifier({ channel: 'telegram', telegramBotToken: 'TKN', telegramChatId: '42' });
    await n.notify('ping');
    expect(String(fetchMock.mock.calls[0][0])).toContain('api.telegram.org/botTKN/sendMessage');
    expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body)).toEqual({ chat_id: '42', text: 'ping' });
  });

  it('falls back to Noop (no throw) when a backend credential is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const n = createNotifier({ channel: 'slack' }); // no slackWebhookUrl
    await expect(n.notify('x')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not throw when the backend fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net down'); }));
    const n = createNotifier({ channel: 'slack', slackWebhookUrl: 'https://h/x' });
    await expect(n.notify('x')).resolves.toBeUndefined();
  });

  it('defaults to Noop when no config and no discord sender', async () => {
    const n = createNotifier(undefined);
    await expect(n.notify('x')).resolves.toBeUndefined();
  });

  it('fail-closes Discord, Slack, Telegram, and generic webhook senders when strict policy is enabled', async () => {
    const send = vi.fn(async () => {});
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const notifiers = [
      createNotifier({ channel: 'discord' }, send),
      createNotifier({ channel: 'slack', slackWebhookUrl: 'https://hooks.slack/x' }),
      createNotifier({ channel: 'telegram', telegramBotToken: 'TKN', telegramChatId: '42' }),
      createNotifier({ channel: 'webhook', webhookUrl: 'https://example.com/human-hook' }),
    ];

    // Toggle after construction as well: an already registered notifier must
    // not retain a latent sender when a config reload tightens the boundary.
    enableHumanSurfaceReadOnly();
    await Promise.all(notifiers.map((notifier) => notifier.notify('must not leave the process')));

    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
