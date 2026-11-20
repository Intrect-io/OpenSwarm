import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveChecks,
  resolveProjectChecks,
  parseFailingFiles,
  deriveFixAreas,
  buildFixCheckTask,
  runFixCommand,
  type Check,
  type CheckOutcome,
  type FixArea,
  type ProjectProbe,
} from './fixCommand.js';

// defaultRunFixWorker dynamically imports runWorker; mock it so the default fix
// path is exercised without spawning a real agent. Only the timeout test drives
// this path (every other test injects runFixWorker). (INT-2447)
const runWorkerMock = vi.hoisted(() => vi.fn());
vi.mock('../agents/worker.js', () => ({ runWorker: runWorkerMock }));

// Spy on execFile so the default check runner's options can be inspected. It
// delegates to the real execFile unless a test overrides the implementation.
const childProcess = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  childProcess.execFile.mockImplementation(actual.execFile as never);
  return { ...actual, execFile: childProcess.execFile };
});

describe('resolveChecks (INT-2267)', () => {
  const scripts = { lint: 'oxlint src/', typecheck: 'tsc --noEmit', build: 'tsc', test: 'vitest run', dev: 'x' };

  it('defaults to the standard checks that have a script, in order', () => {
    expect(resolveChecks(scripts).map((c) => c.key)).toEqual(['lint', 'typecheck', 'build', 'test']);
  });

  it('maps requested keys (incl. the `type` alias) and drops unknown/missing', () => {
    expect(resolveChecks(scripts, ['type', 'test', 'nope']).map((c) => c.key)).toEqual(['typecheck', 'test']);
  });

  it('resolves to `npm run <script>`', () => {
    expect(resolveChecks(scripts, ['lint'])[0]).toEqual({ key: 'lint', program: 'npm', args: ['run', 'lint'] });
  });

  it('drops a requested check with no matching script', () => {
    expect(resolveChecks({ test: 'vitest' }, ['lint', 'test']).map((c) => c.key)).toEqual(['test']);
  });
});

describe('resolveProjectChecks (INT-2303)', () => {
  const py = { marker: true, ruff: true, mypy: true, pytest: true };

  it('prefers openswarm.json checks over everything, preserving key order, via sh -c', () => {
    const probe: ProjectProbe = {
      configChecks: { test: 'pytest -x', lint: 'ruff check .' },
      npmScripts: { test: 'vitest' },
      cargo: true,
      python: py,
    };
    const checks = resolveProjectChecks(probe);
    expect(checks.map((c) => c.key)).toEqual(['test', 'lint']);
    expect(checks[0]).toEqual({ key: 'test', program: 'sh', args: ['-c', 'pytest -x'], display: 'pytest -x' });
  });

  it('filters config checks by --checks, accepting raw keys and aliases', () => {
    const probe: ProjectProbe = { configChecks: { typecheck: 'mypy .', test: 'pytest' } };
    expect(resolveProjectChecks(probe, ['type']).map((c) => c.key)).toEqual(['typecheck']);
    expect(resolveProjectChecks(probe, ['test', 'nope']).map((c) => c.key)).toEqual(['test']);
  });

  it('falls back to npm scripts when no config checks', () => {
    const probe: ProjectProbe = { npmScripts: { test: 'vitest run' }, cargo: true };
    expect(resolveProjectChecks(probe)).toEqual([{ key: 'test', program: 'npm', args: ['run', 'test'] }]);
  });

  it('resolves Cargo defaults (check + test, skipping clippy/build)', () => {
    const checks = resolveProjectChecks({ cargo: true });
    expect(checks.map((c) => c.key)).toEqual(['typecheck', 'test']);
    expect(checks[0]).toEqual({ key: 'typecheck', program: 'cargo', args: ['check', '--all-targets'] });
    expect(checks[1]).toEqual({ key: 'test', program: 'cargo', args: ['test'] });
  });

  it('resolves clippy/build for Cargo when explicitly requested', () => {
    const checks = resolveProjectChecks({ cargo: true }, ['lint', 'build']);
    expect(checks[0].args[0]).toBe('clippy');
    expect(checks[1].args).toEqual(['build']);
  });

  it('gates Python defaults on per-tool config', () => {
    const all = resolveProjectChecks({ python: py });
    expect(all.map((c) => c.key)).toEqual(['lint', 'typecheck', 'test']);
    expect(all.map((c) => c.program)).toEqual(['ruff', 'mypy', 'pytest']);

    const pytestOnly = resolveProjectChecks({ python: { marker: true, ruff: false, mypy: false, pytest: true } });
    expect(pytestOnly.map((c) => c.key)).toEqual(['test']);
  });

  it('lets --checks bypass the Python gating', () => {
    const checks = resolveProjectChecks({ python: { marker: true, ruff: false, mypy: false, pytest: false } }, ['lint']);
    expect(checks).toEqual([{ key: 'lint', program: 'ruff', args: ['check', '.'] }]);
  });

  it('returns [] for an empty probe', () => {
    expect(resolveProjectChecks({})).toEqual([]);
    expect(resolveProjectChecks({ python: { marker: false, ruff: true, mypy: true, pytest: true } })).toEqual([]);
  });
});

