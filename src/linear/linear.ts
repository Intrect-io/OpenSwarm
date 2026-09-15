// ============================================
// OpenSwarm - Linear Integration
// ============================================

import { LinearClient } from '@linear/sdk';
import type { LinearIssueInfo, LinearProjectInfo } from '../core/types.js';
import { setLinearClient } from './projectUpdater.js';
import { withRateLimit } from '../support/rateLimiter.js';
import { c, status } from '../support/colors.js';
import { safeConsole as console } from '../support/safeLog.js';

export {
  addComment,
  effectCommentId,
  logHalt,
  logWorkStart,
  logProgress,
  logWorkComplete,
  logBlocked,
  STUCK_LABEL,
  addIssueLabel,
  removeIssueLabel,
  logStuck,
  logPairStart,
  logPairReview,
  logPairRevision,
  logPairComplete,
  logPairFailed,
} from './linearComments.js';
export {
  getRemainingDailyIssues,
  getDailyIssueCount,
  lookupIssue,
  getIssue,
  createIssue,
  createSubIssue,
  markAsDecomposed,
  proposeWork,
  getStuckIssues,
} from './linearTasks.js';
export type { IssueLookup } from './linearTasks.js';

/**
 * Extract project info from an issue
 */
export async function getProjectInfo(issue: any): Promise<LinearProjectInfo | undefined> {
  try {
    const project = await issue.project;
    if (!project) return undefined;
    return {
      id: project.id,
      name: project.name,
      icon: project.icon ?? undefined,
      color: project.color ?? undefined,
    };
  } catch {
    return undefined;
  }
}

let client: LinearClient | null = null;
export let teamId: string = '';
export let teamIds: string[] = [];
// OAuth runtime state — when the client was built from a Linear OAuth access
// token, the token expires (~24h) and must be refreshed + the client rebuilt.
let isOAuthMode = false;
let currentToken = '';

/** Build a Linear team filter that works for both single and multiple team IDs */
function teamFilter() {
  if (teamIds.length === 1) {
    return { id: { eq: teamIds[0] } };
  }
  return { id: { in: teamIds } };
}

/**
 * Page size when fetching issues across all configured teams. Linear's
 * default page cap is 50 — 100 is the largest value that consistently
 * returns; bumping to 250 triggered intermittent 502s from the Linear
 * gateway on wider queries.
 *
 * A prior revision tried per-team fan-out to guarantee a per-team quota, but
 * firing ~12 parallel `issues()` calls tripped a 90s timeout inside the
 * Linear SDK / HTTP keepalive path — one wider query is both simpler and
 * actually faster end-to-end.
 */
const FETCH_PAGE_SIZE = 100;

/**
 * Plain issue node from the nested GraphQL query below — project/state/labels are
 * embedded, so reading them needs NO extra per-issue API call. This is the fix
 * for the N+1 that made the bulk fetch time out (INT-1909): the old path resolved
 * `issue.project`/`issue.state`/`issue.labels()` lazily (1 request each) for every
 * issue, so 150+ issues × Linear's ~40/min limit blew the 90s budget.
 */
interface RawIssueNode {
  id: string;
  identifier: string;
  title: string;
  url?: string;
  description?: string | null;
  priority: number;
  createdAt?: string;
  updatedAt?: string;
  state?: { name?: string } | null;
  project?: { id: string; name: string; icon?: string | null; color?: string | null } | null;
  labels?: { nodes: Array<{ name: string }> } | null;
  comments?: { nodes: Array<{ id: string; body: string; createdAt: string }> } | null;
}

