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
