import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../adapters/tools.js';
import { classifyMcpTool, filterMcpToolsForRole } from './mcpPolicy.js';

const tool = (name: string): ToolDefinition => ({ type: 'function', function: { name, description: '', parameters: { type: 'object' } } });

describe('MCP role policy', () => {
  it('classifies read, write, and destructive operations conservatively', () => {
    expect(classifyMcpTool('github__get_issue')).toBe('read');
    expect(classifyMcpTool('linear__save_comment')).toBe('write');
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
});
