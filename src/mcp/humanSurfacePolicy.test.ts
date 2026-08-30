import { afterEach, describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../adapters/tools.js';
import {
  attachMcpToolPolicy,
  describeMcpToolPolicy,
  enableHumanSurfaceReadOnly,
  filterHumanSurfaceMcpTools,
  humanSurfaceShellWriteReason,
  isHumanSurfaceReadOnlyEnabled,
  resetHumanSurfaceReadOnlyForTests,
  stripHumanSurfaceEnv,
} from './humanSurfacePolicy.js';

afterEach(() => resetHumanSurfaceReadOnlyForTests());

const tool = (name: string, description = ''): ToolDefinition => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object' } },
});

describe('human-surface MCP policy', () => {
  it('has a one-way production setter so later config reads cannot downgrade strict mode', () => {
    expect(isHumanSurfaceReadOnlyEnabled()).toBe(false);
    enableHumanSurfaceReadOnly();
    enableHumanSurfaceReadOnly();
    expect(isHumanSurfaceReadOnlyEnabled()).toBe(true);
  });

  it('recognizes server, camelCase action, and descriptor instead of one substring', () => {
    const decision = describeMcpToolPolicy(tool('slack__chat_postMessage'));
    expect(decision).toMatchObject({ server: 'slack', action: 'chat_postMessage', surface: 'human', access: 'write' });
    expect(decision.humanSurfaceReadAllowed).toBe(false);

    // Exact identifier tokens avoid treating an unrelated server as Slack.
    expect(describeMcpToolPolicy(tool('slackarchive__get_record')).surface).toBe('unknown');
    expect(describeMcpToolPolicy(tool('google-drive__create_file')).surface).toBe('human');
    expect(describeMcpToolPolicy(tool('relay__create_page', 'Create a page in Notion')).surface).toBe('human');
    expect(describeMcpToolPolicy(tool('relay__sendMail')).surface).toBe('human');
  });

  it('narrows Microsoft Graph classification to human-facing actions', () => {
    const identity = { serverIdentityHints: ['https://graph.microsoft.com/v1.0'] };
    expect(describeMcpToolPolicy(tool('graph__create_message'), identity)).toMatchObject({
      surface: 'human',
      access: 'write',
      humanSurfaceReadAllowed: false,
    });
    expect(describeMcpToolPolicy(tool('graph__list_messages'), identity)).toMatchObject({
      surface: 'human',
      access: 'read',
      humanSurfaceReadAllowed: true,
    });
    expect(describeMcpToolPolicy(tool('graph__update_device'), identity).surface).toBe('unknown');
  });

  it('allows only explicit read/list/get/search/fetch actions on a human surface', () => {
    const tools = [
      tool('slack__list_channels'),
      tool('notion__fetch_page'),
      tool('discord__chat_history'),
      tool('email__send_message'),
      tool('notion__get_or_create_page'),
    ];
    const result = filterHumanSurfaceMcpTools(tools);
    expect(result.tools.map((entry) => entry.function.name)).toEqual(['slack__list_channels', 'notion__fetch_page']);
    expect(result.denied.map((entry) => entry.name)).toEqual([
      'discord__chat_history',
      'email__send_message',
      'notion__get_or_create_page',
    ]);
  });

  it('uses an explicit surface label for opaque custom server aliases', () => {
    const definition = tool('company_portal__history');
    attachMcpToolPolicy(definition, {
      server: 'company_portal',
      action: 'history',
      declaredSurface: 'human',
      annotations: { readOnlyHint: true },
    });
    const decision = describeMcpToolPolicy(definition);
    expect(decision.surface).toBe('human');
    // An untrusted readOnlyHint cannot expand the five-action allowlist.
    expect(decision.humanSurfaceReadAllowed).toBe(false);
  });

  it('lets annotations tighten access but never excuse a mutating name', () => {
    expect(describeMcpToolPolicy('github__get_issue', { annotations: { readOnlyHint: false } }).access).toBe('write');
    expect(describeMcpToolPolicy('slack__post_message', { annotations: { readOnlyHint: true } }).access).toBe('write');
    expect(describeMcpToolPolicy('cloudflare__get_worker', { annotations: { destructiveHint: true } }).access).toBe('destructive');
  });
});

