import { describe, expect, it } from 'vitest';
import { LinearClient } from '@linear/sdk';
import { fetchProjectOverviewIssues } from './projectUpdater.js';

describe('fetchProjectOverviewIssues pagination', () => {
  it('collects every page until hasNextPage is false', async () => {
    let page = 0;
    const linear = {
      client: {
        rawRequest: async () => {
          const current = page++;
          return {
            data: {
              project: {
                issues: {
                  nodes: [{ priority: current + 1, state: { name: `S${current}` } }],
                  pageInfo: {
                    hasNextPage: current === 0,
                    endCursor: current === 0 ? 'cursor-1' : null,
                  },
                },
              },
            },
          };
        },
      },
    } as unknown as LinearClient;

    const nodes = await fetchProjectOverviewIssues(linear, 'proj-1');
    expect(nodes.map((n) => n.state?.name)).toEqual(['S0', 'S1']);
  });

  it('rejects a missing endCursor while more pages are claimed', async () => {
    const linear = {
      client: {
        rawRequest: async () => ({
          data: {
            project: {
              issues: {
                nodes: [{ priority: 1, state: { name: 'Todo' } }],
                pageInfo: { hasNextPage: true, endCursor: null },
              },
            },
          },
        }),
      },
    } as unknown as LinearClient;

    await expect(fetchProjectOverviewIssues(linear, 'proj-1')).rejects.toThrow(
      /missing or repeated cursor/,
    );
  });

  it('rejects a repeated endCursor that cannot progress', async () => {
    const linear = {
      client: {
        rawRequest: async () => ({
          data: {
            project: {
              issues: {
                nodes: [{ priority: 2, state: { name: 'Todo' } }],
                pageInfo: { hasNextPage: true, endCursor: 'same-cursor' },
              },
            },
          },
        }),
      },
    } as unknown as LinearClient;

    // First page sets after=same-cursor; second page returns the same cursor again.
    await expect(fetchProjectOverviewIssues(linear, 'proj-1')).rejects.toThrow(
      /missing or repeated cursor/,
    );
  });

  it('reports explicit truncation instead of silently returning a partial set', async () => {
    let page = 0;
    const linear = {
      client: {
        rawRequest: async () => ({
          data: {
            project: {
              issues: {
                nodes: [{ priority: 1, state: { name: 'Todo' } }],
                pageInfo: { hasNextPage: true, endCursor: `cursor-${page++}` },
              },
            },
          },
        }),
      },
    } as unknown as LinearClient;

    await expect(fetchProjectOverviewIssues(linear, 'proj-1')).rejects.toThrow(/safety cap/);
  });

  it('rejects a null issues connection', async () => {
    const linear = {
      client: {
        rawRequest: async () => ({ data: { project: { issues: null } } }),
      },
    } as unknown as LinearClient;

    await expect(fetchProjectOverviewIssues(linear, 'proj-1')).rejects.toThrow(
      /no issues connection/,
    );
  });
});