describe('parseFailingFiles (INT-2267)', () => {
  it('extracts paths from tsc / vitest / eslint output and dedupes', () => {
    const out = [
      'src/cli/fixCommand.ts(12,5): error TS2322: bad',
      ' FAIL  src/cli/fixCommand.test.ts > x',
      'src/cli/fixCommand.ts:40:1  error  no-unused',
      './lib/util.py:3: E501',
    ].join('\n');
    const files = parseFailingFiles(out).sort();
    expect(files).toEqual(['lib/util.py', 'src/cli/fixCommand.test.ts', 'src/cli/fixCommand.ts']);
  });

  it('ignores absolute paths without a repository boundary', () => {
    expect(parseFailingFiles('all good, no files here')).toEqual([]);
    expect(parseFailingFiles('/usr/lib/node/x.js failed')).toEqual([]);
  });

  it('normalizes absolute paths inside the project and rejects external paths', () => {
    const root = '/work/repo';
    const output = '/work/repo/src/app.ts(2,1): error\n/usr/lib/node/x.js failed';
    expect(parseFailingFiles(output, root)).toEqual(['src/app.ts']);
  });

  it('extracts paths from cargo and pytest output (INT-2303)', () => {
    const out = [
      'error[E0308]: mismatched types',
      ' --> src/main.rs:12:9',
      'FAILED tests/test_auth.py::test_login - AssertionError',
      'tests/test_auth.py:42: in test_login',
    ].join('\n');
    expect(parseFailingFiles(out).sort()).toEqual(['src/main.rs', 'tests/test_auth.py']);
  });
});

describe('deriveFixAreas (INT-2267)', () => {
  const oc = (key: string, files: string[], output = 'boom'): CheckOutcome => ({ key, passed: false, output, files });

  it('partitions blamed files into areas and attaches relevant failures', () => {
    const areas = deriveFixAreas([oc('typecheck', ['src/a/x.ts', 'src/b/y.ts'])], 4, 12);
    expect(areas.length).toBeGreaterThanOrEqual(1);
    expect(areas.flatMap((a) => a.files).sort()).toEqual(['src/a/x.ts', 'src/b/y.ts']);
    expect(areas[0].failures.join('')).toContain('[typecheck]');
  });

  it('makes a check:<key> area for a failing check with no parseable files', () => {
    const areas = deriveFixAreas([oc('build', [], 'Error: config broken')], 4, 12);
    expect(areas).toHaveLength(1);
    expect(areas[0].label).toBe('check:build');
    expect(areas[0].files).toEqual([]);
    expect(areas[0].failures[0]).toContain('config broken');
  });
});

