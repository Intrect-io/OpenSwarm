import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import {
  createGraphQLCostRule,
  handleGraphQL,
  isGraphQLRequest,
  isGraphQLTransportAuthorized,
} from './server.js';
import { validate, buildSchema, parse } from 'graphql';

function request(address: string | undefined, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress: address }, headers } as unknown as IncomingMessage;
}

afterEach(() => { delete process.env.OPENSWARM_GRAPHQL_TOKEN; });

describe('isGraphQLRequest exact endpoint matching', () => {
  it('accepts only the exact /graphql path (with or without query/hash)', () => {
    expect(isGraphQLRequest('/graphql')).toBe(true);
    expect(isGraphQLRequest('/graphql?query={__typename}')).toBe(true);
    expect(isGraphQLRequest('/graphql#section')).toBe(true);
  });

  it('rejects path-prefix lookalikes that previously matched startsWith', () => {
    expect(isGraphQLRequest('/graphql/')).toBe(false);
    expect(isGraphQLRequest('/graphql/admin')).toBe(false);
    expect(isGraphQLRequest('/graphqlfoo')).toBe(false);
    expect(isGraphQLRequest('/api/graphql')).toBe(false);
    expect(isGraphQLRequest(undefined)).toBe(false);
    expect(isGraphQLRequest('')).toBe(false);
  });
});

describe('GraphQL query cost limits', () => {
  const schema = buildSchema(`
    type Query {
      a: Query
      b: String
    }
  `);

  it('rejects a document that exceeds max depth', () => {
    const query = '{ a { a { a { a { b } } } } }';
    const errors = validate(schema, parse(query), [createGraphQLCostRule({ maxDepth: 3 })]);
    expect(errors.some((e) => /maximum depth/i.test(e.message))).toBe(true);
  });

  it('rejects a document that exceeds field or alias counts', () => {
    const query = '{ x: b y: b z: b }';
    const errors = validate(schema, parse(query), [
      createGraphQLCostRule({ maxFieldCount: 2, maxAliasCount: 2, maxCost: 100 }),
    ]);
    expect(errors.some((e) => /maximum (field|alias) count/i.test(e.message))).toBe(true);
  });

  it('rejects a document that exceeds weighted execution cost', () => {
    // cost accumulates as Σ depth at each field enter — a wide shallow fan-out
    // of depth-1 fields exceeds a tight budget without tripping depth/alias caps.
    const query = '{ a1: b a2: b a3: b a4: b }';
    const errors = validate(schema, parse(query), [
      createGraphQLCostRule({ maxDepth: 10, maxFieldCount: 20, maxAliasCount: 20, maxCost: 3 }),
    ]);
    expect(errors.some((e) => /maximum execution cost/i.test(e.message))).toBe(true);
  });

  it('allows a shallow bounded query', () => {
    const errors = validate(schema, parse('{ b }'), [createGraphQLCostRule()]);
    expect(errors).toEqual([]);
  });
});

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

  it('parses a tab-padded bearer header in linear time (js/polynomial-redos)', () => {
    process.env.OPENSWARM_GRAPHQL_TOKEN = 'secret';
    // The old /^Bearer\s+(.+)$/i backtracked polynomially on this shape.
    const attack = `Bearer${'\t'.repeat(50_000)}`;

    const started = process.hrtime.bigint();
    expect(isGraphQLTransportAuthorized(request('100.64.1.2', { authorization: attack }))).toBe(false);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(elapsedMs).toBeLessThan(250);
  });

  it('serves an authenticated GraphQL query through the Node HTTP adapter', async () => {
    process.env.OPENSWARM_GRAPHQL_TOKEN = 'secret';
    const httpServer = createServer((req, res) => { void handleGraphQL(req, res); });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    try {
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
});
