// AuditBoard — live multi-area board for `openswarm review --max` (INT-2006).
// Each in-flight reviewer subagent gets its own row (spinner + area + last tool
// line); finished areas roll up into a verdict tally. Showing only the running
// rows (≤ concurrency) keeps the board height stable no matter how many areas
// the codebase splits into. Drives off a progress EventEmitter so the pure
// orchestration (runMaxReview) stays ink-free.
import { Box, Text } from 'ink';
import { useState, useEffect } from 'react';
import type { EventEmitter } from 'node:events';
import { theme, ICON } from '../theme.js';
import { Spinner } from './Status.js';
import type { AuditArea, AuditProgress } from '../../cli/reviewAudit.js';
import type { FixProgress } from '../../cli/reviewFixPass.js';
import type { ReviewResult } from '../../agents/agentPair.js';
import { sanitizeTerminalText } from '../sanitize.js';

type AreaStatus = {
  status: 'pending' | 'running' | 'done' | 'error';
  decision?: ReviewResult['decision'];
  filesChanged?: number;
  lastLog?: string;
};

export interface AuditBoardProps {
  areas: AuditArea[];
  concurrency: number;
  /** Emits 'progress' as the fan-out advances. */
  events: EventEmitter;
  mode?: 'audit' | 'fix';
}

const truncate = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export function AuditBoard({ areas, concurrency, events, mode = 'audit' }: AuditBoardProps) {
  const [statuses, setStatuses] = useState<Record<string, AreaStatus>>(() =>
    Object.fromEntries(areas.map((a) => [a.label, { status: 'pending' as const }])),
  );

  useEffect(() => {
    const onProgress = (e: AuditProgress | FixProgress) => {
      // Batch-level notices belong to no area row — the CLI prints them instead.
      if (!('label' in e)) return;
      setStatuses((prev) => {
        const cur = prev[e.label] ?? { status: 'pending' as const };
        let next: AreaStatus;
        if (e.type === 'start') next = { ...cur, status: 'running' };
        else if (e.type === 'log') next = { ...cur, lastLog: e.line };
        else if (e.type === 'done') {
          next = {
            ...cur,
            status: 'done',
            decision: 'decision' in e ? e.decision : undefined,
            filesChanged: 'filesChanged' in e ? e.filesChanged : undefined,
          };
        }
        else next = { ...cur, status: 'error', lastLog: e.error };
        return { ...prev, [e.label]: next };
      });
    };
    events.on('progress', onProgress);
    return () => {
      events.off('progress', onProgress);
    };
  }, [events]);

  const entries = Object.values(statuses);
  const done = entries.filter((s) => s.status === 'done' || s.status === 'error').length;
  const running = Object.entries(statuses).filter(([, s]) => s.status === 'running');
  // Cap the failure list: a wholly broken adapter fails every area, and an
  // unbounded list would push the counter row off a short terminal.
  const errored = Object.entries(statuses).filter(([, s]) => s.status === 'error').slice(0, 5);
  const approved = entries.filter((s) => s.decision === 'approve').length;
  const revised = entries.filter((s) => s.decision === 'revise').length;
  const rejected = entries.filter((s) => s.decision === 'reject').length;
  const failed = entries.filter((s) => s.status === 'error').length;
  const edited = entries.filter((s) => s.status === 'done' && (s.filesChanged ?? 0) > 0).length;
  const touched = entries.reduce((sum, s) => sum + (s.filesChanged ?? 0), 0);
  const title = mode === 'fix' ? 'Review fix pass' : 'Codebase audit';

  return (
    <Box flexDirection="column">
      <Text>
        <Spinner />
        <Text bold>{` ${title} · ${done}/${areas.length} areas · concurrency ${concurrency}`}</Text>
      </Text>
      {running.map(([label, s]) => (
        <Text key={label} color={theme.dim}>
          {'  '}
          <Spinner />
          {` ${sanitizeTerminalText(label)}`}
          {s.lastLog ? `  ${truncate(sanitizeTerminalText(s.lastLog), 48)}` : ''}
        </Text>
      ))}
      {/* Failures carry the reason they failed. Showing only the counter left the
          operator with "16 failed" and nothing to act on. (AGT-3990) */}
      {errored.map(([label, s]) => (
        <Text key={label} color={theme.warn}>
          {`  ${ICON.warn} ${sanitizeTerminalText(label)}`}
          {s.lastLog ? `  ${truncate(sanitizeTerminalText(s.lastLog), 64)}` : ''}
        </Text>
      ))}
      <Text color={theme.dim}>
        {'  '}
        {mode === 'fix' ? (
          <Text color={theme.ok}>{`${ICON.ok} ${edited} edited · ${touched} files`}</Text>
        ) : (
          <Text>
            <Text color={theme.ok}>{`${ICON.ok} ${approved} done`}</Text>
            {' · '}
            <Text color={theme.accentAlt}>{`${ICON.revise} ${revised} revise`}</Text>
            {' · '}
            <Text color={theme.err}>{`${ICON.fail} ${rejected} reject`}</Text>
          </Text>
        )}
        {failed ? (
          <Text>
            {' · '}
            <Text color={theme.warn}>{`${ICON.warn} ${failed} failed`}</Text>
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}
