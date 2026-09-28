// StageTimeline — pipeline:stage events as a timeline (EPIC INT-1813 S5).
// Presentational: takes already-reduced stage entries (parity with the
// dashboard's renderStages).
import { Box, Text, useStdout } from 'ink';
import { memo } from 'react';
import { STATUS } from '../theme.js';
import { oneLine, truncateLine } from '../../cli/reviewProgress.js';
import type { StatusKind } from '../../support/glyphs.js';
import type { StageEntry } from '../pipelineEvents.js';
import { sanitizeTerminalText } from '../sanitize.js';

// Single-sourced glyphs + colors (INT-2260): running → ◐, complete → ✓, fail → ✗.
const KIND: Record<StageEntry['status'], StatusKind> = { start: 'running', complete: 'ok', fail: 'err' };

export interface StageTimelineProps {
  stages: StageEntry[];
  max?: number;
}

// Memoized so a log-only pipeline update (unchanged `stages` identity) skips
// re-rendering the timeline, cutting per-commit work during SSE bursts. (INT-2407)
export const StageTimeline = memo(function StageTimeline({ stages, max = 12 }: StageTimelineProps) {
  const { stdout } = useStdout();
  const shown = max > 0 ? stages.slice(-max) : [];
  // One stage is one row: a stage name/model/decision from the event stream may
  // hold newlines or run past the terminal, which would wrap it into many rows.
  // Budget: `◐ ` prefix + the reserved last column. (AGT-3458)
  const maxWidth = Math.max(10, (stdout?.columns ?? 80) - 3);
  return (
    <Box flexDirection="column">
      <Text bold>Pipeline stages</Text>
      {shown.length === 0 ? (
        <Text dimColor>(no stage activity yet)</Text>
      ) : (
        shown.map((s, i) => {
          const dur = s.durationMs ? ` ${Math.round(s.durationMs / 1000)}s` : '';
          const model = s.model ? ` (${sanitizeTerminalText(s.model)})` : '';
          const decision = s.decision ? ` → ${sanitizeTerminalText(s.decision)}` : '';
          const st = STATUS[KIND[s.status]];
          return (
            <Text key={i} color={st.color}>
              {truncateLine(oneLine(`${st.icon} ${sanitizeTerminalText(s.stage)}${model}${dur}${decision}`), maxWidth)}
            </Text>
          );
        })
      )}
    </Box>
  );
});
