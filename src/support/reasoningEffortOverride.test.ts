import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyReasoningEffortOverride,
  readReasoningEffortOverride,
  writeReasoningEffortOverride,
} from './reasoningEffortOverride.js';

describe('reasoning effort override', () => {
  it('round-trips a persisted effort and clears back to provider defaults', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'openswarm-effort-')), 'override.json');
    writeReasoningEffortOverride('high', path);
    expect(readReasoningEffortOverride(path)).toBe('high');
    writeReasoningEffortOverride(undefined, path);
    expect(readReasoningEffortOverride(path)).toBeUndefined();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ effort: null });
  });

  it('lets the Supervisor override win over a caller default', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'openswarm-effort-')), 'override.json');
    writeReasoningEffortOverride('high', path);
    const options = { reasoningEffort: 'low' as const, model: 'x' };
    const result = applyReasoningEffortOverride(options, path);
    expect(result.model).toBe('x');
    expect(result.reasoningEffort).toBe('high');
  });
});