describe('human-surface shell boundary', () => {
  it('removes human-surface credentials while preserving provider, DevOps, DB, and sandbox data env', () => {
    const env = stripHumanSurfaceEnv({
      SLACK_BOT_TOKEN: 'secret',
      DISCORD_WEBHOOK_URL: 'secret',
      NOTION_API_KEY: 'secret',
      GOOGLE_DRIVE_TOKEN: 'secret',
      GOOGLE_CALENDAR_API_KEY: 'secret',
      CALENDAR_TOKEN: 'secret',
      MS_GRAPH_TOKEN: 'secret',
      MICROSOFT_GRAPH_ACCESS_TOKEN: 'secret',
      GITHUB_TOKEN: 'keep',
      AZURE_CLIENT_SECRET: 'keep',
      GRAPH_DATABASE_PASSWORD: 'keep',
      POSTGRES_DSN: 'keep',
      OPENAI_API_KEY: 'keep',
      OPENAI_CHAT_MODEL: 'keep',
      SANDBOX_DATA_PATH: '/warehouse',
    });
    expect(env).not.toHaveProperty('SLACK_BOT_TOKEN');
    expect(env).not.toHaveProperty('DISCORD_WEBHOOK_URL');
    expect(env).not.toHaveProperty('NOTION_API_KEY');
    expect(env).not.toHaveProperty('GOOGLE_DRIVE_TOKEN');
    expect(env).not.toHaveProperty('GOOGLE_CALENDAR_API_KEY');
    expect(env).not.toHaveProperty('CALENDAR_TOKEN');
    expect(env).not.toHaveProperty('MS_GRAPH_TOKEN');
    expect(env).not.toHaveProperty('MICROSOFT_GRAPH_ACCESS_TOKEN');
    expect(env).toMatchObject({
      GITHUB_TOKEN: 'keep',
      AZURE_CLIENT_SECRET: 'keep',
      GRAPH_DATABASE_PASSWORD: 'keep',
      POSTGRES_DSN: 'keep',
      OPENAI_API_KEY: 'keep',
      OPENAI_CHAT_MODEL: 'keep',
      SANDBOX_DATA_PATH: '/warehouse',
    });
  });

  it('blocks direct human-surface writes but preserves reads and DevOps/data commands', () => {
    expect(humanSurfaceShellWriteReason("curl -X POST -d '{\"text\":\"hi\"}' https://hooks.slack.com/services/T/B/X"))
      .toContain('hooks.slack.com');
    expect(humanSurfaceShellWriteReason("curl -d'{\"text\":\"hi\"}' https://hooks.slack.com/services/T/B/X"))
      .toContain('hooks.slack.com');
    expect(humanSurfaceShellWriteReason("curl --json '{\"text\":\"hi\"}' https://hooks.slack.com/services/T/B/X"))
      .toContain('hooks.slack.com');
    expect(humanSurfaceShellWriteReason("env -i curl --data-binary @payload.json https://hooks.slack.com/services/T/B/X"))
      .toContain('hooks.slack.com');
    expect(humanSurfaceShellWriteReason("bash -c \"curl -d'{}' https://hooks.slack.com/services/T/B/X\""))
      .toContain('hooks.slack.com');
    expect(humanSurfaceShellWriteReason("sender=curl; $sender -d'{}' https://hooks.slack.com/services/T/B/X"))
      .toContain('hooks.slack.com');
    expect(humanSurfaceShellWriteReason("wget --method=POST https://discord.com/api/webhooks/x"))
      .toContain('discord.com');
    expect(humanSurfaceShellWriteReason('slack chat send --channel ops --text hello')).toContain('service slack');
    expect(humanSurfaceShellWriteReason("bash -c 'slack chat send --channel ops --text hello'"))
      .toContain('service slack');
    expect(humanSurfaceShellWriteReason('npx @company/slack-cli post --channel ops --text hello'))
      .toContain('service slack');
    expect(humanSurfaceShellWriteReason('pnpm dlx notion-cli create page'))
      .toContain('service notion');
    expect(humanSurfaceShellWriteReason("python -c \"requests.post('https://discord.com/api/webhooks/x')\"")).toContain('discord.com');
    expect(humanSurfaceShellWriteReason(
      "curl -X POST -H 'Authorization: Bearer '$MS_GRAPH_TOKEN -d '{}' https://graph.microsoft.com/v1.0/me/messages",
    )).toContain('Microsoft Graph human API messages');
    expect(humanSurfaceShellWriteReason(
      "curl -X POST -d '{}' https://graph.microsoft.com/v1.0/chats/123/messages",
    )).toContain('Microsoft Graph human API chats');
    expect(humanSurfaceShellWriteReason(
      "curl -X POST -d '{}' https://graph.microsoft.com/v1.0/me/sendMail",
    )).toContain('Microsoft Graph human API mail');

    expect(humanSurfaceShellWriteReason('curl -X GET https://api.slack.com/methods/conversations.list')).toBeUndefined();
    expect(humanSurfaceShellWriteReason('curl -X GET https://graph.microsoft.com/v1.0/me/messages')).toBeUndefined();
    expect(humanSurfaceShellWriteReason(
      "curl -X PATCH -d '{}' https://graph.microsoft.com/v1.0/devices/123/extensionAttributes",
    )).toBeUndefined();
    expect(humanSurfaceShellWriteReason("curl -G -d'channel=C1' https://api.slack.com/methods/conversations.list")).toBeUndefined();
    expect(humanSurfaceShellWriteReason("curl -X POST -d '{}' https://api.github.com/repos/o/r/issues")).toBeUndefined();
    expect(humanSurfaceShellWriteReason("psql '$POSTGRES_DSN' -c 'select 1'")).toBeUndefined();
    expect(humanSurfaceShellWriteReason("rg 'slack post' src")).toBeUndefined();
  });
});
