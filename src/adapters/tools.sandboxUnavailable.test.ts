// ============================================
// OpenSwarm - workerSandbox "on" without a sandbox fails closed (AGT-4783)
// ============================================
//
// A host with no sandbox-exec/bwrap used to warn once and run the worker's
// shell unfenced. Kept in its own file because it replaces the sandbox wrapper
// for the whole module graph.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../support/osSandbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../support/osSandbox.js')>()),
  wrapForSandbox: () => null,
}));

const { executeTool, SANDBOX_UNAVAILABLE_MESSAGE } = await import('./tools.js');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const call = (command: string) => ({ id: 'tc-1', function: { name: 'bash', arguments: JSON.stringify({ command }) } });

describe('worker bash with workerSandbox on and no sandbox backend', () => {
  it('refuses the command instead of running it unfenced, and names the opt-out', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'osw-nosandbox-'));
    dirs.push(cwd);
    const res = await executeTool(call('touch ran'), cwd, undefined, { sandbox: 'on' });
    expect(res.is_error).toBe(true);
    expect(res.content).toBe(SANDBOX_UNAVAILABLE_MESSAGE);
    expect(res.content).toContain('autonomous.workerSandbox: off');
    expect(existsSync(path.join(cwd, 'ran'))).toBe(false);
  });

  it('still runs when the operator turned the sandbox off on purpose', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'osw-nosandbox-'));
    dirs.push(cwd);
    const res = await executeTool(call('touch ran'), cwd, undefined, { sandbox: 'off' });
    expect(res.is_error).toBe(false);
    expect(existsSync(path.join(cwd, 'ran'))).toBe(true);
  });
});
