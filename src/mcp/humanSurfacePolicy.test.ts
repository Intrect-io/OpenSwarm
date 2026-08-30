import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../adapters/tools.js';
import {
  attachMcpToolPolicy,
  describeMcpToolPolicy,
  filterHumanSurfaceMcpTools,
  humanSurfaceShellWriteReason,
  stripHumanSurfaceEnv,
} from './humanSurfacePolicy.js';

const tool = (name: string, description = ''): ToolDefinition => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object' } },
});

describe('human-surface MCP policy', () => {
  it('recognizes server, camelCase action, and descriptor instead of one substring', () => {
    const decision = describeMcpToolPolicy(tool('slack__chat_postMessage'));
    expect(decision).toMatchObject({ server: 'slack', action: 'chat_postMessage', surface: 'human', access: 'write' });
    expect(decision.humanSurfaceReadAllowed).toBe(false);

    // Exact identifier tokens avoid treating an unrelated server as Slack.
    expect(describeMcpToolPolicy(tool('slackarchive__get_record')).surface).toBe('unknown');
    expect(describeMcpToolPolicy(tool('google-drive__create_file')).surface).toBe('human');
    expect(describeMcpToolPolicy(tool('relay__create_page', 'Create a page in Notion')).surface).toBe('human');
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
      GITHUB_TOKEN: 'keep',
      POSTGRES_DSN: 'keep',
      OPENAI_API_KEY: 'keep',
      OPENAI_CHAT_MODEL: 'keep',
      SANDBOX_DATA_PATH: '/warehouse',
    });
    expect(env).not.toHaveProperty('SLACK_BOT_TOKEN');
    expect(env).not.toHaveProperty('DISCORD_WEBHOOK_URL');
    expect(env).not.toHaveProperty('NOTION_API_KEY');
    expect(env).not.toHaveProperty('GOOGLE_DRIVE_TOKEN');
    expect(env).toMatchObject({
      GITHUB_TOKEN: 'keep',
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
    expect(humanSurfaceShellWriteReason("python -c \"requests.post('https://discord.com/api/webhooks/x')\"")).toContain('discord.com');

    expect(humanSurfaceShellWriteReason('curl -X GET https://api.slack.com/methods/conversations.list')).toBeUndefined();
    expect(humanSurfaceShellWriteReason("curl -G -d'channel=C1' https://api.slack.com/methods/conversations.list")).toBeUndefined();
    expect(humanSurfaceShellWriteReason("curl -X POST -d '{}' https://api.github.com/repos/o/r/issues")).toBeUndefined();
    expect(humanSurfaceShellWriteReason("psql '$POSTGRES_DSN' -c 'select 1'")).toBeUndefined();
    expect(humanSurfaceShellWriteReason("rg 'slack post' src")).toBeUndefined();
  });
});
