import { describe, expect, it, vi } from 'vitest';
import { addComment, clearLinearCache, createSubIssue, drainLinearConnection, effectCommentId, fetchIssuesForStates, getInProgressIssues, getNextBacklogIssue, initLinear, LINEAR_ACTIVE_ENRICH_CAP, LINEAR_ACTIVE_MAX_PAGES, LINEAR_ACTIVE_PAGE_SIZE, LINEAR_BACKLOG_PAGE_SIZE, LINEAR_RELATED_PAGE_SIZE, parseBlockerIdentifiers, populateBlockedBy, type LinearIssueInfo, type RawIssueNode } from './linear.js';
import { LinearClient } from '@linear/sdk';

// createSubIssue reads the module-level client singleton (getClient()), set only
// via initLinear()'s real `new LinearClient(...)` — mock the constructor so
// initLinear() installs a fake we control, instead of refactoring the function
// to take an injected client just for this test.
vi.mock('@linear/sdk', () => ({ LinearClient: vi.fn() }));

describe('active/backlog inventory bounds', () => {
  function installIssueClient(opts: {
    nodes: Array<Record<string, unknown>>;
    fetchNextNodes?: Array<Record<string, unknown>>;
    expectedFirst: number;
  }) {
    clearLinearCache();
    const makeIssue = (node: Record<string, unknown>) => ({
      ...node,
      comments: vi.fn(async (args?: { first?: number }) => {
        expect(args?.first).toBe(LINEAR_RELATED_PAGE_SIZE);
        return { nodes: [] };
      }),
      labels: vi.fn(async (args?: { first?: number }) => {
        expect(args?.first).toBe(LINEAR_RELATED_PAGE_SIZE);
        return { nodes: [] };
      }),
      state: Promise.resolve({ name: 'In Progress' }),
      project: Promise.resolve(undefined),
    });

    const connection = {
      nodes: opts.nodes.map(makeIssue),
      pageInfo: { hasNextPage: Boolean(opts.fetchNextNodes?.length) },
      fetchNext: async () => {
        connection.nodes.push(...(opts.fetchNextNodes ?? []).map(makeIssue));
        connection.pageInfo.hasNextPage = false;
        return connection;
      },
    };

    const fakeClient = {
      issues: vi.fn(async (args: { first?: number }) => {
        expect(args.first).toBe(opts.expectedFirst);
        return connection;
      }),
    };
    vi.mocked(LinearClient).mockImplementation(function (this: unknown) { return fakeClient as never; } as never);
    initLinear('fake-key', 'team-1');
    return { fakeClient, connection };
  }

  it('bounds active-issue pagination and enrichment work', async () => {
    const page1 = Array.from({ length: LINEAR_ACTIVE_PAGE_SIZE }, (_, i) => ({
      id: `a-${i}`,
      identifier: `AGT-${i}`,
      title: `Active ${i}`,
      url: `https://linear.app/i/${i}`,
      description: null,
      priority: 2,
    }));
    const page2 = Array.from({ length: LINEAR_ACTIVE_PAGE_SIZE }, (_, i) => ({
      id: `b-${i}`,
      identifier: `AGT-B-${i}`,
      title: `Active B ${i}`,
      url: `https://linear.app/i/b${i}`,
      description: null,
      priority: 3,
    }));
    const { fakeClient } = installIssueClient({
      nodes: page1,
      fetchNextNodes: page2,
      expectedFirst: LINEAR_ACTIVE_PAGE_SIZE,
    });

    const result = await getInProgressIssues('worker');
    expect(fakeClient.issues).toHaveBeenCalledWith(expect.objectContaining({
      first: LINEAR_ACTIVE_PAGE_SIZE,
    }));
    expect(result.length).toBeLessThanOrEqual(LINEAR_ACTIVE_ENRICH_CAP);
    expect(result.length).toBe(LINEAR_ACTIVE_PAGE_SIZE * Math.min(2, LINEAR_ACTIVE_MAX_PAGES));
  });

  it('bounds backlog list retrieval before picking the next issue', async () => {
    const nodes = Array.from({ length: LINEAR_BACKLOG_PAGE_SIZE + 5 }, (_, i) => ({
      id: `bl-${i}`,
      identifier: `AGT-BL-${i}`,
      title: `Backlog ${i}`,
      url: `https://linear.app/i/bl${i}`,
      description: null,
      priority: i === 0 ? 0 : 1,
    }));
    const { fakeClient } = installIssueClient({
      nodes,
      expectedFirst: LINEAR_BACKLOG_PAGE_SIZE,
    });
    const next = await getNextBacklogIssue('worker');
    expect(fakeClient.issues).toHaveBeenCalledWith(expect.objectContaining({
      first: LINEAR_BACKLOG_PAGE_SIZE,
    }));
    expect(next?.identifier).toBe('AGT-BL-1');
  });
});

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
    const queries: string[] = [];
    const linear = {
      client: {
        rawRequest: async (query: string) => {
          queries.push(query);
          return ({ data: { issues: {
          nodes: [{ id: `id-${page}`, identifier: `INT-${page}`, title: 't', priority: 2 }],
          pageInfo: { hasNextPage: page++ === 0, endCursor: `cursor-${page}` },
          } } });
        },
      },
    } as unknown as LinearClient;
    expect((await fetchIssuesForStates(linear, ['Todo'])).nodes.map((node) => node.id)).toEqual(['id-0', 'id-1']);
    expect(queries[0]).toMatch(/\burl\b/);
    // The native blockers ride the same request (AGT-4050): one nested field,
    // not one `inverseRelations()` resolver call per issue — measured 100
    // issues at complexity 54 in 0.4 s against the live API.
    expect(queries[0]).toMatch(/inverseRelations\(first: \d+\) \{ nodes \{ type issue \{ id \} \} \}/);
    expect(queries).toHaveLength(2);
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

  it('honors an explicit maxPages cap for active-inventory drains', async () => {
    const pages = Array.from({ length: 6 }, (_, i) => [{ id: `p${i}` }]);
    const conn = connection(pages);
    await expect(drainLinearConnection(conn, LINEAR_ACTIVE_MAX_PAGES)).resolves.toEqual(
      pages.slice(0, LINEAR_ACTIVE_MAX_PAGES).flat(),
    );
  });

  it('tolerates a connection with no pageInfo', async () => {
    await expect(drainLinearConnection({ nodes: [{ id: 'n' }] })).resolves.toEqual([{ id: 'n' }]);
  });
});

