/**
 * Bounded table scans for memory maintenance.
 *
 * Helpers that walk the memory table in fixed-offset pages with an optional
 * pushed-down filter and column projection, so a maintenance pass holds one
 * page (or one consolidation bucket) at a time instead of materialising the
 * whole table and its embedding vectors.
 */

/** Rows read per page by the bounded maintenance scans. */
export const SCAN_PAGE_SIZE = 10_000;

/** The slice of the LanceDB query builder a paged scan uses. */
export interface PagedQuery {
  where?: (predicate: string) => PagedQuery;
  select?: (columns: string[]) => PagedQuery;
  offset: (n: number) => { limit: (n: number) => { toArray: () => Promise<any[]> } };
}

export interface TableScan {
  /** SQL filter pushed down to the store, so non-matching rows never cross into JS. */
  where?: string;
  /** Columns to read; leave out wide ones (the embedding `vector`) the caller never uses. */
  columns?: string[];
}

/** Quote a string as a SQL literal, doubling embedded single quotes. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Equality predicate on one column. Identifiers are double-quoted because
 * Lance/DataFusion lowercases unquoted ones; a null value becomes `IS NULL`
 * since `= 'null'` would match the literal string instead.
 */
export function columnEquals(column: string, value: unknown): string {
  if (value === null || value === undefined) return `"${column}" IS NULL`;
  return `"${column}" = ${sqlString(String(value))}`;
}

/**
 * Walk every row of `table` in offset pages, handing each page to `onPage`.
 * Only the current page is held; the caller decides what to retain.
 *
 * Offset paging is not a snapshot: a concurrent write can shift a row onto two
 * pages or past the cursor, as with fetchAllTableRows.
 */
export async function scanTablePages(
  table: { query: () => PagedQuery },
  onPage: (page: any[]) => void,
  scan: TableScan = {},
  pageSize: number = SCAN_PAGE_SIZE,
): Promise<void> {
  const size = Math.max(1, Math.floor(pageSize));
  const pageQuery = (): PagedQuery => {
    let query = table.query();
    if (scan.where) query = query.where!(scan.where);
    if (scan.columns) query = query.select!(scan.columns);
    return query;
  };

  let offset = 0;
  for (;;) {
    const page = await pageQuery().offset(offset).limit(size).toArray();
    if (page.length === 0) break;
    onPage(page);
    offset += page.length;
    if (page.length < size) break;
  }
}
