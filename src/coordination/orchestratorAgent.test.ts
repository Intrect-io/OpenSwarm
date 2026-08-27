import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from '../adapters/tools.js';
import { buildOrchestratorObjective } from './orchestratorAgent.js';

const spawnCli = vi.hoisted(() => vi.fn(async () => ({ exitCode: 0, stdout: 'coordinated', stderr: '', durationMs: 1 })));
const getMcpTools = vi.hoisted(() => vi.fn());
vi.mock('../adapters/index.js', () => ({ getAdapter: () => ({ name: 'codex' }), spawnCli }));
vi.mock('../mcp/mcpClient.js', () => ({ getMcpTools }));

const tool = (name: string): ToolDefinition => ({ type: 'function', function: { name, description: '', parameters: { type: 'object' } } });

// vitest.setup.ts points this at a temp path; restore it rather than deleting,
// so a later suite in this worker never falls back to the real ~/.openswarm store.
const ORIGINAL_COORDINATION_FILE = process.env.OPENSWARM_COORDINATION_FILE;
let dir = '';
afterEach(async () => {
  vi.clearAllMocks();
  (await import('./coordinationStore.js')).resetCoordinationStoreForTests();
  process.env.OPENSWARM_COORDINATION_FILE = ORIGINAL_COORDINATION_FILE;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('buildOrchestratorObjective', () => {
  const event = (over: Record<string, unknown> = {}) => ({
    id: 'e', seq: 1, timestamp: 0, repository: '/repo', taskId: 't1',
    actor: 'magos-corvax-vigilis', actorName: 'Magos Corvax-Vigilis',
    recipient: 'human', kind: 'human-question', status: 'waiting',
    correlationId: 'c1', summary: 'Which API version?', fingerprint: 'f', ...over,
  }) as never;

  it('does not schedule a sweep with nothing pending', () => {
    expect(buildOrchestratorObjective([])).toBeNull();
  });

  it('addresses each pending item by the call sign that raised it', () => {
    const objective = buildOrchestratorObjective([event({ kind: 'advice-request', status: 'open' })]);
    expect(objective).toContain('Magos Corvax-Vigilis');
    expect(objective).toContain('Which API version?');
    expect(objective).toContain('advice-request/open');
  });

  it('does not spend a sweep on questions only the operator can answer', () => {
    // A human-question stays waiting until someone replies in Discord; the
    // orchestrator has no way to settle it, so a sweep over it can only
    // conclude "still waiting" at the price of a provider call.
    expect(buildOrchestratorObjective([event()])).toBeNull();
    const mixed = buildOrchestratorObjective([event(), event({ kind: 'advice-request', status: 'open', summary: 'Reuse the auth helper?' })]);
    expect(mixed).toContain('Reuse the auth helper?');
    expect(mixed).not.toContain('Which API version?');
  });
});

describe('runOrchestrator', () => {
  it('grants only policy-approved MCP tools and never runs in the repository tree', async () => {
    dir = mkdtempSync(join(tmpdir(), 'osw-orchestrator-'));
    process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'events.json');
    (await import('./coordinationStore.js')).resetCoordinationStoreForTests();
    getMcpTools.mockResolvedValue([tool('github__get_issue'), tool('cloudflare__delete_worker'), tool('evil__read')]);
    const { runOrchestrator } = await import('./orchestratorAgent.js');

    const result = await runOrchestrator({
      repository: '/repo',
      taskId: 'coordination',
      objective: 'Balance worker load',
      policy: { servers: ['github', 'cloudflare'] },
    });

    expect(result.toolsGranted).toEqual(['github__get_issue']);
    expect(result.toolsDenied.map((entry) => entry.name)).toEqual(['cloudflare__delete_worker', 'evil__read']);
    const passed = spawnCli.mock.calls[0][1] as { cwd: string; mcpTools: ToolDefinition[]; readOnly?: boolean };
    expect(passed.cwd).not.toBe('/repo');
    expect(passed.cwd.startsWith(tmpdir())).toBe(true);
    expect(passed.mcpTools.map((entry) => entry.function.name)).toEqual(['github__get_issue']);
  });

  it('withholds the shell, which the scratch directory alone does not do', async () => {
    // `bash` is not path-checked, so an isolated cwd is only half the fence for
    // the one agent holding GitHub, Linear, and Cloudflare credentials at once.
    dir = mkdtempSync(join(tmpdir(), 'osw-orchestrator-shell-'));
    process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'events.json');
    (await import('./coordinationStore.js')).resetCoordinationStoreForTests();
    getMcpTools.mockResolvedValue([tool('github__get_issue')]);
    const { runOrchestrator } = await import('./orchestratorAgent.js');

    await runOrchestrator({ repository: '/repo', taskId: 'coordination', objective: 'x', policy: { servers: ['github'] } });

    const passed = spawnCli.mock.calls[0][1] as { shellTools?: boolean };
    expect(passed.shellTools).toBe(false);
  });
});