describe('buildFixCheckTask (INT-2267)', () => {
  const area: FixArea = { label: 'src/a', dir: 'src/a', files: ['src/a/x.ts'], failures: ['[typecheck]\nTS2322'] };
  const checks: Check[] = [{ key: 'typecheck', program: 'npm', args: ['run', 'typecheck'] }];

  it('scopes to the files, includes the failure, and forbids cheating', () => {
    const t = buildFixCheckTask(area, checks);
    expect(t).toContain('src/a/x.ts');
    expect(t).toContain('TS2322');
    expect(t).toContain('npm run typecheck');
    expect(t.toLowerCase()).toContain('do not');
  });

  it('uses the display command for sh -c config checks (INT-2303)', () => {
    const cfg: Check[] = [{ key: 'test', program: 'sh', args: ['-c', 'pytest -x'], display: 'pytest -x' }];
    const t = buildFixCheckTask(area, cfg);
    expect(t).toContain('Re-run `pytest -x`');
    expect(t).not.toContain('sh -c');
  });
});

describe('runFixCommand loop (INT-2267)', () => {
  const checks: Check[] = [{ key: 'test', program: 'npm', args: ['run', 'test'] }];
  const silent = { log: () => {}, exists: () => true, checks, recordOutcome: async () => {} };

  it('returns green without fixing when everything passes', async () => {
    const runFixWorker = vi.fn();
    const report = await runFixCommand(
      { rounds: 3 },
      { ...silent, runCheck: async () => ({ passed: true, output: '' }), runFixWorker },
    );
    expect(report.green).toBe(true);
    expect(report.reason).toBe('green');
    expect(runFixWorker).not.toHaveBeenCalled();
  });

  it('converges: fail → fix → pass', async () => {
    let pass = false;
    const runFixWorker = vi.fn(async () => {
      pass = true; // the fix makes the next check pass
      return { success: true, filesChanged: ['src/a/x.ts'] };
    });
    const report = await runFixCommand(
      { rounds: 3 },
      { ...silent, runCheck: async () => ({ passed: pass, output: 'src/a/x.ts:1 fail' }), runFixWorker },
    );
    expect(report.green).toBe(true);
    expect(runFixWorker).toHaveBeenCalledTimes(1);
    expect(report.rounds).toHaveLength(2);
  });

  it('stops on no progress (same failures, no edits)', async () => {
    const report = await runFixCommand(
      { rounds: 5 },
      {
        ...silent,
        runCheck: async () => ({ passed: false, output: 'src/a/x.ts:1 fail' }),
        runFixWorker: async () => ({ success: false, filesChanged: [] }),
      },
    );
    expect(report.green).toBe(false);
    expect(report.reason).toBe('no-progress');
  });

  it('gives up after the round budget when it keeps editing but never passes', async () => {
    const report = await runFixCommand(
      { rounds: 2 },
      {
        ...silent,
        runCheck: async () => ({ passed: false, output: 'src/a/x.ts:1 fail' }),
        runFixWorker: async () => ({ success: true, filesChanged: ['src/a/x.ts'] }),
      },
    );
    expect(report.green).toBe(false);
    expect(report.reason).toBe('out-of-rounds');
  });

  it('reports no-checks when nothing resolves', async () => {
    const report = await runFixCommand({}, { log: () => {}, checks: [] });
    expect(report.reason).toBe('no-checks');
  });

  describe('fix worker timeout (INT-2447)', () => {
    // No injected runFixWorker → the default path runs → defaultRunFixWorker →
    // the mocked runWorker, whose options we inspect.
    const base = {
      log: () => {},
      exists: () => true,
      checks,
      recordOutcome: async () => {},
      runCheck: async () => ({ passed: false, output: 'src/a/x.ts:1 fail' }),
    };
    beforeEach(() => {
      runWorkerMock.mockReset().mockResolvedValue({ success: true, filesChanged: [] });
    });

    it('defaults the fix worker timeout to 15 minutes, not the 5-min adapter default', async () => {
      await runFixCommand({ rounds: 2 }, base);
      expect(runWorkerMock).toHaveBeenCalled();
      expect(runWorkerMock.mock.calls[0][0].timeoutMs).toBe(900_000);
    });

    it('honors an explicit --timeout override', async () => {
      await runFixCommand({ rounds: 2, timeoutMs: 123_456 }, base);
      expect(runWorkerMock.mock.calls[0][0].timeoutMs).toBe(123_456);
    });
  });

  it('emits start/done/error to the live board during the fan-out (INT-2446)', async () => {
    const events: Array<{ type: string; label: string }> = [];
    const board = { emit: (e: { type: string; label: string }) => events.push({ type: e.type, label: e.label }), unmount: () => {} };
    await runFixCommand(
      { rounds: 2, concurrency: 2 },
      {
        ...silent,
        // two files in two dirs → two areas; one worker succeeds, one throws
        runCheck: async () => ({ passed: false, output: 'src/a/x.ts:1 fail\nsrc/b/y.ts:2 fail' }),
        runFixWorker: async (area) => {
          if (area.label === 'src/b') throw new Error('worker died');
          return { success: true, filesChanged: ['src/a/x.ts'] };
        },
        renderBoard: () => board,
      },
    );
    expect(events.filter((e) => e.type === 'start').map((e) => e.label).sort()).toEqual(['src/a', 'src/b']);
    expect(events.filter((e) => e.type === 'done').map((e) => e.label)).toEqual(['src/a']);
    expect(events.filter((e) => e.type === 'error').map((e) => e.label)).toEqual(['src/b']);
  });

  it('records the outcome into repo knowledge on green after edits (INT-2268)', async () => {
    let pass = false;
    const recordOutcome = vi.fn(async () => {});
    await runFixCommand(
      { rounds: 3 },
      {
        ...silent,
        recordOutcome,
        runCheck: async () => ({ passed: pass, output: 'src/a/x.ts:1 fail' }),
        runFixWorker: async () => {
          pass = true;
          return { success: true, filesChanged: ['src/a/x.ts'] };
        },
      },
    );
    expect(recordOutcome).toHaveBeenCalledTimes(1);
    expect(recordOutcome.mock.calls[0][0].filesChanged).toEqual(['src/a/x.ts']);
  });

  it('does not record when already green (nothing was edited)', async () => {
    const recordOutcome = vi.fn(async () => {});
    await runFixCommand({ rounds: 3 }, { ...silent, recordOutcome, runCheck: async () => ({ passed: true, output: '' }) });
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it('does not record when --no-learn (learn: false)', async () => {
    let pass = false;
    const recordOutcome = vi.fn(async () => {});
    await runFixCommand(
      { rounds: 3, learn: false },
      {
        ...silent,
        recordOutcome,
        runCheck: async () => ({ passed: pass, output: 'src/a/x.ts:1 fail' }),
        runFixWorker: async () => {
          pass = true;
          return { success: true, filesChanged: ['src/a/x.ts'] };
        },
      },
    );
    expect(recordOutcome).not.toHaveBeenCalled();
  });
});

describe('default check runner (AGT-3423)', () => {
  it('runs the objective check with timeout 300000 and maxBuffer 32 MiB', async () => {
    const calls: Array<{ program: string; args: string[]; options: Record<string, unknown> }> = [];
    childProcess.execFile.mockImplementationOnce(((
      program: string,
      args: string[],
      options: Record<string, unknown>,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      calls.push({ program, args, options });
      cb(null, '', '');
      return {};
    }) as never);

    // No injected runCheck, so the default runner calls execFile.
    const report = await runFixCommand(
      { rounds: 1 },
      { log: () => {}, exists: () => true, recordOutcome: async () => {},
        checks: [{ key: 'test', program: 'npm', args: ['run', 'test'] }] },
    );
    expect(report.green).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].program).toBe('npm');
    expect(calls[0].args).toEqual(['run', 'test']);
    expect(calls[0].options.timeout).toBe(300_000);
    expect(calls[0].options.maxBuffer).toBe(32 * 1024 * 1024);
  });
});
