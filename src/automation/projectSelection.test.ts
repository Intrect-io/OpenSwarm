// project-selection persistence: "disable all" must survive a daemon restart. (INT-2208)
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { loadProjectSelection, saveProjectSelection } from './runnerState.js';

describe('project selection persistence (INT-2208)', () => {
  const tmp = join(mkdtempSync(join(tmpdir(), 'os-proj-sel-')), 'project-selection.json');
  afterEach(() => {
    try {
      rmSync(tmp);
    } catch {
      /* already gone */
    }
  });

  it('round-trips enabled + touched through disk', () => {
    saveProjectSelection({ enabled: ['/x/a', '/x/b'], touched: true }, tmp);
    expect(loadProjectSelection(tmp)).toEqual({ enabled: ['/x/a', '/x/b'], touched: true });
  });

  it('persists an empty-but-touched selection (disabled everything → nothing runs)', () => {
    saveProjectSelection({ enabled: [], touched: true }, tmp);
    const restored = loadProjectSelection(tmp);
    expect(restored.enabled).toEqual([]);
    expect(restored.touched).toBe(true); // the key: empty stays "touched" so the fallback doesn't return
  });

  it('returns a safe default when the file is absent', () => {
    expect(loadProjectSelection(join(tmpdir(), 'os-nonexistent-xyz.json'))).toEqual({ enabled: [], touched: false });
  });

  it('tolerates corrupt JSON → default', () => {
    writeFileSync(tmp, '{ not json', 'utf8');
    expect(loadProjectSelection(tmp)).toEqual({ enabled: [], touched: false });
  });
});
