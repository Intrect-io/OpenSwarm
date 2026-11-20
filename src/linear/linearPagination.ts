/**
 * Pagination primitives for Linear SDK connections: page-size constants for the
 * active/backlog list paths and a bounded connection drain with cursor-loop
 * protection. Split out of linear.ts to keep that file under the size gate.
 */
import { withRateLimit } from '../support/rateLimiter.js';
import { safeConsole as console } from '../support/safeLog.js';

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
export const LINEAR_BACKLOG_PAGE_SIZE = 50;
/**
 * Page cap for the backlog pick. Ranking must see the WHOLE eligible set —
 * the globally highest-priority issue can sit pages deep while page one holds
 * only fillers — so we drain bounded pages before ranking (AGT-3421). Pages of
 * 50 keep a cache miss at <= 4 sequential Linear requests for 200 candidates.
 */
export const LINEAR_BACKLOG_MAX_PAGES = 4;
/** Candidate window for the backlog pick: page size × page cap. */
export const LINEAR_BACKLOG_MAX_CANDIDATES = LINEAR_BACKLOG_PAGE_SIZE * LINEAR_BACKLOG_MAX_PAGES;
/** TTL for a cached EMPTY backlog pick, so an idle agent does not re-drain on every poll. */
export const LINEAR_EMPTY_BACKLOG_TTL_MS = 60_000;
export const LINEAR_RELATED_PAGE_SIZE = 50;

/** Result of a bounded connection drain. */
export interface LinearDrainResult {
  nodes: any[];
  /** True when more data existed than was returned (page cap or cursor fault). */
  truncated: boolean;
  /** Set when the drain stopped on a missing/repeated pagination cursor. */
  cursorFault?: string;
}

/**
 * Follow a Linear SDK connection page by page, never throwing on a cursor
 * anomaly. A page that claims `hasNextPage` but carries no endCursor (including
 * the initial page) or repeats the previous cursor means the API re-served the
 * same window: the drain stops, drops that page's nodes, and reports
 * `truncated` plus `cursorFault` instead of looping or duplicating nodes.
 */
export async function drainLinearConnectionPages(
  connection: any, // cxt-ignore: type_safety — SDK connection
  maxPages = DRAIN_PAGE_GUARD,
): Promise<LinearDrainResult> {
  let conn: any = connection;
  const pageCap = Math.max(1, Math.min(DRAIN_PAGE_GUARD, Math.trunc(maxPages) || DRAIN_PAGE_GUARD));
  if (conn?.pageInfo?.hasNextPage && !conn.pageInfo.endCursor) {
    return { nodes: conn?.nodes ?? [], truncated: true, cursorFault: 'missing cursor on the initial page' };
  }
  // `pageCap` counts the page already present on the connection.
  let pages = 1;
  let lastCursor: string | undefined = conn?.pageInfo?.endCursor ?? undefined;
  while (conn?.pageInfo?.hasNextPage && typeof conn.fetchNext === 'function' && pages < pageCap) {
    // The SDK appends each fetched page onto the same nodes array, so snapshot
    // the collected prefix to drop a re-served page on a cursor fault.
    const prevNodes: any[] = conn.nodes ?? [];
    const prevCount = prevNodes.length;
    conn = await withRateLimit('linear', () => conn.fetchNext());
    pages += 1;
    const cursor = conn?.pageInfo?.endCursor;
    const faulty = cursor ? cursor === lastCursor : conn?.pageInfo?.hasNextPage === true;
    if (faulty) {
      const kind = cursor ? 'repeated' : 'missing';
      return {
        nodes: prevNodes.slice(0, prevCount),
        truncated: true,
        cursorFault: `${kind} cursor after ${pages - 1} fetched page(s)`,
      };
    }
    lastCursor = cursor ?? lastCursor;
  }
  return { nodes: conn?.nodes ?? [], truncated: conn?.pageInfo?.hasNextPage === true };
}

/**
 * Nodes-only drain for the team/project pickers. Unlike
 * drainLinearConnectionPages, a cursor fault still throws here: a picker must
 * not silently offer a partial list. The page guard only bounds a misbehaving
 * cursor, not real data.
 */
export async function drainLinearConnection(
  connection: any, // cxt-ignore: type_safety — SDK connection
  maxPages = DRAIN_PAGE_GUARD,
): Promise<any[]> {
  const { nodes, cursorFault } = await drainLinearConnectionPages(connection, maxPages);
  if (cursorFault) throw new Error(`Linear pagination returned a ${cursorFault}`);
  return nodes;
}

/**
 * Bounded drain for the in-progress and backlog paths: returns at most `cap`
 * nodes and never throws on a cursor fault. Logs ONE warning per call when the
 * eligible set exceeded the window, naming the cap, so a ranking over a partial
 * set is never silent.
 */
export async function drainBoundedIssues(
  connection: any, // cxt-ignore: type_safety — SDK connection
  maxPages: number,
  cap: number,
  what: string,
): Promise<LinearDrainResult> {
  const drained = await drainLinearConnectionPages(connection, maxPages);
  const truncated = drained.truncated || drained.nodes.length > cap;
  if (truncated) {
    const reason = drained.cursorFault
      ? `pagination stopped on a ${drained.cursorFault}`
      : `eligible set exceeds the ${cap}-issue cap`;
    console.warn(`[Linear] ${what}: ${reason}; working over a partial set (cap ${cap})`);
  }
  return { nodes: drained.nodes.slice(0, cap), truncated, cursorFault: drained.cursorFault };
}