// AGT-4048: a decomposition retry re-plans (and so regenerates) every sub-task's
// title/description, but reuses the same stable per-slot idempotencyId. The
// fix is to converge on an existing sub-issue by that ID + parent alone —
// content is diagnostic only, never a reason to treat "already created" as a
// hard failure.
describe('createSubIssue idempotent recovery (AGT-4048)', () => {
  function installFakeLinearClient(overrides: { existingChild: Record<string, unknown> }) {
    const parentIssue = { id: 'parent-uuid', team: Promise.resolve({ id: 'team-uuid' }) };
    const team = { labels: vi.fn(async () => ({ nodes: [] })) };
    const fakeClient = {
      issue: vi.fn(async (id: string) => {
        if (id === 'parent-uuid') return parentIssue;
        if (id === 'child-uuid-1') return overrides.existingChild;
        throw new Error(`unexpected issue() call: ${id}`);
      }),
      team: vi.fn(async () => team),
      createIssue: vi.fn(async () => {
        throw new Error('Conflict on insert of Issue - Entity Issue with id child-uuid-1 already exists.');
      }),
    };
    vi.mocked(LinearClient).mockImplementation(function (this: unknown) { return fakeClient as never; } as never);
    initLinear('fake-key', 'team-1');
    return fakeClient;
  }

  it('recovers the existing sub-issue by ID+parent alone when the re-planned title/description differs', async () => {
    installFakeLinearClient({
      existingChild: {
        id: 'child-uuid-1',
        identifier: 'INT-501',
        title: 'Original title from the first attempt',
        description: 'Original description',
        priority: 3,
        parent: Promise.resolve({ id: 'parent-uuid' }),
        state: Promise.resolve({ name: 'Todo' }),
      },
    });

    const result = await createSubIssue(
      'parent-uuid',
      'A freshly re-planned title that differs from the first attempt',
      'A freshly re-planned description',
      { idempotencyId: 'child-uuid-1' },
    );

    expect(result).toMatchObject({ id: 'child-uuid-1', identifier: 'INT-501' });
  });

  it('rejects convergence when the existing artifact belongs to a different parent', async () => {
    installFakeLinearClient({
      existingChild: {
        id: 'child-uuid-1',
        identifier: 'INT-501',
        title: 'Original title',
        description: 'Original description',
        priority: 3,
        parent: Promise.resolve({ id: 'some-other-parent' }),
        state: Promise.resolve({ name: 'Todo' }),
      },
    });

    const result = await createSubIssue('parent-uuid', 'Re-planned title', 'Re-planned description', {
      idempotencyId: 'child-uuid-1',
    });

    expect(result).toHaveProperty('error');
  });
});

