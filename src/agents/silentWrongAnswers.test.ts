// ============================================
// OpenSwarm - defects that produce a wrong answer silently
// ============================================
//
// None of these three threw, logged, or failed a check. Each one just returned
// the wrong thing, which is why they survived several audit rounds.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { addMessage, cancelSession, clearAllSessions, createPairSession, getSessionHistory } from './agentPair.js';
import { runGuards } from './pipelineGuards.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A git repo whose HEAD already declares `literal`, with an unstaged test that uses it. */
async function repoWithLiteralInHead(literal: string): Promise<string> {
  const repo = tempRoot('openswarm-guard-');
  writeFileSync(join(repo, 'app.ts'), `export const header = ${JSON.stringify(literal)};\n`);
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: repo });
  await execFileAsync('git', ['add', '.'], { cwd: repo });
  await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });

  writeFileSync(
    join(repo, 'app.test.ts'),
    `it('sends the header', () => { expect(req.headers).toContain(${JSON.stringify(literal)}); });\n`,
  );
  return repo;
}

const workerResult = {
  success: true,
  summary: 'added a test',
  filesChanged: ['app.test.ts'],
  commands: [],
  output: '',
};

describe('contractEvidence guard with a literal that looks like an option', () => {
  // literalExistsInHeadSource asks git whether the literal exists in HEAD.
  // Without `-e`, git parses a literal beginning with `-` as an option and
  // exits with "unknown option"; the catch turns that into "not present in
  // HEAD". This guard is blocking, so the pipeline rejected correct work.
  it('does not flag a literal that HEAD already declares', async () => {
    const repo = await repoWithLiteralInHead('--x-trace-id:');

    const result = await runGuards(workerResult as never, repo, { contractEvidenceCheck: true });

    const contract = result.results.find((r) => r.guard === 'contractEvidence');
    expect(contract?.issues ?? []).toEqual([]);
  }, 30_000);

  // The guard must still do its job for a literal that is genuinely new, or
  // "stop blocking correct work" would just mean "stop checking".
  it('still flags a literal that appears only in the test', async () => {
    const repo = await repoWithLiteralInHead('--x-trace-id:');
    writeFileSync(
      join(repo, 'app.test.ts'),
      `it('sends it', () => { expect(req.headers).toContain("--x-invented-header:"); });\n`,
    );

    const result = await runGuards(workerResult as never, repo, { contractEvidenceCheck: true });

    const contract = result.results.find((r) => r.guard === 'contractEvidence');
    expect((contract?.issues ?? []).join('\n')).toContain('--x-invented-header:');
  }, 30_000);
});

describe('cancelSession', () => {
  const newSession = () =>
    createPairSession({
      taskId: `task-${Math.random().toString(36).slice(2)}`,
      taskTitle: 'do a thing',
      taskDescription: 'details',
      projectPath: '/repo',
    });

  beforeEach(() => clearAllSessions());
  afterEach(() => clearAllSessions());

  // Moving to a terminal status archives the session, and archiving removes it
  // from the live map — so a message added afterwards was silently dropped and
  // the cancellation notice never reached the transcript the user reads.
  it('records why the session ended', () => {
    const session = newSession();

    expect(cancelSession(session.id)).toBe(true);

    const archived = getSessionHistory(10).find((s) => s.id === session.id);
    expect(archived?.status).toBe('cancelled');
    expect(archived?.messages.some((m) => /cancelled/i.test(m.content))).toBe(true);
  });

  it('refuses to cancel a session that already ended', () => {
    const session = newSession();
    expect(cancelSession(session.id)).toBe(true);
    expect(cancelSession(session.id)).toBe(false);
  });

  it('is a no-op for an unknown session', () => {
    expect(cancelSession('does-not-exist')).toBe(false);
  });

  // Guards the ordering directly: anything added after archiving is lost, so
  // the archived transcript must already be complete.
  it('carries earlier messages into the archive', () => {
    const session = newSession();
    addMessage(session.id, 'worker', 'partial progress');

    cancelSession(session.id);

    const archived = getSessionHistory(10).find((s) => s.id === session.id);
    expect(archived?.messages.map((m) => m.content)).toContain('partial progress');
  });
});

describe('AgentBus.publish', () => {
  let home: string;

  /** Load AgentBus with BUS_DIR pointed at a temp home (it is module-level). */
  async function loadBus() {
    vi.resetModules();
    vi.doMock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:os')>();
      return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
    });
    vi.doMock('os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:os')>();
      return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
    });
    return await import('./agentBus.js');
  }

  beforeEach(() => {
    home = tempRoot('openswarm-bus-home-');
  });

  afterEach(() => {
    vi.doUnmock('node:os');
    vi.doUnmock('os');
  });

  const messagesDir = (executionId: string) => resolve(home, '.openswarm/bus', executionId, 'messages');

  // A polling loop cannot reliably catch the window, so this watches the
  // directory and reads each file the instant its name appears — which is
  // exactly what an in-place write exposes and a rename does not. Measured
  // against a plain fs.writeFile of this size, a watcher observes the file
  // empty or truncated every time.
  it('never exposes a message file before its contents are complete', async () => {
    const { AgentBus } = await loadBus();
    const bus = new AgentBus('exec-1');
    await bus.init('wf-1');

    const dir = messagesDir('exec-1');
    const partial: string[] = [];
    let complete = 0;
    const watcher = watch(dir, (_event, name) => {
      if (!name || !name.toString().endsWith('.json')) return;
      let raw: string;
      try {
        raw = readFileSync(join(dir, name.toString()), 'utf-8');
      } catch {
        return; // the rename has not landed yet — nothing is visible, which is correct
      }
      if (raw.length === 0) { partial.push(`${name} empty`); return; }
      try {
        JSON.parse(raw);
        complete++;
      } catch {
        partial.push(`${name} truncated at ${raw.length} bytes`);
      }
    });

    try {
      const big = 'x'.repeat(20_000_000);
      await Promise.all(
        Array.from({ length: 4 }, (_, i) => bus.publish('context_update', 'planner', { big, i })),
      );
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      watcher.close();
    }

    expect(partial).toEqual([]);
    expect(complete).toBeGreaterThan(0);
  }, 30_000);

  it('leaves no temp files behind', async () => {
    const { AgentBus } = await loadBus();
    const bus = new AgentBus('exec-2');
    await bus.init('wf-2');
    await bus.publish('context_update', 'planner', { note: 'small' });

    const files = await readdir(messagesDir('exec-2'));
    expect(files.every((f) => f.endsWith('.json'))).toBe(true);
  });
});
