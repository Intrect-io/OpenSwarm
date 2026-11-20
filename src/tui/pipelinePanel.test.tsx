import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { StageTimeline } from './components/StageTimeline.js';
import { LiveLog } from './components/LiveLog.js';
import { PipelinePanel } from './panels/PipelinePanel.js';
import type { StageEntry } from './pipelineEvents.js';

describe('StageTimeline', () => {
  it('shows an empty state', () => {
    expect(render(<StageTimeline stages={[]} />).lastFrame()).toContain('no stage activity');
  });

  it('renders a stage with model, duration and decision', () => {
    const stages: StageEntry[] = [
      { taskId: 't', stage: 'reviewer', status: 'complete', model: 'sonnet', durationMs: 5000, decision: 'approve' },
    ];
    const f = render(<StageTimeline stages={stages} />).lastFrame()!;
    expect(f).toContain('reviewer');
    expect(f).toContain('sonnet');
    expect(f).toContain('5s');
    expect(f).toContain('approve');
  });

  it('renders each stage as one bounded row even when fields carry line breaks', () => {
    const stages: StageEntry[] = [
      { taskId: 't', stage: 'worker\nINJECTED ROW', status: 'start', model: 'gpt\r\nx', decision: `revise\n${'d'.repeat(400)}` },
      { taskId: 't', stage: 'reviewer', status: 'complete' },
    ];
    const f = render(<StageTimeline stages={stages} />).lastFrame()!;
    const lines = f.split('\n');
    // header + exactly one row per stage
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('worker INJECTED ROW');
    expect(lines[1]).toContain('(gpt x)');
    expect(lines[1]).toContain('\u2026');
    expect(lines[2]).toContain('reviewer');
  });
});

describe('LiveLog', () => {
  it('shows an empty state and then lines', () => {
    expect(render(<LiveLog logs={[]} />).lastFrame()).toContain('no log output');
    expect(render(<LiveLog logs={['[worker] hi']} />).lastFrame()).toContain('[worker] hi');
  });
});

describe('PipelinePanel', () => {
  it('renders idle (no port) with both sections', () => {
    const f = render(<PipelinePanel />).lastFrame()!;
    expect(f).toContain('daemon port unknown');
    expect(f).toContain('Pipeline stages');
    expect(f).toContain('Live log');
  });
});
