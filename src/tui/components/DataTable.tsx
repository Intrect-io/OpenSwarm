// DataTable — minimal column-aligned table for the monitor tabs (S6).
// Hand-rolled (no ink-table) to avoid peer-version risk on ink 7 / react 19.
import { Box, Text } from 'ink';
import { displayWidth, truncateLine } from '../../cli/reviewProgress.js';
import type { Table } from '../monitorRows.js';
import { sanitizeTerminalText } from '../sanitize.js';
import { flattenToSingleLine } from '../../support/outputBudget.js';

export interface DataTableProps extends Table {
  empty?: string;
  maxCellWidth?: number;
  terminalWidth?: number;
}

/** Normalize untrusted cell text to a single display line before width clipping. */
function toDisplayCell(value: string): string {
  return flattenToSingleLine(sanitizeTerminalText(value));
}

export function DataTable({ columns, rows, empty, maxCellWidth = 28, terminalWidth }: DataTableProps) {
  if (rows.length === 0) {
    return <Text dimColor>{empty ?? '(no data)'}</Text>;
  }
  const visibleColumnCount = terminalWidth
    ? Math.max(1, Math.min(columns.length, terminalWidth))
    : columns.length;
  const rawColumns = columns.slice(0, visibleColumnCount).map(toDisplayCell);
  const separatorWidth = terminalWidth && visibleColumnCount > 1
    ? Math.max(0, Math.min(2, Math.floor((terminalWidth - visibleColumnCount) / (visibleColumnCount - 1))))
    : 2;
  const separator = ' '.repeat(separatorWidth);
  const gapWidth = Math.max(0, visibleColumnCount - 1) * separatorWidth;
  const availableCellWidth = terminalWidth ? Math.max(1, terminalWidth - gapWidth) : undefined;
  const columnCount = Math.max(1, visibleColumnCount);
  const cellWidth = availableCellWidth
    ? Math.max(1, Math.min(maxCellWidth, Math.floor(availableCellWidth / columnCount)))
    : maxCellWidth;
  const clip = (value: string) => truncateLine(value, cellWidth);
  const clippedColumns = rawColumns.map(clip);
  const clippedRows = rows.map((row) => rawColumns.map((_, i) => clip(toDisplayCell(row[i] ?? ''))));
  const widths = clippedColumns.map((c, i) =>
    Math.max(displayWidth(c), ...clippedRows.map((r) => displayWidth(r[i] ?? ''))),
  );
  const fmt = (cells: string[]) =>
    cells.map((cell, i) => `${cell ?? ''}${' '.repeat(Math.max(0, widths[i] - displayWidth(cell ?? '')))}`).join(separator);
  return (
    <Box flexDirection="column">
      <Text bold>{fmt(clippedColumns)}</Text>
      {clippedRows.map((r, i) => (
        <Text key={i}>{fmt(r)}</Text>
      ))}
    </Box>
  );
}