const ISSUES_QUERY = `
  query OswIssues($filter: IssueFilter, $first: Int, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        identifier
        title
        url
        description
        priority
        createdAt
        updatedAt
        state { name }
        project { id name icon color }
        labels { nodes { name } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

export const STUCK_ISSUES_QUERY = `
  query OswStuckIssues($filter: IssueFilter, $first: Int, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        identifier
        title
        url
        description
        priority
        updatedAt
        state { name }
        project { id name icon color }
        labels { nodes { name } }
        comments(first: 50) { nodes { id body createdAt } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

export async function fetchIssuesForStates(
  linear: LinearClient,
  stateNames: string[],
  extraFilter: Record<string, unknown> = {},
): Promise<{ nodes: RawIssueNode[] }> {
  const ids = teamIds.length > 0 ? teamIds : (teamId ? [teamId] : []);
  const teamPart = ids.length === 1 ? { id: { eq: ids[0] } } : { id: { in: ids } };
  const filter = {
    ...extraFilter,
    ...(ids.length ? { team: teamPart } : {}),
    state: { name: { in: stateNames } },
  };

  return fetchRawIssues(linear, filter);
}

export async function fetchRawIssues(
  linear: LinearClient,
  filter: Record<string, unknown>,
  query = ISSUES_QUERY,
): Promise<{ nodes: RawIssueNode[] }> {

  // graphql-request client under the SDK — one query returns the nested fields.
  const gql = (linear as unknown as {
    client: { rawRequest: <T>(q: string, v?: Record<string, unknown>) => Promise<{ data: T }> };
  }).client;

  const nodes: RawIssueNode[] = [];
  let after: string | undefined;
  // Hard page cap (10 × 100 = 1000) so a runaway never loops forever.
  let hasNextPage = false;
  for (let page = 0; page < 10; page++) {
    const res = await withRateLimit('linear', () =>
      gql.rawRequest<{ issues: { nodes: RawIssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string } } }>(
        query,
        { filter, first: FETCH_PAGE_SIZE, after },
      ),
    );
    const conn = res?.data?.issues;
    if (!conn) break;
    nodes.push(...conn.nodes);
    hasNextPage = conn.pageInfo?.hasNextPage === true;
    if (!hasNextPage) break;
    if (!conn.pageInfo.endCursor || conn.pageInfo.endCursor === after) {
      throw new Error('Linear issue pagination returned a missing or repeated cursor');
    }
    after = conn.pageInfo.endCursor;
  }
  if (hasNextPage) {
    throw new Error(`Linear issue fetch exceeded the explicit ${10 * FETCH_PAGE_SIZE}-issue safety cap`);
  }
  return { nodes };
}

// Caching Layer

interface CachedIssues {
  data: LinearIssueInfo[];
  timestamp: number;
  agentLabel: string;
}

const inProgressCache = new Map<string, CachedIssues>();
const backlogCache = new Map<string, CachedIssues>();
const myIssuesCache = new Map<string, CachedIssues>();
const CACHE_TTL_MS = 300000; // 5 minute cache (was 1min, reduced API calls)
const MAX_AGENT_CACHE_ENTRIES = 50;

function setBoundedIssueCache(cache: Map<string, CachedIssues>, key: string, value: CachedIssues): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_AGENT_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value!);
  }
}

function isCacheValid(cache: CachedIssues | undefined): boolean {
  if (!cache) return false;
  return Date.now() - cache.timestamp < CACHE_TTL_MS;
}

/**
 * Clear all caches (call when issues are mutated)
 */
export function clearLinearCache(): void {
  inProgressCache.clear();
  backlogCache.clear();
  myIssuesCache.clear();
  console.log(`${status.info('[Linear]')} ${c.dim('cache cleared')}`);
}

/**
 * Initialize the Linear client
 * Rate limiting is applied at the function level in this file
 */
export function initLinear(credential: string, team: string, isOAuth = false): void {
  // OAuth access tokens use the Bearer `accessToken` path; personal API keys use
  // the raw `apiKey` path. (Linear OAuth tokens fail if sent as a raw apiKey.)
  client = new LinearClient(isOAuth ? { accessToken: credential } : { apiKey: credential });
  isOAuthMode = isOAuth;
  currentToken = credential;
  teamId = team;
  teamIds = team.split(',').map(id => id.trim()).filter(Boolean);
  setLinearClient(client);
  console.log(`${status.info('[Linear]')} ${c.dim('client initialized')} ${c.yellow(isOAuth ? 'OAuth' : 'apiKey')}`);
}

