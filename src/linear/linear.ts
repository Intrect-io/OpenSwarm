// ============================================
// OpenSwarm - Linear Integration
// ============================================

import { LinearClient } from '@linear/sdk';
import { createHash } from 'node:crypto';
import type { LinearIssueInfo, LinearProjectInfo } from '../core/types.js';
import { formatAutomationComment, type CommentSection } from './format.js';
import { setLinearClient } from './projectUpdater.js';
import { withRateLimit } from '../support/rateLimiter.js';
import { c, status } from '../support/colors.js';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { atomicWriteFile } from '../support/atomicFile.js';
import { withFileLock } from '../support/fileLock.js';
import { safeConsole as console } from '../support/safeLog.js';

/**
 * Extract project info from an issue
 */
async function getProjectInfo(issue: any): Promise<LinearProjectInfo | undefined> {
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
let teamId: string = '';
let teamIds: string[] = [];
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
        description
        priority
        createdAt
        state { name }
        project { id name icon color }
        labels { nodes { name } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const STUCK_ISSUES_QUERY = `
  query OswStuckIssues($filter: IssueFilter, $first: Int, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        identifier
        title
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

async function fetchRawIssues(
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

// Daily issue creation limit
const DAILY_ISSUE_LIMIT = 10;
let dailyIssueCount = 0;
let lastResetDate: string = '';
const DAILY_ISSUE_STATE_FILE = process.env.OPENSWARM_DAILY_ISSUE_STATE_FILE
  || resolve(process.env.VITEST ? tmpdir() : homedir(), process.env.VITEST ? `openswarm-linear-quota-${process.pid}.json` : '.openswarm/linear-issue-quota.json');

async function reserveDailyIssue(): Promise<boolean> {
  return withFileLock(`${DAILY_ISSUE_STATE_FILE}.lock`, async () => {
    const today = new Date().toISOString().slice(0, 10);
    let state = { date: today, count: 0 };
    try {
      const parsed = JSON.parse(await readFile(DAILY_ISSUE_STATE_FILE, 'utf8')) as Partial<typeof state>;
      if (parsed.date === today && Number.isSafeInteger(parsed.count) && (parsed.count ?? -1) >= 0) state = { date: today, count: parsed.count! };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (state.count >= DAILY_ISSUE_LIMIT) return false;
    state.count++;
    await atomicWriteFile(DAILY_ISSUE_STATE_FILE, JSON.stringify(state), 0o600);
    dailyIssueCount = state.count;
    lastResetDate = today;
    return true;
  });
}

async function releaseDailyIssue(): Promise<void> {
  await withFileLock(`${DAILY_ISSUE_STATE_FILE}.lock`, async () => {
    const today = new Date().toISOString().slice(0, 10);
    let count = 0;
    try {
      const parsed = JSON.parse(await readFile(DAILY_ISSUE_STATE_FILE, 'utf8')) as { date?: string; count?: number };
      if (parsed.date === today && Number.isSafeInteger(parsed.count)) count = Math.max(0, (parsed.count ?? 0) - 1);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await atomicWriteFile(DAILY_ISSUE_STATE_FILE, JSON.stringify({ date: today, count }), 0o600);
    dailyIssueCount = count;
    lastResetDate = today;
  });
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
 * Reset daily counter on date change
 */
function resetDailyCounterIfNeeded(): void {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (today !== lastResetDate) {
    dailyIssueCount = 0;
    lastResetDate = today;
  }
}

/**
 * Remaining issue creation quota for today
 */
export function getRemainingDailyIssues(): number {
  resetDailyCounterIfNeeded();
  return Math.max(0, DAILY_ISSUE_LIMIT - dailyIssueCount);
}

/**
 * Number of issues created today
 */
export function getDailyIssueCount(): number {
  resetDailyCounterIfNeeded();
  return dailyIssueCount;
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

/**
 * Follow a Linear SDK connection to its last page and return every node.
 * The SDK's fetchNext() appends each fetched page onto the same connection,
 * so a single `first: N` read silently truncates larger workspaces. The page
 * guard only bounds a misbehaving pagination cursor, not real data.
 */
export async function drainLinearConnection(connection: any): Promise<any[]> { // cxt-ignore: type_safety — SDK connection
  let conn: any = connection;
  let guard = 0;
  while (conn?.pageInfo?.hasNextPage && typeof conn.fetchNext === 'function' && guard < 40) {
    conn = await withRateLimit('linear', () => conn.fetchNext());
    guard += 1;
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
  }));

  const result: LinearIssueInfo[] = [];

  // Batch fetch all related data to minimize API calls
  for (const issue of issues.nodes) {
    // Use Promise.all to parallelize, but still results in N queries per issue
    // Linear SDK doesn't support includes/eager loading, so this is unavoidable
    const [comments, labels, state, project] = await Promise.all([
      issue.comments(),
      issue.labels(),
      issue.state,
      getProjectInfo(issue),
    ]);

    result.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      state: state?.name ?? 'Unknown',
      priority: issue.priority,
      labels: labels.nodes.map((l) => l.name),
      comments: comments.nodes.map((c) => ({
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
    first: 10, // Fetch multiple and sort by priority
  }));

  // Sort by priority (lower = higher priority: 1=Urgent, 4=Low, 0=None)
  const sorted = [...issues.nodes].sort((a, b) => {
    // Push priority 0 (None) to the end
    const pa = a.priority === 0 ? 999 : a.priority;
    const pb = b.priority === 0 ? 999 : b.priority;
    return pa - pb;
  });

  const issue = sorted[0];
  if (!issue) return null;

  const [comments, labels, state, project] = await Promise.all([
    issue.comments(),
    issue.labels(),
    issue.state,
    getProjectInfo(issue),
  ]);

  const result = {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? undefined,
    state: state?.name ?? 'Unknown',
    priority: issue.priority,
    labels: labels.nodes.map((l) => l.name),
    comments: comments.nodes.map((c) => ({
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
          description: issue.description ?? undefined,
          state,
          priority: issue.priority,
          labels: issue.labels?.nodes?.map((l) => l.name) ?? [],
          comments: [],
          project: p ? { id: p.id, name: p.name, icon: p.icon ?? undefined, color: p.color ?? undefined } : undefined,
          createdAt: issue.createdAt,
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
          description: issue.description ?? undefined,
          state: issue.state?.name ?? 'Unknown',
          priority: issue.priority,
          labels: issue.labels?.nodes?.map((l) => l.name) ?? [],
          comments: [],
          project: p ? { id: p.id, name: p.name, icon: p.icon ?? undefined, color: p.color ?? undefined } : undefined,
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
 * Outcome of an issue lookup, separating "this issue does not exist" from "the
 * lookup could not be performed".
 *
 * `getIssue` collapses both into `null`, which reads as "no such issue" at
 * every call site. An expired Linear token then surfaced to the operator as
 * `skipped: not found` on dispatch — a report that points at the issue instead
 * of at the credential that actually failed.
 */
export type IssueLookup =
  | { ok: true; issue: LinearIssueInfo | null }
  | { ok: false; error: string };

/**
 * Get a specific issue by ID or identifier, reporting lookup failures instead
 * of folding them into a missing issue. Prefer this over `getIssue` wherever
 * the distinction reaches a human.
 */
export async function lookupIssue(issueIdOrIdentifier: string): Promise<IssueLookup> {
  if (!isLinearInitialized()) return { ok: false, error: 'Linear client is not initialized' };
  try {
    return { ok: true, issue: await fetchIssue(issueIdOrIdentifier) };
  } catch (error) {
    // Fixed first argument: the id is user-supplied (reachable from the
    // /api/work HTTP surface), and console's printf-style formatting must
    // never receive a tainted format string (CodeQL js/tainted-format-string).
    console.error('[Linear] getIssue error:', issueIdOrIdentifier, error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Get a specific issue by ID or identifier
 */
export async function getIssue(issueIdOrIdentifier: string): Promise<LinearIssueInfo | null> {
  const result = await lookupIssue(issueIdOrIdentifier);
  return result.ok ? result.issue : null;
}

async function fetchIssue(issueIdOrIdentifier: string): Promise<LinearIssueInfo | null> {
  const linear = getClient();

  {
    // Check if it's an identifier format (e.g., LIN-123)
    const isIdentifier = /^[A-Z]+-\d+$/.test(issueIdOrIdentifier);

    let issue;
    if (isIdentifier) {
      // Search by identifier - match both team key and number.
      const [teamKey, numPart] = issueIdOrIdentifier.split('-');
      const issueNumber = parseInt(numPart, 10);

      const issues = await linear.issues({
        filter: {
          team: { key: { eq: teamKey } },
          number: { eq: issueNumber },
        },
        first: 1,
      });
      issue = issues.nodes[0];
    } else {
      // Look up directly by ID
      issue = await linear.issue(issueIdOrIdentifier);
    }

    if (!issue) return null;

    const [comments, labels, project] = await Promise.all([
      issue.comments(),
      issue.labels(),
      getProjectInfo(issue),
    ]);

    // Blockers from BOTH sources. The bulk (slim) path only parses prose;
    // this single-issue path can afford the structured-relations call, and
    // `openswarm work`'s unresolved-blocker gate depends on it — without
    // this, direct-id dispatch never saw any blocker at all.
    const blockedBy = new Set<string>();
    try {
      const inverse = await issue.inverseRelations();
      for (const rel of inverse.nodes) {
        if (rel.type !== 'blocks') continue;
        const blocker = await rel.issue;
        if (blocker?.id && blocker.id !== issue.id) blockedBy.add(blocker.id);
      }
    } catch {
      // relations unavailable — prose below still covers the common case
    }
    for (const ident of parseBlockerIdentifiers(issue.description ?? undefined)) {
      if (ident.toUpperCase() !== issue.identifier.toUpperCase()) blockedBy.add(ident);
    }

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      state: (await issue.state)?.name ?? 'Unknown',
      priority: issue.priority,
      labels: labels.nodes.map((l) => l.name),
      comments: comments.nodes.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        user: undefined,
      })),
      project,
      blockedBy: blockedBy.size > 0 ? [...blockedBy] : undefined,
      createdAt: issue.createdAt instanceof Date ? issue.createdAt.toISOString() : undefined,
    };
  }
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

/**
 * Add a comment to an issue
 */
export async function addComment(
  issueId: string,
  body: string,
  commentId?: string,
): Promise<void> {
  if (!isLinearInitialized()) return;
  const linear = getClient();

  try {
    await linear.createComment({
      id: commentId,
      issueId,
      body,
    });
  } catch (error) {
    if (commentId) {
      try {
        const existing = await linear.comment({ id: commentId });
        const existingIssue = await existing.issue;
        if (existingIssue?.id === issueId && existing.body === body) return;
      } catch {
        // Preserve the original create error if artifact reconciliation fails.
      }
    }
    throw error;
  }
}

/** Stable UUIDv4-shaped Linear comment id for an outbox idempotency key. Linear
 * enforces comment-id uniqueness, making concurrent stale deliveries converge
 * remotely as well as locally. */
export function effectCommentId(marker: string): string {
  const bytes = createHash('sha256').update(`openswarm-effect:${marker}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Log a HALT event (low confidence) as a comment on a Linear issue */
export async function logHalt(
  issueId: string, sessionId: string, confidence: number, iteration: number, reason: string,
): Promise<void> {
  await addComment(issueId, formatAutomationComment({
    heading: 'HALT — low confidence',
    summary: `Confidence ${confidence}% is below threshold on attempt #${iteration}; manual input needed.`,
    sections: [
      { label: 'Reason', body: reason },
      { label: 'Suggested next step', body: ['Review the task requirements', 'Provide more context', 'Break it into smaller sub-tasks'] },
    ],
    meta: { Session: sessionId, Confidence: `${confidence}%`, Attempt: `#${iteration}` },
  }));
}

/** Log work start comment for an agent */
export async function logWorkStart(issueId: string, sessionName: string): Promise<void> {
  await addComment(issueId, formatAutomationComment({
    heading: 'Work started',
    meta: { Agent: sessionName },
  }));
  await updateIssueState(issueId, 'In Progress');
}

/**
 * Log progress comment for an agent
 */
export async function logProgress(
  issueId: string,
  sessionName: string,
  progress: string
): Promise<void> {
  await addComment(issueId, formatAutomationComment({
    heading: 'Progress update',
    summary: progress,
    meta: { Agent: sessionName },
  }));
}

/**
 * Log work completion comment for an agent
 */
export async function logWorkComplete(
  issueId: string,
  sessionName: string,
  summary?: string
): Promise<void> {
  await addComment(issueId, formatAutomationComment({
    heading: 'Work complete',
    summary: summary?.trim() || undefined,
    meta: { Agent: sessionName },
  }));
  await updateIssueState(issueId, 'Done');
}

/**
 * Log blocked comment for an agent
 */
export async function logBlocked(
  issueId: string,
  sessionName: string,
  reason: string
): Promise<void> {
  await addComment(issueId, formatAutomationComment({
    heading: 'Blocked — user intervention required',
    sections: [{ label: 'Reason', body: reason }],
    meta: { Agent: sessionName },
  }));
  // Use 'Todo' instead of 'Blocked' (Blocked state may not exist in team workflow)
  await updateIssueState(issueId, 'Todo');
}

/**
 * Label applied to issues the autonomous loop has given up on after exhausting
 * its retries. The heartbeat filter excludes issues carrying this label so they
 * are never retried automatically — the user removes it (or moves the issue back
 * to an active state) to request a retry.
 */
export const STUCK_LABEL = 'swarm:stuck';

/** Resolve a team label id by name, creating the label if it does not exist. */
async function ensureTeamLabel(
  linear: LinearClient,
  resolvedTeamId: string,
  name: string,
): Promise<string | undefined> {
  const team = await linear.team(resolvedTeamId);
  const labels = await team.labels();
  const existing = labels.nodes.find((l) => l.name === name);
  if (existing) return existing.id;
  try {
    const created = await linear.createIssueLabel({ teamId: resolvedTeamId, name, color: '#d4504f' });
    const label = await created.issueLabel;
    return label?.id;
  } catch (err) {
    console.error(`[Linear] Failed to create label "${name}":`, err);
    return undefined;
  }
}

/** Add a label (by name) to an issue without removing its existing labels. */
export async function addIssueLabel(issueId: string, labelName: string): Promise<void> {
  if (!isLinearInitialized()) return;
  const linear = getClient();
  try {
    const issue = await linear.issue(issueId);
    const issueTeam = await issue.team;
    const resolvedTeamId = issueTeam?.id ?? teamIds[0] ?? teamId;
    const labelId = await ensureTeamLabel(linear, resolvedTeamId, labelName);
    if (!labelId) return;
    const current = await issue.labels();
    const ids = new Set(current.nodes.map((l) => l.id));
    if (ids.has(labelId)) return; // already labelled
    ids.add(labelId);
    await linear.updateIssue(issueId, { labelIds: Array.from(ids) });
    clearLinearCache();
  } catch (err) {
    console.error(`[Linear] Failed to add label "${labelName}" to ${issueId}:`, err);
  }
}

/** Remove a label (by name) from an issue if present. */
export async function removeIssueLabel(issueId: string, labelName: string): Promise<void> {
  if (!isLinearInitialized()) return;
  const linear = getClient();
  try {
    const issue = await linear.issue(issueId);
    const current = await issue.labels();
    const remaining = current.nodes.filter((l) => l.name !== labelName).map((l) => l.id);
    if (remaining.length === current.nodes.length) return; // label not present
    await linear.updateIssue(issueId, { labelIds: remaining });
    clearLinearCache();
  } catch (err) {
    console.error(`[Linear] Failed to remove label "${labelName}" from ${issueId}:`, err);
  }
}

/**
 * Mark an issue as permanently stuck: automatic retries are exhausted, so the
 * heartbeat must NOT re-attempt it. Adds the durable {@link STUCK_LABEL} (survives
 * daemon restarts, unlike the in-memory failure counters) and parks the issue in
 * Backlog — a non-recoverable state, so the heartbeat's recovery branch won't
 * silently un-block it. Removing the label or moving the issue back to an active
 * state (Todo / In Progress) is the explicit signal to retry.
 */
export async function logStuck(
  issueId: string,
  sessionName: string,
  reason: string,
): Promise<void> {
  await addComment(issueId, formatAutomationComment({
    heading: 'Stuck — automatic retries exhausted',
    sections: [
      { label: 'Reason', body: reason },
      { label: 'How to retry', body: [
        `Remove the \`${STUCK_LABEL}\` label, or move this issue back to Todo / In Progress.`,
        'The agent will not retry on its own until then.',
      ] },
    ],
    meta: { Agent: sessionName },
  }));
  await addIssueLabel(issueId, STUCK_LABEL);
  await updateIssueState(issueId, 'Backlog');
}

// Pair Mode Linear Integration

/**
 * Log pair session start comment
 */
export async function logPairStart(
  issueId: string,
  sessionId: string,
  projectPath: string
): Promise<void> {
  await addComment(issueId, formatAutomationComment({
    heading: 'Pair session started',
    summary: 'Starting work in Worker/Reviewer pair mode.',
    meta: { Session: sessionId, Project: projectPath },
  }));
  await updateIssueState(issueId, 'In Progress');
}

/**
 * Log pair session review start comment
 */
export async function logPairReview(
  issueId: string,
  sessionId: string,
  attempt: number
): Promise<void> {
  await addComment(issueId, formatAutomationComment({
    heading: 'Reviewing',
    summary: "Reviewer is evaluating the Worker's output.",
    meta: { Session: sessionId, Attempt: `#${attempt}` },
  }));
  await updateIssueState(issueId, 'In Review');
}

/**
 * Log pair session revision request comment
 */
export async function logPairRevision(
  issueId: string,
  sessionId: string,
  feedback: string,
  issues: string[]
): Promise<void> {
  await addComment(issueId, formatAutomationComment({
    heading: 'Revision requested',
    summary: 'Worker will proceed with revisions.',
    sections: [
      { label: 'Feedback', body: feedback },
      { label: 'Issues', body: issues.length > 0 ? issues : ['(none)'] },
    ],
    meta: { Session: sessionId },
  }));
  await updateIssueState(issueId, 'In Progress');
}

/**
 * Log pair session completion comment
 */
export async function logPairComplete(
  issueId: string,
  sessionId: string,
  stats: {
    attempts: number;
    duration: number;
    filesChanged: string[];
    workerSummary?: string;
    workerCommands?: string[];
    reviewerFeedback?: string;
    reviewerDecision?: string;
    testResults?: {
      passed: number;
      failed: number;
      coverage?: number;
      failedTests?: string[];
    };
    remainingWork?: string;
    idempotencyMarker?: string;
  }
): Promise<void> {
  const durationStr = stats.duration < 60
    ? `${stats.duration}s`
    : `${Math.floor(stats.duration / 60)}m ${stats.duration % 60}s`;

  const sections: CommentSection[] = [];

  if (stats.workerCommands && stats.workerCommands.length > 0) {
    sections.push({ label: 'Commands run', body: stats.workerCommands.slice(0, 5).map((c) => `\`${c}\``) });
  }

  if (stats.reviewerFeedback) {
    sections.push({
      label: `Reviewer — ${stats.reviewerDecision || 'APPROVE'}`,
      body: stats.reviewerFeedback.trim(),
    });
  }

  if (stats.testResults) {
    const { passed, failed, coverage, failedTests } = stats.testResults;
    const totalTests = passed + failed;
    const passRate = totalTests > 0 ? ((passed / totalTests) * 100).toFixed(1) : '0';
    const lines = [`Passed ${passed}/${totalTests} (${passRate}%)`];
    if (coverage !== undefined) lines.push(`Coverage ${coverage.toFixed(1)}%`);
    if (failed > 0 && failedTests && failedTests.length > 0) {
      const extra = failedTests.length > 3 ? ` (+${failedTests.length - 3} more)` : '';
      lines.push(`Failed: ${failedTests.slice(0, 3).join(', ')}${extra}`);
    }
    sections.push({ label: 'Tests', body: lines });
  }

  if (stats.remainingWork) {
    sections.push({ label: 'Remaining work', body: stats.remainingWork.trim() });
  }

  sections.push({
    label: 'Changed files',
    body: stats.filesChanged.length > 0
      ? stats.filesChanged.slice(0, 10).map((f) => `\`${f}\``)
      : ['(none)'],
  });

  const comment = formatAutomationComment({
    heading: 'Task complete',
    summary: stats.workerSummary?.trim() || undefined,
    sections,
    meta: {
      Session: sessionId,
      Iterations: stats.attempts,
      Duration: durationStr,
      Files: stats.filesChanged.length,
    },
    attribution: 'Worker/Reviewer/Tester pipeline',
  }) + (stats.idempotencyMarker ? `\n\n<!-- openswarm-effect:${stats.idempotencyMarker} -->` : '');
  await addComment(issueId, comment, stats.idempotencyMarker ? effectCommentId(stats.idempotencyMarker) : undefined);
  const accepted = await updateIssueState(issueId, 'Done');
  if (!accepted) throw new Error(`Linear refused Done transition for ${issueId}`);
}

/**
 * Log pair session failure/rejection comment
 */
export async function logPairFailed(
  issueId: string,
  sessionId: string,
  reason: 'rejected' | 'max_attempts' | 'error',
  details: string
): Promise<void> {
  const reasonText = {
    rejected: 'Reviewer rejected the work',
    max_attempts: 'Maximum retry attempts exceeded',
    error: 'An error occurred',
  }[reason];

  await addComment(issueId, formatAutomationComment({
    heading: 'Work failed — manual intervention required',
    summary: reasonText,
    sections: [{ label: 'Details', body: details }],
    meta: { Session: sessionId },
  }));
  // Don't change state on failure; let the user decide
}

/**
 * Create a new issue (with daily limit enforcement)
 */
export async function createIssue(
  title: string,
  description: string,
  labels: string[] = [],
  options?: { bypassLimit?: boolean; projectId?: string }
): Promise<LinearIssueInfo | { error: string }> {
  if (!isLinearInitialized()) return { error: 'Linear not configured' };
  resetDailyCounterIfNeeded();

  const linear = getClient();

  // Resolve a single team UUID. Multi-team configs hold a comma-joined list in the
  // module `teamId` (e.g. "uuid1,uuid2"), which is NOT a valid UUID for the API.
  // Prefer the given project's team, else the first configured team. (INT-2210)
  let resolvedTeamId = teamIds[0] ?? teamId;
  if (options?.projectId) {
    try {
      const proj = await linear.project(options.projectId);
      const projTeam = (await proj.teams()).nodes[0]; // a project can span teams; take the first
      if (projTeam?.id) resolvedTeamId = projTeam.id;
    } catch {
      /* project/team lookup failed → keep teamIds[0] fallback */
    }
  }

  // Look up label IDs
  const team = await linear.team(resolvedTeamId);
  const teamLabels = await team.labels();
  const labelIds = labels
    .map((name) => teamLabels.nodes.find((l) => l.name === name)?.id)
    .filter((id): id is string => !!id);

  const reserved = options?.bypassLimit ? false : await reserveDailyIssue();
  if (!options?.bypassLimit && !reserved) {
    return { error: `Daily issue creation limit (${DAILY_ISSUE_LIMIT}) reached. Please try again tomorrow.` };
  }
  let issuePayload;
  try {
    issuePayload = await linear.createIssue({
      teamId: resolvedTeamId,
      title,
      description,
      labelIds,
      ...(options?.projectId ? { projectId: options.projectId } : {}),
    });
  } catch (error) {
    if (reserved) await releaseDailyIssue();
    throw error;
  }

  const issue = await issuePayload.issue;
  if (!issue) {
    if (reserved) await releaseDailyIssue();
    throw new Error('Failed to create issue');
  }
  const stateName = (await issue.state)?.name ?? 'Unknown';

  // Clear cache after mutation
  clearLinearCache();

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? undefined,
    state: stateName,
    priority: issue.priority,
    labels,
    comments: [],
  };
}

/**
 * Create a sub-issue (for Planner decomposition)
 * - Creates as a child of the parent issue via parentId
 * - Exempt from daily limit (auto-decomposition is required work)
 */
export async function createSubIssue(
  parentId: string,
  title: string,
  description: string,
  options?: {
    priority?: number;  // 1=Urgent, 2=High, 3=Normal, 4=Low
    labels?: string[];
    projectId?: string;
    estimatedMinutes?: number;
    /** Stable UUID v4 for crash-safe decomposition retries. */
    idempotencyId?: string;
  }
): Promise<LinearIssueInfo | { error: string }> {
  if (!isLinearInitialized()) return { error: 'Linear not configured' };
  const linear = getClient();

  try {
    // Get parent issue info
    const parentIssue = await linear.issue(parentId);
    if (!parentIssue) {
      return { error: `Parent issue not found: ${parentId}` };
    }

    // Create the sub-issue under the parent issue's team, and resolve labels there.
    const parentTeam = await parentIssue.team;
    const subIssueTeamId = parentTeam?.id ?? (teamIds[0] ?? teamId);
    const team = await linear.team(subIssueTeamId);
    const teamLabels = await team.labels();
    const labelIds = (options?.labels || [])
      .map((name) => teamLabels.nodes.find((l) => l.name === name)?.id)
      .filter((id): id is string => !!id);

    // Add auto-decomposed label
    const autoLabel = teamLabels.nodes.find((l) => l.name === 'auto-decomposed');
    if (autoLabel) {
      labelIds.push(autoLabel.id);
    }

    const issuePayload = await linear.createIssue({
      id: options?.idempotencyId,
      teamId: subIssueTeamId,
      parentId,  // Link to parent issue
      title,
      description,
      labelIds,
      priority: options?.priority ?? 3,
      projectId: options?.projectId,
    });

    const issue = await issuePayload.issue;
    if (!issue) {
      throw new Error('Failed to create sub-issue');
    }
    const stateName = (await issue.state)?.name ?? 'Unknown';

    console.log(`[Linear] Created sub-issue: ${issue.identifier} under ${parentIssue.identifier}`);

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      state: stateName,
      priority: issue.priority,
      labels: options?.labels || [],
      comments: [],
    };
  } catch (error) {
    if (options?.idempotencyId) {
      try {
        const existing = await linear.issue(options.idempotencyId);
        const existingParent = await existing.parent;
        if (
          existingParent?.id === parentId
          && existing.title === title
          && (existing.description ?? '') === description
        ) {
          const stateName = (await existing.state)?.name ?? 'Unknown';
          console.warn(`[Linear] Recovered idempotent sub-issue create: ${existing.identifier}`);
          return {
            id: existing.id,
            identifier: existing.identifier,
            title: existing.title,
            description: existing.description ?? undefined,
            state: stateName,
            priority: existing.priority,
            labels: options?.labels || [],
            comments: [],
          };
        }
        console.error(`[Linear] Idempotent child collision for ${options.idempotencyId}: existing artifact does not match the requested plan`);
      } catch {
        // Preserve the original create error when no matching artifact exists.
      }
    }
    console.error('[Linear] createSubIssue error:', error);
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Mark a parent issue as 'decomposed'
 */
export async function markAsDecomposed(
  issueId: string,
  subIssueCount: number,
  totalMinutes: number,
  idempotencyMarker?: string,
): Promise<void> {
  const body = formatAutomationComment({
    heading: 'Decomposed into sub-issues',
    summary: 'The parent stays active while child issues execute; it closes automatically once all sub-issues complete.',
    sections: [{
      label: 'Result',
      body: [`Sub-issues created: ${subIssueCount}`, `Total estimated time: ${totalMinutes} min`],
    }],
    attribution: 'Planner agent',
  });

  await addComment(issueId, body, idempotencyMarker ? effectCommentId(idempotencyMarker) : undefined);

  // Keep parent issue active until all child issues complete. A false return is
  // a real partial-effect failure (comment exists, state did not move), so let
  // the idempotent decomposition retry reconcile it.
  const accepted = await updateIssueState(issueId, 'In Progress');
  if (!accepted) throw new Error(`Linear refused decomposed parent transition for ${issueId}`);

  // Add label (if decomposed label exists)
  try {
    const linear = getClient();
    const team = await linear.team(teamIds[0] ?? teamId);
    const teamLabels = await team.labels();
    const decomposedLabel = teamLabels.nodes.find((l) => l.name === 'decomposed');

    if (decomposedLabel) {
      const issue = await linear.issue(issueId);
      const currentLabels = await issue.labels();
      const currentLabelIds = currentLabels.nodes.map(l => l.id);

      await linear.updateIssue(issueId, {
        labelIds: [...currentLabelIds, decomposedLabel.id],
      });
    }
  } catch (err) {
    console.warn('[Linear] Failed to add decomposed label:', err);
  }
}

/**
 * Agent proposes work by creating a backlog issue
 * - Enforces daily limit of 10
 * - Automatically adds 'agent-proposal' label
 * - Created with low priority (4)
 */
export async function proposeWork(
  sessionName: string,
  title: string,
  rationale: string,
  suggestedApproach?: string
): Promise<LinearIssueInfo | { error: string }> {
  if (!isLinearInitialized()) return { error: 'Linear not configured' };
  resetDailyCounterIfNeeded();

  const linear = getClient();

  // Look up Backlog state ID
  const proposalTeamId = teamIds[0] ?? teamId;
  const team = await linear.team(proposalTeamId);
  const states = await team.states();
  const backlogState = states.nodes.find((s) =>
    s.name.toLowerCase() === 'backlog'
  );

  // Look up label IDs (agent-proposal + sessionName)
  const teamLabels = await team.labels();
  const proposalLabel = teamLabels.nodes.find((l) => l.name === 'agent-proposal');
  const sessionLabel = teamLabels.nodes.find((l) => l.name === sessionName);

  const labelIds: string[] = [];
  if (proposalLabel) labelIds.push(proposalLabel.id);
  if (sessionLabel) labelIds.push(sessionLabel.id);

  // Compose description
  const description = `## 🤖 Agent Proposal

**Proposed by:** ${sessionName}
**Created at:** ${new Date().toISOString()}

---

### Rationale
${rationale}

${suggestedApproach ? `### Suggested Approach\n${suggestedApproach}` : ''}

---
_This issue was auto-created by an agent. Please review and adjust priority or delete as needed._`;

  const reserved = await reserveDailyIssue();
  if (!reserved) {
    console.log(`[${sessionName}] Daily issue creation limit reached (${dailyIssueCount}/${DAILY_ISSUE_LIMIT})`);
    return { error: `Daily issue creation limit (${DAILY_ISSUE_LIMIT}) reached. Please defer the proposal to tomorrow.` };
  }
  let issuePayload;
  try {
    issuePayload = await linear.createIssue({
      teamId: proposalTeamId,
      title: `[Proposal] ${title}`,
      description,
      labelIds,
      stateId: backlogState?.id,
      priority: 4, // Low priority
    });
  } catch (error) {
    await releaseDailyIssue();
    throw error;
  }

  const issue = await issuePayload.issue;
  if (!issue) {
    await releaseDailyIssue();
    throw new Error('Failed to create proposal issue');
  }

  console.log(`[${sessionName}] Proposal created: ${issue.identifier} (today ${dailyIssueCount}/${DAILY_ISSUE_LIMIT})`);

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? undefined,
    state: 'Backlog',
    priority: 4,
    labels: ['agent-proposal', sessionName].filter(Boolean),
    comments: [],
  };
}

/**
 * Get stuck/failed issues and PRs (issues stuck in In Progress for >7 days, or with retry/failed labels)
 */
export async function getStuckIssues(): Promise<{
  stuckIssues: Array<LinearIssueInfo & { stuckDays: number; reason: string }>;
  failedIssues: Array<LinearIssueInfo & { reason: string }>;
}> {
  if (!isLinearInitialized()) {
    return { stuckIssues: [], failedIssues: [] };
  }
  const linear = getClient();
  const now = Date.now();
  const STUCK_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  // Fetch all display fields in two nested GraphQL requests. Resolving SDK
  // relations per issue here used to create an N+1 waterfall and made the
  // dashboard endpoint time out whenever the stuck list became sizeable.
  const ids = teamIds.length > 0 ? teamIds : (teamId ? [teamId] : []);
  const team = ids.length === 1 ? { id: { eq: ids[0] } } : { id: { in: ids } };
  const [inProgressIssues, problematicIssues] = await Promise.all([
    fetchRawIssues(linear, {
      ...(ids.length ? { team } : {}),
      state: { name: { eq: 'In Progress' } },
    }, STUCK_ISSUES_QUERY),
    fetchRawIssues(linear, {
      ...(ids.length ? { team } : {}),
      state: { name: { nin: ['Done', 'Canceled'] } },
      labels: { name: { in: ['retry', 'failed', 'blocked', 'needs-help', STUCK_LABEL] } },
    }, STUCK_ISSUES_QUERY),
  ]);

  const stuckIssues: Array<LinearIssueInfo & { stuckDays: number; reason: string }> = [];
  const failedIssues: Array<LinearIssueInfo & { reason: string }> = [];

  // Process In Progress issues (check if stuck)
  for (const issue of inProgressIssues.nodes) {
    const updatedAt = new Date(issue.updatedAt ?? 0).getTime();
    const stuckMs = now - updatedAt;

    if (stuckMs > STUCK_THRESHOLD_MS) {
      const stuckDays = Math.floor(stuckMs / (24 * 60 * 60 * 1000));
      stuckIssues.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? undefined,
        state: issue.state?.name ?? 'Unknown',
        priority: issue.priority,
        labels: issue.labels?.nodes.map((l) => l.name) ?? [],
        comments: issue.comments?.nodes.map((c) => ({
          id: c.id,
          body: c.body,
          createdAt: new Date(c.createdAt).toISOString(),
          user: undefined,
        })) ?? [],
        project: issue.project ? {
          id: issue.project.id,
          name: issue.project.name,
          icon: issue.project.icon ?? undefined,
          color: issue.project.color ?? undefined,
        } : undefined,
        stuckDays,
        reason: `No updates for ${stuckDays} days`,
      });
    }
  }

  // Process problematic issues (retry, failed, blocked)
  for (const issue of problematicIssues.nodes) {
    const labelNames = issue.labels?.nodes.map((l) => l.name) ?? [];
    let reason = 'Unknown issue';

    if (labelNames.includes('failed')) {
      reason = 'Marked as failed';
    } else if (labelNames.includes('retry')) {
      reason = 'Requires retry';
    } else if (labelNames.includes('blocked')) {
      reason = 'Blocked by dependencies';
    } else if (labelNames.includes('needs-help')) {
      reason = 'Needs manual intervention';
    } else if (labelNames.includes(STUCK_LABEL)) {
      reason = 'Automatic retries exhausted';
    }

    failedIssues.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      state: issue.state?.name ?? 'Unknown',
      priority: issue.priority,
      labels: labelNames,
      comments: issue.comments?.nodes.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: new Date(c.createdAt).toISOString(),
        user: undefined,
      })) ?? [],
      project: issue.project ? {
        id: issue.project.id,
        name: issue.project.name,
        icon: issue.project.icon ?? undefined,
        color: issue.project.color ?? undefined,
      } : undefined,
      reason,
    });
  }

  return {
    stuckIssues: stuckIssues.sort((a, b) => b.stuckDays - a.stuckDays),
    failedIssues: failedIssues.sort((a, b) => {
      const pa = a.priority === 0 ? 999 : a.priority;
      const pb = b.priority === 0 ? 999 : b.priority;
      return pa - pb;
    }),
  };
}
