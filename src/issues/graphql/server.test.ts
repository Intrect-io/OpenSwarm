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
    expect(isGraphQLTransportAuthorized(request('10.0.0.2', { 'x-openswarm-graphql-token': 'secret' }))).toBe(true);
    expect(isGraphQLTransportAuthorized(request('10.0.0.2', { authorization: 'Bearer wrong' })))
      .toBe(false);
  });

  it('rejects a request with a mismatched token length', () => {
    process.env.OPENSWARM_GRAPHQL_TOKEN = 'secret';
    expect(isGraphQLTransportAuthorized(request('10.0.0.2', { authorization: 'Bearer secrets' }))).toBe(false);
  });

  it('rejects a request with a malformed authorization header', () => {
    process.env.OPENSWARM_GRAPHQL_TOKEN = 'secret';
    expect(isGraphQLTransportAuthorized(request('10.0.0.2', { authorization: 'Basic secret' }))).toBe(false);
    expect(isGraphQLTransportAuthorized(request('10.0.0.2', { authorization: '' }))).toBe(false);
  });

  it('rejects a request with no token configured', () => {
    expect(isGraphQLTransportAuthorized(request('10.0.0.2', { authorization: 'Bearer secret' }))).toBe(false);
  });
});

describe('calculateOperationCost', () => {
  it('returns 1 for a simple query', () => {
    const doc = parse('{ __typename }');
    expect(calculateOperationCost(doc)).toBe(1);
  });

  it('returns the base cost for a single bulkRegisterEntities mutation', () => {
    const doc = parse('mutation { bulkRegisterEntities(input: [{ qualifiedName: "test", kind: CLASS }]) { id } }');
    expect(calculateOperationCost(doc)).toBe(BULK_REGISTER_ENTITIES_COST);
  });

  it('multiplies cost for aliased bulkRegisterEntities mutations', () => {
    const doc = parse(`
      mutation {
        a: bulkRegisterEntities(input: [{ qualifiedName: "x", kind: CLASS }]) { id }
        b: bulkRegisterEntities(input: [{ qualifiedName: "y", kind: CLASS }]) { id }
        c: bulkRegisterEntities(input: [{ qualifiedName: "z", kind: CLASS }]) { id }
      }
    `);
    // 3 aliases × 500 = 1500
    expect(calculateOperationCost(doc)).toBe(BULK_REGISTER_ENTITIES_COST * 3);
  });

  it('rejects a query whose aliased fragment spreads exceed the configured cost limit', () => {
    // 4 aliases × 500 = 2000 > DEFAULT_QUERY_COST_LIMIT (500)
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

  it('multiplies cost for fragment spreads containing expensive mutations', () => {
    const doc = parse(`
      fragment BulkPart on Mutation {
        bulkRegisterEntities(input: [{ qualifiedName: "x", kind: CLASS }]) { id }
      }
      mutation {
        ...BulkPart
        ...BulkPart
        ...BulkPart
      }
    `);
    // 3 fragment spreads × 500 = 1500
    expect(calculateOperationCost(doc)).toBe(BULK_REGISTER_ENTITIES_COST * 3);
  });

  it('rejects a query with aliased fragment spreads exceeding the cost limit', () => {
    // 4 fragment spreads × 500 = 2000 > 500
    const doc = parse(`
      fragment BulkPart on Mutation {
        bulkRegisterEntities(input: [{ qualifiedName: "x", kind: CLASS }]) { id }
      }
      mutation {
        ...BulkPart
        ...BulkPart
        ...BulkPart
        ...BulkPart
      }
    `);
    const cost = calculateOperationCost(doc);
    expect(cost).toBe(BULK_REGISTER_ENTITIES_COST * 4);
    expect(cost).toBeGreaterThan(DEFAULT_QUERY_COST_LIMIT);
  });
});

describe('GraphQL Yoga server cost enforcement', () => {
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
      await new Promise<void>((resolve, reject) => {
        httpServer.listen(0, '127.0.0.1', () => resolve());
        httpServer.on('error', reject);
      });
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('missing test server address');
      // 4 aliases × 500 = 2000 > default limit 500
      const response = await fetch(`http://127.0.0.1:${address.port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({
          query: `
            mutation {
              a: bulkRegisterEntities(input: [{ qualifiedName: "w", kind: CLASS }]) { id }
              b: bulkRegisterEntities(input: [{ qualifiedName: "x", kind: CLASS }]) { id }
              c: bulkRegisterEntities(input: [{ qualifiedName: "y", kind: CLASS }]) { id }
              d: bulkRegisterEntities(input: [{ qualifiedName: "z", kind: CLASS }]) { id }
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