/**
 * Keep the Linear OAuth token fresh for a long-running daemon. No-op for API-key
 * mode. Called before each heartbeat fetch: ensureValidToken refreshes the token
 * when it's near expiry, and if it changed we rebuild the client (LinearClient
 * holds the token at construction). Best-effort — failures are logged, not thrown,
 * so a transient refresh error doesn't crash the heartbeat.
 */
export async function ensureLinearAuthFresh(): Promise<void> {
  if (!isOAuthMode || !client) return;
  try {
    const { AuthProfileStore, ensureValidToken } = await import('../auth/index.js');
    const token = await ensureValidToken(new AuthProfileStore(), 'linear:default');
    if (token !== currentToken) {
      client = new LinearClient({ accessToken: token });
      currentToken = token;
      setLinearClient(client);
      console.log(`${status.ok('[Linear] OAuth token refreshed')} ${c.dim('client reinitialized')}`);
    }
  } catch (err) { // cxt-ignore: error_swallow,exception_hiding — best-effort; logged, must not crash the heartbeat
    console.error(`[Linear] OAuth refresh failed: ${(err as Error).message}`);
  }
}

/**
 * Check if Linear client is initialized
 */
export function isLinearInitialized(): boolean {
  return client !== null;
}

/**
 * Return the Linear client instance
 */
export function getClient(): LinearClient {
  if (!client) {
    throw new Error('Linear client not initialized. Call initLinear() first.');
  }
  return client;
}

/** Linear team summary for the `openswarm init` picker. */
export interface LinearTeamInfo {
  id: string;
  key: string;
  name: string;
}

/** Credential for one-off Linear calls before initLinear() (init picker). */
export interface LinearCredential {
  apiKey?: string;
  /** OAuth access token (Bearer) — takes precedence over apiKey. */
  accessToken?: string;
}

function linearClientFor(cred?: LinearCredential): LinearClient {
  if (cred?.accessToken) return new LinearClient({ accessToken: cred.accessToken });
  if (cred?.apiKey) return new LinearClient({ apiKey: cred.apiKey });
  return getClient();
}

/**
 * List all Linear teams the credential can see — for the `openswarm init` picker.
 * Accepts an explicit credential (apiKey or OAuth accessToken) so init can call
 * it before initLinear() runs; falls back to the initialized client.
 */
export async function listTeams(cred?: LinearCredential): Promise<LinearTeamInfo[]> {
  const c = linearClientFor(cred);
  const res: any = await withRateLimit('linear', () => c.teams({ first: 250 })); // cxt-ignore: type_safety — SDK TeamConnection
  return (await drainLinearConnection(res)).map((t: any) => ({ id: t.id, key: t.key, name: t.name }));
}

/** Soft page guard for SDK connection drains (teams/projects pickers). */
const DRAIN_PAGE_GUARD = 40;

/**
 * Hard caps for direct active/backlog SDK list paths. These paths still do
 * per-issue enrichment, so both page count and aggregate enrichment work must
 * be bounded (unlike the nested GraphQL fetchIssuesForStates path).
 */
export const LINEAR_ACTIVE_PAGE_SIZE = 50;
export const LINEAR_ACTIVE_MAX_PAGES = 4;
export const LINEAR_ACTIVE_ENRICH_CAP = LINEAR_ACTIVE_PAGE_SIZE * LINEAR_ACTIVE_MAX_PAGES;
export const LINEAR_BACKLOG_PAGE_SIZE = 10;
/**
 * Page cap for the backlog pick. Ranking must see the WHOLE eligible set —
 * the globally highest-priority issue can sit pages deep while page one holds
 * only fillers — so we drain bounded pages before ranking (AGT-3421).
 */
