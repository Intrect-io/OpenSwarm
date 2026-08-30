import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnCli = vi.fn();
const adapters = vi.hoisted(() => ({
  codex: { name: 'codex', isAvailable: vi.fn(async () => true), parseWorkerOutput: vi.fn() },
  'cc-router': { name: 'cc-router', isAvailable: vi.fn(async () => true), parseWorkerOutput: vi.fn() },
  cursor: { name: 'cursor', isAvailable: vi.fn(async () => true), parseWorkerOutput: vi.fn() },
}));
vi.mock('../adapters/index.js', () => ({
  getAdapter: (name?: keyof typeof adapters) => adapters[name ?? 'codex'],
  getDefaultAdapterName: () => 'codex',
  probeAdapterAvailability: (adapter: { isAvailable(): Promise<boolean> }) => adapter.isAvailable(),
  spawnCli: (...args: unknown[]) => spawnCli(...args),
}));
vi.mock('../support/gitTracker.js', () => ({ isGitRepo: vi.fn(async () => false), takeSnapshot: vi.fn() }));

const { runWorker } = await import('./worker.js');

const success = { success: true, summary: 'ok', filesChanged: [], commands: [], output: '', noChangesReason: 'nothing to edit' };

describe('worker adapter routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets calls but not implementations: an availability or
    // parse override from one test would silently steer the next one's routing.
    adapters.codex.isAvailable.mockResolvedValue(true);
    adapters['cc-router'].isAvailable.mockResolvedValue(true);
    adapters.cursor.isAvailable.mockResolvedValue(true);
    adapters.codex.parseWorkerOutput.mockReturnValue({ ...success });
    adapters['cc-router'].parseWorkerOutput.mockReturnValue({ ...success });
  });

  it('uses codex only for normal success', async () => {
    spawnCli.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 });
    await runWorker({ taskTitle: 't', taskDescription: 'd', projectPath: '/repo', adapterName: 'codex', adapterRouting: { primary: 'codex', fallbacks: ['cc-router'], allowReasons: ['quota'] } });
    expect(spawnCli).toHaveBeenCalledTimes(1);
    expect(spawnCli.mock.calls[0][0].name).toBe('codex');
  });

  it('routes a typed quota failure to cc-router when permitted', async () => {
    spawnCli.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 });
    adapters.codex.parseWorkerOutput.mockReturnValueOnce({ ...success, success: false, error: 'usage limit reached' });
    const result = await runWorker({ taskTitle: 't', taskDescription: 'd', projectPath: '/repo', adapterName: 'codex', adapterRouting: { primary: 'codex', fallbacks: ['cc-router'], allowReasons: ['quota'] } });
    expect(result.success).toBe(true);
    expect(spawnCli.mock.calls.map((call) => call[0].name)).toEqual(['codex', 'cc-router']);
  });

  it('routes past an unavailable primary without spending a run on it', async () => {
    spawnCli.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 });
    adapters.codex.isAvailable.mockResolvedValue(false);
    const result = await runWorker({ taskTitle: 't', taskDescription: 'd', projectPath: '/repo', adapterName: 'codex', adapterRouting: { primary: 'codex', fallbacks: ['cc-router'], allowReasons: ['capability'] } });
    expect(result.success).toBe(true);
    expect(spawnCli.mock.calls.map((call) => call[0].name)).toEqual(['cc-router']);
  });

  it('still tries an unavailable primary when capability routing is not permitted', async () => {
    spawnCli.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 });
    adapters.codex.isAvailable.mockResolvedValue(false);
    await runWorker({ taskTitle: 't', taskDescription: 'd', projectPath: '/repo', adapterName: 'codex', adapterRouting: { primary: 'codex', fallbacks: ['cc-router'], allowReasons: ['quota'] } });
    expect(spawnCli.mock.calls[0][0].name).toBe('codex');
  });

  it('does not treat a blocking operator question as a routable failure', async () => {
    // The question is provider-independent: cc-router would run the same worker
    // into the same unanswered decision.
    spawnCli.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, blockedOnOperator: true });
    adapters.codex.parseWorkerOutput.mockReturnValueOnce({ ...success });
    const result = await runWorker({ taskTitle: 't', taskDescription: 'd', projectPath: '/repo', adapterName: 'codex', adapterRouting: { primary: 'codex', fallbacks: ['cc-router'], allowReasons: ['quota', 'infra', 'capability'] } });
    expect(result).toMatchObject({ success: false, blockedOnOperator: true });
    expect(result.haltReason).toContain('operator decision');
    expect(spawnCli).toHaveBeenCalledTimes(1);
  });

  it('does not hide a semantic task failure behind another provider', async () => {
    spawnCli.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 });
    adapters.codex.parseWorkerOutput.mockReturnValueOnce({ ...success, success: false, error: 'tests failed' });
    const result = await runWorker({ taskTitle: 't', taskDescription: 'd', projectPath: '/repo', adapterName: 'codex', adapterRouting: { primary: 'codex', fallbacks: ['cc-router'], allowReasons: ['quota', 'infra'] } });
    expect(result.success).toBe(false);
    expect(spawnCli).toHaveBeenCalledTimes(1);
  });
});
