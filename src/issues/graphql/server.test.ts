import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { getIntrospectionQuery, parse } from 'graphql';
import { handleGraphQL, isGraphQLTransportAuthorized } from './server.js';
import {
  AUTO_LINK_MEMORIES_COST,
  DEFAULT_QUERY_COST_LIMIT,
  REGISTER_ENTITY_COST,
  REGISTRY_SCAN_COST,
  REGISTRY_WRITE_COST,
  calculateOperationCost,
} from './costAnalysis.js';

function request(address: string | undefined, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress: address }, headers } as unknown as IncomingMessage;
}

interface GraphQLResponseBody {
  data?: unknown;
  errors?: Array<{ extensions?: { code?: string } }>;
}

/** POST a document through the real HTTP handler on a loopback ephemeral port. */
async function postGraphQL(query: string): Promise<{ status: number; body: GraphQLResponseBody }> {
  process.env.OPENSWARM_GRAPHQL_TOKEN = 'secret';
  const httpServer = createServer(async (req, res) => {
    if (req.url?.startsWith('/graphql')) {
      await handleGraphQL(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    const response = await fetch(`http://127.0.0.1:${address.port}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: JSON.stringify({ query }),
    });
    return { status: response.status, body: await response.json() as GraphQLResponseBody };
  } finally {
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  }
}

afterEach(() => { delete process.env.OPENSWARM_GRAPHQL_TOKEN; });

describe('GraphQL transport authorization', () => {
  it('allows a proven loopback transport without trusting Origin', () => {
    expect(isGraphQLTransportAuthorized(request('127.0.0.1'))).toBe(true);
    expect(isGraphQLTransportAuthorized(request('::1'))).toBe(true);
  });

  it('rejects remote and Origin-less transports without a token', () => {
    expect(isGraphQLTransportAuthorized(request('100.64.1.2'))).toBe(false);
    expect(isGraphQLTransportAuthorized(request(undefined))).toBe(false);
  });

  it('allows a remote request with the configured bearer or explicit token', () => {
    process.env.OPENSWARM_GRAPHQL_TOKEN = 'secret';
    expect(isGraphQLTransportAuthorized(request('100.64.1.2', { authorization: 'Bearer secret' }))).toBe(true);
    expect(isGraphQLTransportAuthorized(request('10.0.0.2', { 'x-openswarm-graphql-token': 'secret' }))).toBe(true);
    expect(isGraphQLTransportAuthorized(request('10.0.0.2', { authorization: 'Bearer wrong' }))).toBe(false);
  });

  it('accepts any whitespace separator and any header casing', () => {
    process.env.OPENSWARM_GRAPHQL_TOKEN = 'secret';
    for (const header of ['bearer secret', 'BEARER   secret', 'Bearer\tsecret', 'Bearer secret  ']) {
      expect(isGraphQLTransportAuthorized(request('100.64.1.2', { authorization: header }))).toBe(true);
    }
  });

  it('rejects malformed authorization headers', () => {
    process.env.OPENSWARM_GRAPHQL_TOKEN = 'secret';
    for (const header of ['', 'Bearer', 'Bearer ', 'Bearersecret', 'Basic secret', 'secret']) {
      expect(isGraphQLTransportAuthorized(request('100.64.1.2', { authorization: header }))).toBe(false);
    }
  });

  it('rejects a request with no token configured', () => {
    expect(isGraphQLTransportAuthorized(request('10.0.0.2', { authorization: 'Bearer secret' }))).toBe(false);
  });

  it('parses a tab-padded bearer header in linear time (js/polynomial-redos)', () => {
    process.env.OPENSWARM_GRAPHQL_TOKEN = 'secret';
    // The old /^Bearer\s+(.+)$/i backtracked polynomially on this shape.
    const attack = `Bearer${'\t'.repeat(50_000)}`;

    const started = process.hrtime.bigint();
    expect(isGraphQLTransportAuthorized(request('100.64.1.2', { authorization: attack }))).toBe(false);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(elapsedMs).toBeLessThan(250);
  });

  it('serves a loopback GraphQL request end-to-end', async () => {
    process.env.OPENSWARM_GRAPHQL_TOKEN = 'secret';
    const httpServer = createServer(async (req, res) => {
      if (req.url?.startsWith('/graphql')) {
        await handleGraphQL(req, res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    try {
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('missing test server address');
      const response = await fetch(`http://127.0.0.1:${address.port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ data: { __typename: 'Query' } });
    } finally {
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects aliased autoLinkMemories mutations that exceed the query cost limit', async () => {
    process.env.OPENSWARM_GRAPHQL_TOKEN = 'secret';
    const query = `
      mutation {
        a: autoLinkMemories(issueId: "i1")
        b: autoLinkMemories(issueId: "i2")
      }
    `;
    expect(calculateOperationCost(parse(query))).toBe(AUTO_LINK_MEMORIES_COST * 2);
    expect(AUTO_LINK_MEMORIES_COST * 2).toBeGreaterThan(DEFAULT_QUERY_COST_LIMIT);

    const httpServer = createServer(async (req, res) => {
      if (req.url?.startsWith('/graphql')) {
        await handleGraphQL(req, res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    try {
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('missing test server address');
      const response = await fetch(`http://127.0.0.1:${address.port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
        body: JSON.stringify({ query }),
      });
      expect(response.status).toBe(400);
      const body = await response.json() as { errors?: Array<{ extensions?: { code?: string } }> };
      expect(body.errors?.[0]?.extensions?.code).toBe('GRAPHQL_COST_LIMIT_EXCEEDED');
    } finally {
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe('GraphQL cost accounts for execution multiplication', () => {
  /** A registry write costs real SQLite work per call; the resolver runs once per alias. */
  const write = (alias: string, name: string) =>
    `${alias}: registerEntity(input: { projectId: "p", kind: class, name: "${name}", filePath: "f.ts" }) { id }`;

  it('rejects a fragment of aliased registry writes that is spread many times over the limit', async () => {
    // The fragment holds 5 aliases; 2 spread sites means 10 resolver executions
    // against the store. Before the fix each field cost 1, so this priced at 10
    // against a 500 budget and executed.
    const query = `
      mutation {
        ...Registration
        ...Registration
      }
      fragment Registration on Mutation {
        ${write('a', 'n1')}
        ${write('b', 'n2')}
        ${write('c', 'n3')}
        ${write('d', 'n4')}
        ${write('e', 'n5')}
      }
    `;

    const cost = calculateOperationCost(parse(query));
    expect(cost).toBe(REGISTER_ENTITY_COST * 10);
    expect(cost).toBeGreaterThan(DEFAULT_QUERY_COST_LIMIT);

    const { status, body } = await postGraphQL(query);
    expect(status).toBe(400);
    expect(body.errors?.[0]?.extensions?.code).toBe('GRAPHQL_COST_LIMIT_EXCEEDED');
  });

  it('rejects an aliased bulk registry write that would otherwise execute for a nominal cost', async () => {
    // 6 aliases of a write mutation = one bulk-sized write's worth of store work.
    const query = `mutation {
      ${write('a', 'n1')}
      ${write('b', 'n2')}
      ${write('c', 'n3')}
      ${write('d', 'n4')}
      ${write('e', 'n5')}
      ${write('f', 'n6')}
    }`;

    const cost = calculateOperationCost(parse(query));
    expect(cost).toBe(REGISTER_ENTITY_COST * 6);
    expect(cost).toBeGreaterThan(DEFAULT_QUERY_COST_LIMIT);

    const { status, body } = await postGraphQL(query);
    expect(status).toBe(400);
    expect(body.errors?.[0]?.extensions?.code).toBe('GRAPHQL_COST_LIMIT_EXCEEDED');
  });

  it('still admits a normal query unchanged', async () => {
    // The shape monitorApi and the issue board actually send.
    const query = `
      query {
        issues(filter: { limit: 50 }) { issues { id title status priority } total }
        labels { id name color }
        milestones { id name }
        issueStats { total }
      }
    `;

    const cost = calculateOperationCost(parse(query));
    expect(cost).toBeLessThan(DEFAULT_QUERY_COST_LIMIT);

    const { status, body } = await postGraphQL(query);
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data).toBeDefined();
  });

  it('still admits the GraphiQL introspection query with the priced table in place', () => {
    const cost = calculateOperationCost(parse(getIntrospectionQuery({
      descriptions: true,
      inputValueDeprecation: true,
      schemaDescription: true,
      directiveIsRepeatable: true,
      specifiedByUrl: true,
    })));
    expect(cost).toBeLessThan(DEFAULT_QUERY_COST_LIMIT);
  });

  it('prices registry reads that scan the store above a trivial field', () => {
    // 루트 조회는 대표 비용 + 하위 selectionSet 비용을 함께 청구한다.
    const search = calculateOperationCost(parse(`query { searchEntities(query: "auth", limit: 20) { id } }`));
    expect(search).toBe(REGISTRY_SCAN_COST + 1);
    expect(search).toBeGreaterThan(REGISTRY_WRITE_COST);
    // 테이블에 없는 필드는 기존대로 1 비용이다.
    expect(calculateOperationCost(parse(`query { __typename }`))).toBe(1);
  });
});