export const LINEAR_BACKLOG_MAX_PAGES = 20;
/** Candidate window for the backlog pick: page size × page cap. */
export const LINEAR_BACKLOG_MAX_CANDIDATES = LINEAR_BACKLOG_PAGE_SIZE * LINEAR_BACKLOG_MAX_PAGES;
export const LINEAR_RELATED_PAGE_SIZE = 50;

/**
 * Follow a Linear SDK connection to its last page and return every node.
 * The SDK's fetchNext() appends each fetched page onto the same connection,
 * so a single `first: N` read silently truncates larger workspaces. The page
 * guard only bounds a misbehaving pagination cursor, not real data.
 */
export async function drainLinearConnection(
  connection: any, // cxt-ignore: type_safety — SDK connection
  maxPages = DRAIN_PAGE_GUARD,
): Promise<any[]> {
  let conn: any = connection;
  // `maxPages` counts the page already present on the connection.
  let pages = 1;
  // A page whose endCursor is absent or identical to the previous one means the
  // API re-served the same page — bail explicitly instead of looping (or
  // duplicating nodes) until the page guard trips. (AGT-3421)
  let lastCursor: string | undefined = conn?.pageInfo?.endCursor ?? undefined;
  const pageCap = Math.max(1, Math.min(DRAIN_PAGE_GUARD, Math.trunc(maxPages) || DRAIN_PAGE_GUARD));
  while (conn?.pageInfo?.hasNextPage && typeof conn.fetchNext === 'function' && pages < pageCap) {
    conn = await withRateLimit('linear', () => conn.fetchNext());
    pages += 1;
    const cursor = conn?.pageInfo?.endCursor;
    if (!cursor || cursor === lastCursor) {
      throw new Error(
        `Linear pagination returned a ${cursor ? 'repeated' : 'missing'} cursor after ${pages - 1} fetched page(s)`,
      );
    }
    lastCursor = cursor;
  }
  return conn?.nodes ?? [];
}

/**
 * List projects within a team — for the `openswarm init` picker. Accepts an
 * explicit credential (apiKey or OAuth accessToken).
 */
export async function listProjects(teamId: string, cred?: LinearCredential): Promise<LinearProjectInfo[]> {
  const c = linearClientFor(cred);
  const team: any = await withRateLimit('linear', () => c.team(teamId)); // cxt-ignore: type_safety — SDK Team
  const res: any = await withRateLimit('linear', () => team.projects({ first: 250 }));
  return (await drainLinearConnection(res)).map((p: any) => ({
    id: p.id,
    name: p.name,
    icon: p.icon ?? undefined,
    color: p.color ?? undefined,
  }));
}

/**
 * Get in-progress issues for an agent (with caching)
 */
export async function getInProgressIssues(
  agentLabel: string
): Promise<LinearIssueInfo[]> {
  if (!isLinearInitialized()) return [];
  // Check cache first
  const cached = inProgressCache.get(agentLabel);
  if (cached && isCacheValid(cached)) {
    console.log(`[Linear] Using cached in-progress issues for ${agentLabel}`);
    return cached.data;
  }

  console.log(`[Linear] Fetching in-progress issues for ${agentLabel}`);
  const linear = getClient();

  const issues = await withRateLimit('linear', async () => linear.issues({
    filter: {
      team: teamFilter(),
      state: { name: { in: ['In Progress', 'Started'] } },
      labels: { name: { eq: agentLabel } },
    },
    first: LINEAR_ACTIVE_PAGE_SIZE,
  }));

  const nodes = (await drainLinearConnection(issues, LINEAR_ACTIVE_MAX_PAGES))
    .slice(0, LINEAR_ACTIVE_ENRICH_CAP);
  const result: LinearIssueInfo[] = [];

  // Batch fetch related data — capped so enrichment work cannot grow without bound.
  for (const issue of nodes) {
    const [comments, labels, state, project] = await Promise.all([
      issue.comments({ first: LINEAR_RELATED_PAGE_SIZE }),
      issue.labels({ first: LINEAR_RELATED_PAGE_SIZE }),
      issue.state,
      getProjectInfo(issue),
    ]);

    result.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      description: issue.description ?? undefined,
      state: state?.name ?? 'Unknown',
      priority: issue.priority,
      labels: labels.nodes.map((l: { name: string }) => l.name),
      comments: comments.nodes.map((c: { id: string; body: string; createdAt: Date }) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        user: undefined, // TODO: resolve user name
      })),
      project,
    });
  }

  // Cache the result
  setBoundedIssueCache(inProgressCache, agentLabel, {
    data: result,
    timestamp: Date.now(),
    agentLabel,
  });

  return result;
}

