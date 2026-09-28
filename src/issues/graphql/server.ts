// ============================================
// OpenSwarm - Issue Tracker GraphQL Server
// Created: 2026-04-03
// Purpose: graphql-yoga 서버, 기존 HTTP 서버에 통합
// ============================================

import { createSchema, createYoga, type Plugin } from 'graphql-yoga';
import {
  GraphQLError,
  type ASTVisitor,
  type ValidationContext,
  type ValidationRule,
} from 'graphql';
import type { OnValidateEventPayload } from '@envelop/types';
import { typeDefs } from './typeDefs.js';
import { resolvers } from './resolvers.js';
import { registryTypeDefs } from '../../registry/graphql/typeDefs.js';
import { registryResolvers } from '../../registry/graphql/resolvers.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { useQueryCostAnalysis } from './costAnalysis.js';

const CORS_METHODS = 'GET, POST, OPTIONS';
const CORS_HEADERS = 'Content-Type, Authorization, X-OpenSwarm-GraphQL-Token';

/** Depth / fan-out / alias / weighted-cost caps for untrusted GraphQL documents. */
export const GRAPHQL_MAX_DEPTH = 12;
export const GRAPHQL_MAX_FIELD_COUNT = 120;
export const GRAPHQL_MAX_ALIAS_COUNT = 40;
export const GRAPHQL_MAX_COST = 250;

function isAllowedOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  const { protocol, hostname } = url;
  if (protocol !== 'http:' && protocol !== 'https:') return false;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  if (hostname === 'tauri.localhost') return true;

  const tailscaleMatch = hostname.match(/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!tailscaleMatch) return false;

  const second = Number(tailscaleMatch[1]);
  return second >= 64 && second <= 127;
}

function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;

  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', CORS_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  }

  if (req.method !== 'OPTIONS') return false;

  res.writeHead(isAllowedOrigin(origin) ? 204 : 403);
  res.end();
  return true;
}

function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Pull the credentials out of an `Authorization: Bearer <token>` header.
 *
 * Parsed by hand rather than with `/^Bearer\s+(.+)$/i`: there the `\s+` and
 * `(.+)` overlap, so an attacker-supplied `Bearer` header padded with tabs
 * backtracks polynomially (CodeQL js/polynomial-redos). Slicing and trimming
 * is linear in the header length.
 */
const BEARER_SCHEME = 'bearer';

function parseBearerToken(auth: string): string | undefined {
  if (auth.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME) return undefined;
  const rest = auth.slice(BEARER_SCHEME.length);
  // RFC 7235: at least one space separates the scheme from the credentials.
  if (rest === '' || !/\s/.test(rest[0])) return undefined;
  return rest.trim() || undefined;
}

function hasValidToken(headers: { authorization?: string; token?: string }): boolean {
  const token = process.env.OPENSWARM_GRAPHQL_TOKEN?.trim();
  if (!token) return false;
  const bearer = parseBearerToken(headers.authorization ?? '');
  return tokenMatches(bearer, token) || tokenMatches(headers.token?.trim(), token);
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address?.startsWith('::ffff:127.') === true;
}

export function isGraphQLTransportAuthorized(req: IncomingMessage): boolean {
  if (isLoopbackAddress(req.socket?.remoteAddress)) return true;
  const authorization = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  const tokenHeader = req.headers['x-openswarm-graphql-token'];
  const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
  return hasValidToken({ authorization, token });
}

/**
 * Reject documents that nest, fan out, or alias themselves into an unbounded
 * execution cost before any resolver runs. Complements the mutation-priced
 * check in costAnalysis: that one multiplies alias/fragment spreads of known
 * expensive mutations, this one caps the shape itself (depth, field count,
 * alias count, depth-weighted cost) so an unknown-but-deep document fails too.
 */