// AGT-4051: same shape as AGT-4048, one call deeper — a stable commentId is
// the identity guarantee; the body (which callers bake a timestamp into) can
// legitimately differ on every retry and must not block convergence.
describe('addComment idempotent recovery (AGT-4051)', () => {
  it('converges on an existing comment by id+issue alone, even when the body differs (a timestamp changed)', async () => {
    const fakeClient = {
      createComment: vi.fn(async () => {
        throw new Error('Conflict on insert of Comment - Entity Comment with id comment-1 already exists.');
      }),
      comment: vi.fn(async ({ id }: { id: string }) =>
        id === 'comment-1'
          ? { body: 'stale body with an old timestamp', issue: Promise.resolve({ id: 'issue-1' }) }
          : (() => { throw new Error(`unexpected comment() call: ${id}`); })()),
    };
    vi.mocked(LinearClient).mockImplementation(function (this: unknown) { return fakeClient as never; } as never);
    initLinear('fake-key', 'team-1');

    await expect(addComment('issue-1', 'fresh body with a new timestamp', 'comment-1')).resolves.toBeUndefined();
  });

  it('rejects convergence when the existing comment belongs to a different issue', async () => {
    const fakeClient = {
      createComment: vi.fn(async () => {
        throw new Error('Conflict on insert of Comment - Entity Comment with id comment-1 already exists.');
      }),
      comment: vi.fn(async () => ({ body: 'body', issue: Promise.resolve({ id: 'some-other-issue' }) })),
    };
    vi.mocked(LinearClient).mockImplementation(function (this: unknown) { return fakeClient as never; } as never);
    initLinear('fake-key', 'team-1');

    await expect(addComment('issue-1', 'body', 'comment-1')).rejects.toThrow('already exists');
  });
});

// AGT-4050: a task blocked only through Linear's own "Blocked by" relation
// used to look ready to the bulk fetch — only prose blockers were read — and
// paid a draft-analysis call every heartbeat (AX-856 on 2026-08-29).
describe('populateBlockedBy', () => {
  function info(id: string, description?: string): LinearIssueInfo {
    return { id, identifier: id.toUpperCase(), title: id, state: 'Todo', priority: 2, labels: [], comments: [], description } as LinearIssueInfo;
  }
  function node(id: string, blockers: string[], others: string[] = []): RawIssueNode {
    return {
      id, identifier: id.toUpperCase(), title: id, priority: 2,
      inverseRelations: { nodes: [
        ...blockers.map((issueId) => ({ type: 'blocks', issue: { id: issueId } })),
        ...others.map((issueId) => ({ type: 'related', issue: { id: issueId } })),
      ] },
    };
  }

  it('reads a native "blocks" relation from the embedded node, ignoring other relation types', () => {
    const result = [info('ax-856'), info('ax-869'), info('ax-858'), info('ax-1')];
    populateBlockedBy(result, new Map([
      ['ax-856', node('ax-856', ['ax-869', 'ax-858'], ['ax-1'])],
      ['ax-869', node('ax-869', [])], ['ax-858', node('ax-858', [])], ['ax-1', node('ax-1', [])],
    ]));
    expect(result[0].blockedBy).toEqual(['ax-869', 'ax-858']);
    expect(result[1].blockedBy).toBeUndefined();
    expect(result[3].blockedBy).toBeUndefined();
  });

  it('drops a native blocker that is not in the fetch set (Done or out of scope) and never self-references', () => {
    const result = [info('ax-856')];
    populateBlockedBy(result, new Map([['ax-856', node('ax-856', ['ax-done', 'ax-856'])]]));
    expect(result[0].blockedBy).toBeUndefined();
  });

  it('merges native relations with prose blockers without duplicates', () => {
    const result = [info('kt-308', '블로커: KT-305/306'), info('kt-305'), info('kt-306')];
    populateBlockedBy(result, new Map([
      ['kt-308', node('kt-308', ['kt-305'])], ['kt-305', node('kt-305', [])], ['kt-306', node('kt-306', [])],
    ]));
    expect(result[0].blockedBy).toEqual(['kt-305', 'kt-306']);
  });

  it('tolerates a node without relations (older query shape, or a null connection)', () => {
    const result = [info('ax-1')];
    populateBlockedBy(result, new Map([['ax-1', { id: 'ax-1', identifier: 'AX-1', title: 'ax-1', priority: 2, inverseRelations: null }]]));
    expect(result[0].blockedBy).toBeUndefined();
  });
});
