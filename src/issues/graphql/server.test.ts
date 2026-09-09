import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { handleGraphQL, isGraphQLTransportAuthorized } from './server.js';
import { calculateOperationCost, BULK_REGISTER_ENTITIES_COST, DEFAULT_QUERY_COST_LIMIT } from './costAnalysis.js';
import { parse } from 'graphql';

function request(address: string | undefined, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress: address }, headers } as unknown as IncomingMessage;
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
    expect(isGraphQLTransportAuthorized(request('10.0.0.2', {
      'x-openswarm-graphql-token': 'secret',
    }))).toBe(true);
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
});

describe('calculateOperationCost', () => {
  it('returns 1 for a simple query', () => {
    const doc = parse('{ __typename }');
    expect(calculateOperationCost(doc)).toBe(1);
  });

  it('returns the base cost for a single bulkRegisterEntities mutation', () => {
    const doc = parse(`
      mutation {
        bulkRegisterEntities(input: [{ qualifiedName: "x", kind: CLASS }]) { id }
      }
    `);
    const cost = calculateOperationCost(doc);
    expect(cost).toBe(BULK_REGISTER_ENTITIES_COST);
  });

  it('multiplies cost for aliased bulkRegisterEntities mutations', () => {
    const doc = parse(`
      mutation {
        a: bulkRegisterEntities(input: [{ qualifiedName: "x", kind: CLASS }]) { id }
        b: bulkRegisterEntities(input: [{ qualifiedName: "y", kind: CLASS }]) { id }
      }
    `);
    const cost = calculateOperationCost(doc);
    expect(cost).toBe(BULK_REGISTER_ENTITIES_COST * 2);
  });

  it('multiplies cost for fragment spreads containing expensive mutations', () => {
    const doc = parse(`
      mutation {
        ...BulkRegistration
        ...BulkRegistration
      }
      fragment BulkRegistration on Mutation {
        bulkRegisterEntities(input: [{ qualifiedName: "x", kind: CLASS }]) { id }
      }
    `);
    const cost = calculateOperationCost(doc);
    expect(cost).toBe(BULK_REGISTER_ENTITIES_COST * 2);
  });

  it('multiplies cost for inline fragments containing expensive mutations', () => {
    const doc = parse(`
      mutation {
        ... on Mutation {
          bulkRegisterEntities(input: [{ qualifiedName: "x", kind: CLASS }]) { id }
        }
        ... on Mutation {
          bulkRegisterEntities(input: [{ qualifiedName: "y", kind: CLASS }]) { id }
        }
      }
    `);
    const cost = calculateOperationCost(doc);
    expect(cost).toBe(BULK_REGISTER_ENTITIES_COST * 2);
  });

  it('rejects a four-alias bulkRegisterEntities mutation as exceeding the cost limit', () => {
    const doc = parse(`
      mutation {
        a: bulkRegisterEntities(input: [{ qualifiedName: "w", kind: CLASS }]) { id }
        b: bulkRegisterEntities(input: [{ qualifiedName: "x", kind: CLASS }]) { id }
        c: bulkRegisterEntities(input: [{ qualifiedName: "y", kind: CLASS }]) { id }
        d: bulkRegisterEntities(input: [{ qualifiedName: "z", kind: CLASS }]) { id }
      }
    `);
    const cost = calculateOperationCost(doc);
    expect(cost).toBe(BULK_REGISTER_ENTITIES_COST * 4);
    expect(cost).toBeGreaterThan(DEFAULT_QUERY_COST_LIMIT);
  });
});

describe('GraphQL Yoga server cost enforcement', () => {
  it('serves an authenticated GraphQL query (200 OK) that is within the cost limit', async () => {
    process.env.OPENSWARM_GRAPHQL_TOKEN = 'test-token';
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
      if (!address || typeof address === 'string') throw new Error('no address');
      const response = await fetch(`http://127.0.0.1:${address.port}/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.errors).toBeUndefined();
      expect(body.data).toEqual({ __typename: 'Query' });
    } finally {
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects an aliased bulkRegisterEntities query that exceeds the cost limit via HTTP', async () => {
    process.env.OPENSWARM_GRAPHQL_TOKEN = 'test-token';
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
      if (!address || typeof address === 'string') throw new Error('no address');
      const response = await fetch(`http://127.0.0.1:${address.port}/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          query: `
            mutation {
              a: bulkRegisterEntities(input: [{ qualifiedName: "x", kind: CLASS }]) { id }
              b: bulkRegisterEntities(input: [{ qualifiedName: "y", kind: CLASS }]) { id }
              c: bulkRegisterEntities(input: [{ qualifiedName: "z", kind: CLASS }]) { id }
            }
          `,
        }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toContain('exceeds the maximum allowed cost');
      expect(body.errors[0].extensions.code).toBe('GRAPHQL_COST_LIMIT_EXCEEDED');
    } finally {
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects a query whose aliased fragment spreads multiply an expensive mutation beyond the cost limit via HTTP', async () => {
    process.env.OPENSWARM_GRAPHQL_TOKEN = 'test-token';
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
      if (!address || typeof address === 'string') throw new Error('no address');
      const response = await fetch(`http://127.0.0.1:${address.port}/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          query: `
            mutation {
              ...BulkRegistration
              ...BulkRegistration
            }
            fragment BulkRegistration on Mutation {
              bulkRegisterEntities(input: [{ qualifiedName: "x", kind: CLASS }]) { id }
            }
          `,
        }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toContain('exceeds the maximum allowed cost');
      expect(body.errors[0].extensions.code).toBe('GRAPHQL_COST_LIMIT_EXCEEDED');
    } finally {
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
  });
});