export function createGraphQLCostRule(limits: {
  maxDepth?: number;
  maxFieldCount?: number;
  maxAliasCount?: number;
  maxCost?: number;
} = {}): ValidationRule {
  const maxDepth = limits.maxDepth ?? GRAPHQL_MAX_DEPTH;
  const maxFieldCount = limits.maxFieldCount ?? GRAPHQL_MAX_FIELD_COUNT;
  const maxAliasCount = limits.maxAliasCount ?? GRAPHQL_MAX_ALIAS_COUNT;
  const maxCost = limits.maxCost ?? GRAPHQL_MAX_COST;

  return function GraphQLCostRule(context: ValidationContext): ASTVisitor {
    let depth = 0;
    let fieldCount = 0;
    let aliasCount = 0;
    let cost = 0;

    return {
      Field: {
        enter(node) {
          depth += 1;
          fieldCount += 1;
          if (node.alias) aliasCount += 1;
          // Deeper fields cost more so nested selection sets hit the budget first.
          cost += depth;

          if (depth > maxDepth) {
            context.reportError(new GraphQLError(`Query exceeds maximum depth of ${maxDepth}`, { nodes: [node] }));
          }
          if (fieldCount > maxFieldCount) {
            context.reportError(new GraphQLError(`Query exceeds maximum field count of ${maxFieldCount}`, { nodes: [node] }));
          }
          if (aliasCount > maxAliasCount) {
            context.reportError(new GraphQLError(`Query exceeds maximum alias count of ${maxAliasCount}`, { nodes: [node] }));
          }
          if (cost > maxCost) {
            context.reportError(new GraphQLError(`Query exceeds maximum execution cost of ${maxCost}`, { nodes: [node] }));
          }
        },
        leave() {
          depth -= 1;
        },
      },
      // Fragment fields are counted when the fragment definition itself is walked.
      FragmentDefinition: {
        enter() {
          depth = 0;
        },
      },
    };
  };
}

/**
 * Yoga plugin that installs the shape caps on every validated document. Typed
 * against Yoga's own Plugin so the `onValidate` payload stays checked: the
 * `addValidationRule` argument is `any` upstream, and an untyped destructure
 * would let a rename in the hook payload pass silently.
 */
const costRulePlugin: Plugin = {
  onValidate({ addValidationRule }: OnValidateEventPayload<Record<string, unknown>>) {
    addValidationRule(createGraphQLCostRule());
  },
};

// GraphQL Yoga 인스턴스 생성 (이슈 + 코드 레지스트리 스키마 머지)
const yoga = createYoga({
  schema: createSchema({
    typeDefs: [typeDefs, registryTypeDefs],
    resolvers: [resolvers, registryResolvers],
  }),
  plugins: [
    useQueryCostAnalysis(),
    costRulePlugin,
  ],
  graphqlEndpoint: '/graphql',
  cors: false,
  logging: {
    debug: () => {},
    info: (...args: any[]) => console.log('[GraphQL]', ...args),
    warn: (...args: any[]) => console.warn('[GraphQL]', ...args),
    error: (...args: any[]) => console.error('[GraphQL]', ...args),
  },
});

/**
 * 기존 웹서버의 요청 핸들러에서 /graphql 경로를 이 함수로 위임
 * graphql-yoga의 Node.js HTTP adapter 패턴 사용
 */
export async function handleGraphQL(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (applyCors(req, res)) return;
  if (!isGraphQLTransportAuthorized(req)) {
    // Same marker the REST gate sets: this 403 is about the credential, not
    // about what was asked for. (AGT-4280)
    res.writeHead(403, { 'Content-Type': 'application/json', 'X-OpenSwarm-Auth': 'token-required' });
    res.end(JSON.stringify({ errors: [{ message: 'Unauthorized GraphQL request' }] }));
    return;
  }

  // graphql-yoga는 Node.js HTTP 서버에서 req, res를 직접 처리
  // handle() 호출 시 내부적으로 res에 응답을 작성
  await yoga.requestListener(req, res);
}

/**
 * Exact GraphQL endpoint match — path-prefix forms like `/graphql/admin` or
 * `/graphqlfoo` must not reach the Yoga handler.
 */
export function isGraphQLRequest(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split(/[?#]/, 1)[0] ?? '';
  return path === '/graphql';
}

export { yoga };