/**
 * Get the next issue from the backlog (with caching)
 */
export async function getNextBacklogIssue(
  agentLabel: string
): Promise<LinearIssueInfo | null> {
  if (!isLinearInitialized()) return null;
  // Check cache first
  const cached = backlogCache.get(agentLabel);
  if (cached && isCacheValid(cached) && cached.data.length > 0) {
    console.log(`[Linear] Using cached backlog issue for ${agentLabel}`);
    return cached.data[0];
  }

  console.log(`[Linear] Fetching backlog issues for ${agentLabel}`);
  const linear = getClient();

  const issues = await withRateLimit('linear', async () => linear.issues({
    filter: {
      team: teamFilter(),
      state: { name: { in: ['Backlog', 'Todo'] } },
      labels: { name: { eq: agentLabel } },
    },
    first: LINEAR_BACKLOG_PAGE_SIZE, // page size — the pick ranks over every drained page
  }));

  // Rank over ALL pages (bounded): the first page alone can hold only low
  // priority fillers while the true next issue sits pages deep.
  const candidates = (await drainLinearConnection(issues, LINEAR_BACKLOG_MAX_PAGES))
    .slice(0, LINEAR_BACKLOG_MAX_CANDIDATES);

  // Sort by priority (lower = higher priority: 1=Urgent, 4=Low, 0=None)
  const sorted = [...candidates].sort((a, b) => {
    // Push priority 0 (None) to the end
    const pa = a.priority === 0 ? 999 : a.priority;
    const pb = b.priority === 0 ? 999 : b.priority;
    return pa - pb;
  });

  const issue = sorted[0];
  if (!issue) return null;

  const [comments, labels, state, project] = await Promise.all([
    issue.comments({ first: LINEAR_RELATED_PAGE_SIZE }),
    issue.labels({ first: LINEAR_RELATED_PAGE_SIZE }),
    issue.state,
    getProjectInfo(issue),
  ]);

  const result = {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    description: issue.description ?? undefined,
    state: state?.name ?? 'Unknown',
    priority: issue.priority,
    labels: labels.nodes.map((l: { name: string }) => l.name),
    comments: comments.nodes.map((c: { id: string; body: string; createdAt: Date }) => ({
      id: c.id,
      body: c.body,
      createdAt: c.createdAt.toISOString(),
      user: undefined,
    })),
    project,
  };

  // Cache the result
  setBoundedIssueCache(backlogCache, agentLabel, {
    data: [result],
    timestamp: Date.now(),
    agentLabel,
  });

  return result;
}

/**
 * Options for getMyIssues
 */
export interface GetMyIssuesOptions {
  agentLabel?: string;
  /**
   * Slim mode: skip N+1 queries for comments/labels/project.
   * Returns only core fields (id, identifier, title, description, priority, state, project).
   * Use for heartbeat/decision engine where full details aren't needed.
   */
  slim?: boolean;
  /** Timeout in ms (default: 30000) */
  timeoutMs?: number;
}

