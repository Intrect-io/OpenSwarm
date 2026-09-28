// SubagentTree — concurrent tasks as a per-worktree agent tree (S7).
// Presentational: takes nodes built by buildSubagentTree.
import { Box, Text, useStdout } from 'ink';
import { memo, useEffect, useState } from 'react';
import { STATUS } from '../theme.js';
import { oneLine, truncateLine } from '../../cli/reviewProgress.js';
import type { StatusKind } from '../../support/glyphs.js';
import type { RepositoryNode, TaskStatus } from '../subagentTree.js';
import { spinnerFrame } from '../loadingMessages.js';
import { safeIsoDate, sanitizeTerminalText } from '../sanitize.js';

// Single-sourced glyphs + colors (INT-2260): running → ◐, complete → ✓, fail → ✗.
const KIND: Record<TaskStatus, StatusKind> = { start: 'running', complete: 'ok', fail: 'err' };

// Each node is one row. The budget applies to the WHOLE composed row (indent +
// fields + separators): stage names, branches and titles arrive from the event
// stream, and a newline- or over-long one used to wrap its row into several,
// growing the tree past the frame. Cap in terminal COLUMNS, never code units;
// NODE_BUDGET is the widest indent (`     └ ` = 7) plus the reserved last
// column. (AGT-3458)
const NODE_BUDGET = 8;

/** Collapse layout whitespace, then clip the composed row to a column budget. */
function nodeLine(value: string, columns: number): string {
  return truncateLine(oneLine(value), Math.max(10, columns - NODE_BUDGET));
}

function clampLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export interface SubagentTreeProps {
  repositories: RepositoryNode[];
  /** Max worktrees shown across each repository (most recent). */
  max?: number;
  /** Max role children shown per worktree. */
  maxRoles?: number;
}

function formatDuration(ms: number | undefined): string | undefined {
  if (ms == null) return undefined;
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function field(value: string | undefined): string {
  return oneLine(sanitizeTerminalText(value || ''));
}

function worktreeLabel(task: RepositoryNode['worktrees'][number]): string {
  const id = task.issueIdentifier ?? task.taskId;
  const branch = task.branch ? ` ${task.branch}` : task.worktree ? ` worktree/${task.worktree}` : '';
  const stage = task.currentStage ? ` ${task.currentStage}` : '';
  const duration = formatDuration(task.durationMs);
  const decision = task.decision ? ` ${task.decision}` : '';
  const title = task.title ? ` ${task.title}` : '';
  return field(`${id}${branch}${stage}${duration ? ` ${duration}` : ''}${decision}${title}`);
}

// Memoized so log-only pipeline updates (stable `repositories` identity from the
// panel's useMemo) skip re-rendering the tree — only stage changes rebuild it,
// which also keeps the spinner interval from re-subscribing each render. (INT-2407)
export const SubagentTree = memo(function SubagentTree({ repositories, max = 6, maxRoles = 5 }: SubagentTreeProps) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const worktreeLimit = clampLimit(max);
  const roleLimit = clampLimit(maxRoles);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!repositories.some((repo) => repo.worktrees.some((task) => task.roles.some((role) => role.status === 'start')))) return;
    const timer = setInterval(() => setTick((value) => value + 1), 120);
    return () => clearInterval(timer);
  }, [repositories]);

  return (
    <Box flexDirection="column">
      <Text bold>Agents by repository</Text>
      {repositories.length === 0 || worktreeLimit === 0 ? (
        <Text dimColor>(no active agents)</Text>
      ) : (
        repositories.map((repo) => (
          <Box key={repo.repository} flexDirection="column">
            <Text color={STATUS[KIND[repo.status]].color}>{nodeLine(`${STATUS[KIND[repo.status]].icon} ${field(repo.repository)}`, columns)}</Text>
            {repo.worktrees.slice(-worktreeLimit).map((task) => (
              <Box key={`${repo.repository}:${task.taskId}`} flexDirection="column">
                <Text dimColor>{nodeLine(`  └ ${worktreeLabel(task)} — ${task.status}`, columns)}</Text>
                {(roleLimit === 0 ? [] : task.roles.slice(-roleLimit)).map((role, i) => (
                  <Text key={i} dimColor>
                    {nodeLine(
                      `     └ ${role.status === 'start' ? spinnerFrame(tick) : ''} ${field(role.role)}${role.model ? ` (${field(role.model)})` : ''} — ${role.status}${role.activity ? ` · ${field(role.activity)}` : ''}${safeIsoDate(role.rateLimitResetsAt) ? ` · reset ${safeIsoDate(role.rateLimitResetsAt)}` : ''}${role.decision ? `/${field(role.decision)}` : ''}`,
                      columns,
                    )}
                  </Text>
                ))}
              </Box>
            ))}
          </Box>
        ))
      )}
    </Box>
  );
});
