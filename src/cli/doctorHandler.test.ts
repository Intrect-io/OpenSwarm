// AGT-3408: `failedChecks` used to live at module scope and only ever grow —
// a second `handleDoctor()` call in the same process (e.g. the daemon or a
// long-lived shell re-running the CLI module) reported failures from a run
// whose underlying issue was since fixed.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../adapters/index.js', () => ({
  listAvailableAdapters: vi.fn(),
}));
vi.mock('../core/config.js', () => ({
  findConfigFile: () => '/tmp/config.yaml',
}));
vi.mock('../telemetry/telemetry.js', () => ({
  track: vi.fn(async () => {}),
}));
vi.mock('../auth/index.js', () => ({
  AuthProfileStore: class {
    getProfile(): null {
      return null;
    }
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleDoctor failedChecks reset (AGT-3408)', () => {
  it('does not carry a failing check over into the next invocation once it is fixed', async () => {
    const { listAvailableAdapters } = await import('../adapters/index.js');
    const { track } = await import('../telemetry/telemetry.js');
    const { handleDoctor } = await import('./doctorHandler.js');

    // process.exit would otherwise kill the test runner on the fatal run.
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    vi.mocked(listAvailableAdapters).mockResolvedValueOnce([]); // run 1: no usable provider — fails
    await handleDoctor();
    vi.mocked(listAvailableAdapters).mockResolvedValueOnce(['codex']); // run 2: fixed
    await handleDoctor();

    const details = vi.mocked(track).mock.calls.map((call) => call[0].detail);
    expect(details[0]).toContain('providers');
    expect(details[1]).not.toContain('providers');
  });
});

describe('task-state lock evidence line (AGT-4024)', () => {
  it('reports dot-lock-only writer evidence as a warning', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { listAvailableAdapters } = await import('../adapters/index.js');
    const { track } = await import('../telemetry/telemetry.js');
    const { handleDoctor } = await import('./doctorHandler.js');
    const dir = mkdtempSync(join(tmpdir(), 'openswarm-doctor-lock-'));
    const stateFile = join(dir, 'state.json');
    const previous = process.env.OPENSWARM_TASK_STATE_FILE;
    process.env.OPENSWARM_TASK_STATE_FILE = stateFile;
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const lockLine = () => log.mock.calls.map((call) => String(call[0])).find((text) => text.includes('task-state lock')) ?? '';
    try {
      vi.mocked(listAvailableAdapters).mockResolvedValue(['codex']);
      vi.mocked(track).mockClear();
      await handleDoctor();
      expect(lockLine()).toContain('no dot-lock-only writer observed (absence is not proof)');
      expect(vi.mocked(track).mock.calls.at(-1)![0].detail).not.toContain('task-state-lock');

      writeFileSync(`${stateFile}.legacy-writer.json`, JSON.stringify({
        firstSeenAt: '2026-11-01T00:00:00.000Z', lastSeenAt: '2026-11-20T12:34:56.000Z', pid: 4242, ns: null,
      }));
      log.mockClear();
      await handleDoctor();
      expect(lockLine()).toContain('dot-lock-only (<=0.24.4) writer observed, last seen 2026-11-20T12:34:56.000Z; CLI floor has not moved');
      expect(vi.mocked(track).mock.calls.at(-1)![0].detail).toContain('task-state-lock');
      expect(vi.mocked(track).mock.calls.at(-1)![0].isError).toBe(false);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.OPENSWARM_TASK_STATE_FILE;
      else process.env.OPENSWARM_TASK_STATE_FILE = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