/**
 * Parse blocker issue identifiers from a description's prose. The KYTE team
 * writes dependencies as text ("블로커: KT-305/306/307", "Blocked by: KT-302, KT-307")
 * rather than structured Linear relations, so this is the high-value path.
 * Returns raw identifiers (e.g. "KT-305"); the caller resolves them to UUIDs.
 *
 * Handles Korean ("블로커"/"의존성") and English ("Blocked by"/"Blocker"/"Depends on")
 * labels; comma / slash separators; and bare numbers that inherit the preceding
 * team prefix ("KT-305/306" → KT-305, KT-306). Over-capture is safe: identifiers
 * that don't resolve to a fetched issue are dropped during UUID resolution.
 */
export function parseBlockerIdentifiers(description?: string): string[] {
  if (!description) return [];
  const ids: string[] = [];
  // Match a blocker label, then capture the rest of that line.
  const lineRe = /(?:블로커|의존성?|blocked\s*by|blocker|depends\s*on)\s*[:：]?\s*\*{0,2}\s*([^\n\r]+)/gi;
  let line: RegExpExecArray | null;
  while ((line = lineRe.exec(description)) !== null) {
    const segment = line[1];
    let lastPrefix: string | null = null;
    // A full identifier (TEAM-123) or a bare number reusing the last seen prefix.
    const tokenRe = /([A-Z]{2,})-(\d+)|(\d+)/g;
    let tok: RegExpExecArray | null;
    while ((tok = tokenRe.exec(segment)) !== null) {
      if (tok[1] && tok[2]) {
        lastPrefix = tok[1];
        ids.push(`${tok[1]}-${tok[2]}`);
      } else if (tok[3] && lastPrefix) {
        ids.push(`${lastPrefix}-${tok[3]}`);
      }
    }
  }
  return [...new Set(ids)];
}

/**
 * Populate `blockedBy` (issue UUIDs) on each fetched issue from two sources:
 *  1. Structured Linear relations — `inverseRelations()` of type "blocks" (the
 *     relation's source `issue` is the blocker).
 *  2. Description prose parsed by {@link parseBlockerIdentifiers}.
 *
 * Only blockers that are themselves in the current fetch set are kept. We never
 * query Done issues, so a completed blocker drops out of the set and won't
 * false-block its dependents; getTaskReadiness then gates on what remains.
 */
async function populateBlockedBy(
  result: LinearIssueInfo[],
  // SDK Issue nodes keyed by id (carry inverseRelations()); typed loosely to
  // match the file's existing lazy-resolver usage.
  sdkNodeById: Map<string, any>,
): Promise<void> {
  const fetchedIds = new Set(result.map((r) => r.id));
  const identifierToId = new Map(result.map((r) => [r.identifier.toUpperCase(), r.id]));

  // Text-only blocker resolution — NO per-issue API calls. The structured
  // `inverseRelations()` source was removed: it cost one API request per issue,
  // which (at Linear's ~40/min limit) pushed the bulk fetch past its timeout and
  // stalled the whole pipeline. Description prose ("Blocked by: KT-302") covers
  // the common case for free; structured-relation enrichment can return as a
  // batched GraphQL query later if needed.
  void sdkNodeById;
  for (const info of result) {
    const blockers = new Set<string>();
    for (const ident of parseBlockerIdentifiers(info.description)) {
      const id = identifierToId.get(ident.toUpperCase());
      if (id) blockers.add(id);
    }
    // Keep only blockers still in the fetch set (excludes Done/out-of-scope →
    // avoids false-blocking); never self-reference.
    const filtered = [...blockers].filter((id) => id !== info.id && fetchedIds.has(id));
    if (filtered.length > 0) info.blockedBy = filtered;
  }
}

/**
 * Get assigned active issues (with caching)
 * (Todo, In Progress, Review states - excludes Backlog)
 */
