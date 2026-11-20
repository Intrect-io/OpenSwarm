/**
 * Pagination primitives for Linear SDK connections: page-size constants for the
 * active/backlog list paths and a bounded connection drain with cursor-loop
 * protection. Split out of linear.ts to keep that file under the size gate.
 */
import { withRateLimit } from '../support/rateLimiter.js';

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
