// MonitorPanel — generic daemon-data tab (EPIC INT-1813 S6 / INT-1939).
// Polls a fetcher and renders the resulting table; used by Projects/Tasks/
// Stuck/Issues. Boundary (useMonitor); DataTable + mappers carry tested logic.
import { Text } from 'ink';
import { DataTable } from '../components/DataTable.js';
import { useMonitor } from '../hooks/useMonitor.js';
import { theme } from '../theme.js';
import type { Table } from '../monitorRows.js';
import { formatMonitorError } from '../sanitize.js';

export interface MonitorPanelProps {
  port?: number;
  fetcher: (port: number) => Promise<Table>;
  empty?: string;
  terminalWidth?: number;
}

export function MonitorPanel({ port, fetcher, empty, terminalWidth }: MonitorPanelProps) {
  const { table, error, loading } = useMonitor(port, fetcher);
  if (!port) return <Text dimColor>○ daemon port unknown</Text>;
  if (error) {
    return <Text color={theme.err}>{`load failed: ${formatMonitorError(error)}`}</Text>;
  }
  if (!table) return <Text dimColor>{loading ? 'loading…' : '(no data)'}</Text>;
  return <DataTable columns={table.columns} rows={table.rows} empty={empty} terminalWidth={terminalWidth} />;
}