export async function getMyIssues(
  agentLabelOrOptions?: string | GetMyIssuesOptions
): Promise<LinearIssueInfo[]> {
  if (!isLinearInitialized()) return [];
  const opts: GetMyIssuesOptions = typeof agentLabelOrOptions === 'string'
    ? { agentLabel: agentLabelOrOptions }
    : agentLabelOrOptions ?? {};

  const { agentLabel, slim = false, timeoutMs = 30000 } = opts;

  // Generate cache key
  const cacheKey = `${agentLabel || 'all'}:${slim}`;

  // Check cache first
  const cached = myIssuesCache.get(cacheKey);
  if (cached && isCacheValid(cached)) {
    console.log(`[Linear] Using cached issues for ${cacheKey}`);
    return cached.data;
  }

  console.log(`[Linear] Fetching issues for ${cacheKey}`);
  const requestController = new AbortController();
  const linear = new LinearClient(isOAuthMode
    ? { accessToken: currentToken, signal: requestController.signal }
    : { apiKey: currentToken, signal: requestController.signal });

  // Wrap with timeout
  const fetchIssues = async (): Promise<LinearIssueInfo[]> => {
    // Slim mode: query each state separately to avoid lazy resolver calls for issue.state
    // Full mode: combined query then resolve per-issue
    const result: LinearIssueInfo[] = [];

    const extraFilter: Record<string, unknown> = {};
    if (agentLabel) extraFilter.labels = { name: { eq: agentLabel } };

    if (slim) {
      // Separate queries per state → tag each issue without resolver calls.
      const [todoIssues, inProgressIssues, backlogIssues] = await Promise.all([
        fetchIssuesForStates(linear, ['Todo'], extraFilter),
        fetchIssuesForStates(linear, ['In Progress', 'In Review'], extraFilter),
        fetchIssuesForStates(linear, ['Backlog'], extraFilter),
      ]);

      const withState = [
        ...todoIssues.nodes.map(i => ({ issue: i, state: 'Todo' })),
        ...inProgressIssues.nodes.map(i => ({ issue: i, state: i.state?.name ?? 'Unknown' })),
        ...backlogIssues.nodes.map(i => ({ issue: i, state: 'Backlog' })),
      ];

      // project is embedded in each node (nested GraphQL) — no per-issue resolver call.
      for (const { issue, state } of withState) {
        const p = issue.project;
        result.push({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          url: issue.url,
          description: issue.description ?? undefined,
          state,
          priority: issue.priority,
          labels: issue.labels?.nodes?.map((l) => l.name) ?? [],
          comments: [],
          project: p ? { id: p.id, name: p.name, icon: p.icon ?? undefined, color: p.color ?? undefined } : undefined,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
        } as LinearIssueInfo);
      }

      await populateBlockedBy(result, new Map(withState.map(({ issue }) => [issue.id, issue])));
      return result;
    }

    // Full mode: fetch executable + backlog, then resolve per-issue
    const [executableIssues, backlogIssues] = await Promise.all([
      fetchIssuesForStates(linear, ['Todo', 'In Progress', 'In Review'], extraFilter),
      fetchIssuesForStates(linear, ['Backlog'], extraFilter),
    ]);

    {
      // project/state/labels are embedded in each node (nested GraphQL) — no
      // per-issue resolver calls. comments are no longer bulk-fetched (the only
      // consumer, task-state hydration, is also persisted locally); fetch lazily
      // per issue if a caller ever needs them.
      const allNodes = [...executableIssues.nodes, ...backlogIssues.nodes];
      for (const issue of allNodes) {
        const p = issue.project;
        result.push({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          url: issue.url,
          description: issue.description ?? undefined,
          state: issue.state?.name ?? 'Unknown',
          priority: issue.priority,
          labels: issue.labels?.nodes?.map((l) => l.name) ?? [],
          comments: [],
          project: p ? { id: p.id, name: p.name, icon: p.icon ?? undefined, color: p.color ?? undefined } : undefined,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
        });
      }

      await populateBlockedBy(result, new Map(allNodes.map((n) => [n.id, n])));
    }

    // Sort by priority
    return result.sort((a, b) => {
      const pa = a.priority === 0 ? 999 : a.priority;
      const pb = b.priority === 0 ? 999 : b.priority;
      return pa - pb;
    });
  };

  // Apply timeout to the SDK transport itself so paginated requests do not
  // continue consuming sockets and rate-limit budget after the caller gives up.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let result: LinearIssueInfo[];
  try {
    timeoutId = setTimeout(() => requestController.abort(), timeoutMs);
    result = await fetchIssues();
  } catch (error) {
    if (requestController.signal.aborted) throw new Error(`getMyIssues timed out after ${timeoutMs}ms`, { cause: error });
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    requestController.abort();
  }

  // Cache the result
  setBoundedIssueCache(myIssuesCache, cacheKey, {
    data: result,
    timestamp: Date.now(),
    agentLabel: agentLabel || 'all',
  });

  return result;
}

