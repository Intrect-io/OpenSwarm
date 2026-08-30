import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../adapters/tools.js';
import { classifyMcpTool, filterMcpToolsForRole } from './mcpPolicy.js';

const tool = (name: string): ToolDefinition => ({ type: 'function', function: { name, description: '', parameters: { type: 'object' } } });

describe('MCP role policy', () => {
  it('classifies read, write, and destructive operations conservatively', () => {
    expect(classifyMcpTool('github__get_issue')).toBe('read');
    expect(classifyMcpTool('linear__save_comment')).toBe('write');
    expect(classifyMcpTool('slack__chat_postMessage')).toBe('write');
    expect(classifyMcpTool('discord__send_message')).toBe('write');
    expect(classifyMcpTool('cloudflare__delete_worker')).toBe('destructive');
  });

  it('reads the verb from a nested tool name, not just the segment after the server', () => {
    // `github__pulls__merge` puts the verb last; classifying on the middle
    // segment alone called a merge a read and let it through as one.
    expect(classifyMcpTool('github__pulls__merge')).toBe('destructive');
    expect(classifyMcpTool('linear__issues__save_comment')).toBe('write');
    expect(classifyMcpTool('github__pulls__get')).toBe('read');
  });

  it('allows read tools from allowlisted servers and denies everything else', () => {
    const result = filterMcpToolsForRole(
      [tool('github__get_issue'), tool('linear__list_issues'), tool('unknown__read')],
      { servers: ['github', 'linear'] },
    );
    expect(result.tools.map((entry) => entry.function.name)).toEqual(['github__get_issue', 'linear__list_issues']);
    expect(result.denied[0].reason).toContain('not allowlisted');
  });

  it('requires exact grants for write and destructive tools', () => {
    const tools = [tool('linear__save_comment'), tool('github__merge_pull_request')];
    expect(filterMcpToolsForRole(tools, { servers: ['linear', 'github'] }).tools).toEqual([]);
    expect(filterMcpToolsForRole(tools, {
      servers: ['linear', 'github'],
      writeTools: ['linear__save_comment'],
      destructiveTools: ['github__merge_pull_request'],
    }).tools).toEqual(tools);
  });

  it('does not let an exact role grant widen human-surface authority', () => {
    const tools = [tool('slack__list_channels'), tool('slack__chat_postMessage'), tool('notion__create_page')];
    const result = filterMcpToolsForRole(tools, {
      servers: ['slack', 'notion'],
      writeTools: ['slack__chat_postMessage', 'notion__create_page'],
    });
    expect(result.tools.map((entry) => entry.function.name)).toEqual(['slack__list_channels']);
    expect(result.denied).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'slack__chat_postMessage', reason: expect.stringContaining('human surface is read-only') }),
      expect.objectContaining({ name: 'notion__create_page', reason: expect.stringContaining('human surface is read-only') }),
    ]));
  });

  it('keeps generic human reads dispatchable and requires exact grants for generic DevOps writes', () => {
    const humanRequest = tool('slack__request');
    const devopsRequest = tool('github__http_post_request');

    expect(filterMcpToolsForRole([humanRequest], { servers: ['slack'] }).tools).toEqual([humanRequest]);
    expect(filterMcpToolsForRole([devopsRequest], { servers: ['github'] }).tools).toEqual([]);
    expect(filterMcpToolsForRole([devopsRequest], {
      servers: ['github'],
      writeTools: ['github__http_post_request'],
    }).tools).toEqual([devopsRequest]);
  });

  it('preserves exact DevOps and data mutations', () => {
    const tools = [tool('github__create_issue'), tool('cloudflare__delete_worker'), tool('postgres__update_row')];
    const result = filterMcpToolsForRole(tools, {
      servers: ['github', 'cloudflare', 'postgres'],
      writeTools: ['github__create_issue', 'postgres__update_row'],
      destructiveTools: ['cloudflare__delete_worker'],
    });
    expect(result.tools).toEqual(tools);
  });
});
