import { describe, expect, it } from 'vitest';
import { drainLinearConnection, effectCommentId, fetchIssuesForStates, parseBlockerIdentifiers } from './linear.js';
import type { LinearClient } from '@linear/sdk';

describe('effectCommentId', () => {
  it('derives a stable, marker-specific UUIDv4 for Linear uniqueness', () => {
    const first = effectCommentId('complete:issue-1:attempt:1');
    expect(first).toBe(effectCommentId('complete:issue-1:attempt:1'));
    expect(first).not.toBe(effectCommentId('complete:issue-1:attempt:2'));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('fetchIssuesForStates pagination', () => {
  it('collects every page', async () => {
    let page = 0;
    const linear = {
      client: {
        rawRequest: async () => ({ data: { issues: {
          nodes: [{ id: `id-${page}`, identifier: `INT-${page}`, title: 't', priority: 2 }],
          pageInfo: { hasNextPage: page++ === 0, endCursor: `cursor-${page}` },
        } } }),
      },
    } as unknown as LinearClient;
    expect((await fetchIssuesForStates(linear, ['Todo'])).nodes.map((node) => node.id)).toEqual(['id-0', 'id-1']);
  });

  it('reports explicit truncation instead of silently returning a partial set', async () => {
    let page = 0;
    const linear = {
      client: {
        rawRequest: async () => ({ data: { issues: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: `cursor-${page++}` },
        } } }),
      },
    } as unknown as LinearClient;
    await expect(fetchIssuesForStates(linear, ['Todo'])).rejects.toThrow(/safety cap/);
  });
});

// INT-1809: the KYTE team writes dependencies as description prose ("블로커: …")
// rather than structured Linear relations, so the text parser is the high-value path.
describe('parseBlockerIdentifiers', () => {
  it('parses slash-separated ids that share a team prefix', () => {
    // The real KT-308 case: "블로커: KT-305/306/307" — 306/307 are bare numbers.
    expect(parseBlockerIdentifiers('블로커: KT-305/306/307')).toEqual([
      'KT-305',
      'KT-306',
      'KT-307',
    ]);
  });

  it('parses comma-separated full identifiers', () => {
    expect(parseBlockerIdentifiers('블로커: KT-302, KT-307')).toEqual(['KT-302', 'KT-307']);
  });

  it('parses the English "Blocked by:" label', () => {
    expect(parseBlockerIdentifiers('Blocked by: INT-1809')).toEqual(['INT-1809']);
  });

  it('tolerates markdown bold around the label', () => {
    expect(parseBlockerIdentifiers('**블로커:** KT-305/306')).toEqual(['KT-305', 'KT-306']);
  });

  it('accepts "Depends on" without a colon', () => {
    expect(parseBlockerIdentifiers('Depends on KT-42')).toEqual(['KT-42']);
  });

  it('only reads the blocker line, not surrounding prose', () => {
    const desc = 'Some intro about issue 999.\n블로커: KT-100\nMore notes mentioning 12345.';
    expect(parseBlockerIdentifiers(desc)).toEqual(['KT-100']);
  });

  it('mixes teams and dedupes', () => {
    expect(parseBlockerIdentifiers('블로커: KT-305, INT-1610, KT-305')).toEqual([
      'KT-305',
      'INT-1610',
    ]);
  });

  it('returns empty for missing or blocker-free descriptions', () => {
    expect(parseBlockerIdentifiers(undefined)).toEqual([]);
    expect(parseBlockerIdentifiers('No dependencies here.')).toEqual([]);
    expect(parseBlockerIdentifiers('블로커: 없음')).toEqual([]);
  });
});

describe('drainLinearConnection', () => {
  function connection(pages: Array<Array<{ id: string }>>) {
    // Mirrors the SDK contract: fetchNext() appends the next page onto the
    // same connection's nodes and resolves the connection itself.
    let page = 0;
    const conn = {
      nodes: [...pages[0]],
      pageInfo: { hasNextPage: pages.length > 1 },
      fetchNext: async () => {
        page += 1;
        conn.nodes.push(...pages[page]);
        conn.pageInfo.hasNextPage = page < pages.length - 1;
        return conn;
      },
    };
    return conn;
  }

  it('follows the connection past the first page instead of truncating', async () => {
    // Discovery used a single `first: 250` read, silently dropping every team
    // or project past the first page in larger workspaces.
    const conn = connection([[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }], [{ id: 'd' }]]);
    await expect(drainLinearConnection(conn)).resolves.toEqual([
      { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' },
    ]);
  });

  it('returns a single page untouched', async () => {
    await expect(drainLinearConnection(connection([[{ id: 'only' }]]))).resolves.toEqual([{ id: 'only' }]);
  });

  it('stops on a pagination cursor that never terminates', async () => {
    const conn = {
      nodes: [{ id: 'x' }],
      pageInfo: { hasNextPage: true },
      fetchNext: async () => conn,
    };
    await expect(drainLinearConnection(conn)).resolves.toEqual([{ id: 'x' }]);
  });

  it('tolerates a connection with no pageInfo', async () => {
    await expect(drainLinearConnection({ nodes: [{ id: 'n' }] })).resolves.toEqual([{ id: 'n' }]);
  });
});