/**
 * Update issue state
 */
export async function updateIssueState(
  issueId: string,
  stateName: 'In Progress' | 'In Review' | 'Done' | 'Backlog' | 'Todo',
  retries = 2
): Promise<boolean> {
  if (!isLinearInitialized()) return false;
  const linear = getClient();

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Fetch the issue to get its actual team ID (avoids cross-team state mismatch)
      const issue = await linear.issue(issueId);
      const issueTeam = await issue.team;
      const resolvedTeamId = issueTeam?.id ?? teamIds[0] ?? teamId;

      // Get team workflow states
      const team = await linear.team(resolvedTeamId);
      const states = await team.states();
      const targetState = states.nodes.find((s) =>
        s.name.toLowerCase().includes(stateName.toLowerCase())
      );

      if (!targetState) {
        console.error(`[Linear] State "${stateName}" not found in team workflow`);
        return false;
      }

      await linear.updateIssue(issueId, {
        stateId: targetState.id,
      });

      // Clear cache after mutation
      clearLinearCache();

      console.log(`[Linear] Issue ${issueId} state changed to ${stateName}`);
      return true;
    } catch (error) {
      console.error(`[Linear] Failed to update issue state (attempt ${attempt + 1}/${retries + 1}):`, error);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  console.error(`[Linear] All ${retries + 1} attempts to update issue ${issueId} to "${stateName}" failed`);
  return false;
}

export async function updateIssueDescription(issueId: string, description: string): Promise<void> {
  if (!isLinearInitialized()) return;
  const linear = getClient();
  await linear.updateIssue(issueId, { description });
  clearLinearCache();
  console.log(`[Linear] Issue ${issueId} description updated`);
}

/** Create Linear's native duplicate relation; Linear moves the duplicate to its configured canceled state. */
export async function markIssueDuplicate(issueId: string, canonicalIssueId: string): Promise<boolean> {
  if (!isLinearInitialized() || issueId === canonicalIssueId) return false;
  try {
    const payload = await getClient().createIssueRelation({
      issueId,
      relatedIssueId: canonicalIssueId,
      type: 'duplicate' as Parameters<LinearClient['createIssueRelation']>[0]['type'],
    });
    clearLinearCache();
    console.log(`[Linear] Issue ${issueId} marked duplicate of ${canonicalIssueId}`);
    return payload.success;
  } catch (error) {
    console.error(`[Linear] Failed to mark ${issueId} duplicate of ${canonicalIssueId}:`, error);
    return false;
  }
}

/** Existing sub-issues of a parent, for deterministic decomposition dedup (AGT-2908). */
export async function getIssueChildren(
  issueId: string,
): Promise<Array<{ id: string; identifier: string; title: string; description: string }>> {
  if (!isLinearInitialized()) return [];
  try {
    const linear = getClient();
    const parent = await linear.issue(issueId);
    const children = await parent.children();
    return children.nodes.map((child) => ({
      id: child.id,
      identifier: child.identifier,
      title: child.title,
      description: child.description ?? '',
    }));
  } catch (error) {
    console.error(`[Linear] Failed to fetch children of ${issueId}:`, error);
    return [];
  }
}

