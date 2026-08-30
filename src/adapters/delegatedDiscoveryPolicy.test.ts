import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { ClaudeCliAdapter } from './claude.js';
import { CodexCliAdapter } from './codex.js';
import { CursorCliAdapter } from './cursor.js';
import { configureHumanSurfaceReadOnly } from '../mcp/humanSurfacePolicy.js';

afterEach(() => {
  configureHumanSurfaceReadOnly(false);
  vi.clearAllMocks();
});

describe('delegated adapter discovery policy', () => {
  it('does not execute PATH tools or inspect live catalogs in strict mode', async () => {
    configureHumanSurfaceReadOnly(true);
    const codex = new CodexCliAdapter();
    const claude = new ClaudeCliAdapter();
    const cursor = new CursorCliAdapter();

    await expect(codex.isAvailable()).resolves.toBe(false);
    await expect(codex.listModels()).resolves.toEqual([]);
    await expect(claude.isAvailable()).resolves.toBe(false);
    await expect(cursor.isAvailable()).resolves.toBe(false);
    await expect(cursor.listModels()).resolves.toEqual([]);
    await expect(cursor.getDefaultModel()).resolves.toBe('auto');

    expect(execFileMock).not.toHaveBeenCalled();
  });
});
