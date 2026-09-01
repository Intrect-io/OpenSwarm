import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => {
  const fn = vi.fn();
  (fn as typeof fn & { [key: symbol]: unknown })[Symbol.for('nodejs.util.promisify.custom')] = (...args: unknown[]) => fn(...args);
  return fn;
});
const fsMock = vi.hoisted(() => ({
  access: vi.fn(),
  cp: vi.fn(),
  lstat: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  ...fsMock,
}));

import {
  codeqlGate,
  ConcurrencyGate,
  resolveCodeqlConcurrency,
  DEFAULT_SECURITY_AUDIT_CONFIG,
  detectCodeqlLanguages,
  listTrackedSecurityFiles,
  newSecurityFindings,
  runSecurityAudit,
  securityFindingFingerprint,
  selectSecuritySourceFiles,
} from './securityAudit.js';

beforeEach(() => {
  vi.stubEnv('PATH', '/tools');
  vi.clearAllMocks();
  // Module state shared by every case here: without this, one test that leaves
  // a slot held makes each later one wait out its full timeout.
  codeqlGate.reset();
  fsMock.access.mockResolvedValue(undefined);
  fsMock.cp.mockResolvedValue(undefined);
  fsMock.lstat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false });
  fsMock.mkdir.mockResolvedValue(undefined);
  fsMock.mkdtemp.mockResolvedValue('/snapshot');
  fsMock.rm.mockResolvedValue(undefined);
  execFileMock.mockResolvedValue({ stdout: '', stderr: '' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('security audit primitives', () => {
  it('maps only supported tracked source languages', () => {
    expect(detectCodeqlLanguages(['src/a.ts', 'lib/b.py', 'tool/c.rs', 'README.md'])).toEqual([
      'javascript', 'python', 'rust',
    ]);
  });

  it('includes nonignored new source files and deduplicates Git path entries', () => {
    expect(selectSecuritySourceFiles([
      'src/existing.ts',
      'src/newly-created.ts',
      'src/existing.ts',
      'README.md',
      '',
    ])).toEqual(['src/existing.ts', 'src/newly-created.ts']);
  });

  it('treats shifted existing findings as a baseline match', () => {
    const baseline = [{ ruleId: 'codeql/js/x', level: 'error' as const, message: 'issue', filePath: 'src/a.ts', line: 2 }];
    const current = [{ ...baseline[0], line: 20 }, { ruleId: 'codeql/js/y', level: 'error' as const, message: 'new', filePath: 'src/b.ts' }];
    expect(securityFindingFingerprint(baseline[0]!)).not.toContain(':2');
    expect(newSecurityFindings(baseline, current)).toEqual([current[1]]);
  });

  it('keeps an additional result with the same stable fingerprint as new', () => {
    const baseline = [{ ruleId: 'codeql/js/x', level: 'error' as const, message: 'issue', filePath: 'src/a.ts', line: 2 }];
    const existingMoved = { ...baseline[0], line: 20 };
    const newlyIntroducedDuplicate = { ...baseline[0], line: 40 };

    expect(newSecurityFindings(baseline, [existingMoved, newlyIntroducedDuplicate]))
      .toEqual([newlyIntroducedDuplicate]);
  });
});

describe('runSecurityAudit', () => {
  it('does not require CodeQL for a disabled or source-free audit', async () => {
    await expect(runSecurityAudit('/repo', ['src/a.ts'], { enabled: false, maxThreads: 2 }))
      .resolves.toEqual({ status: 'disabled', codeqlLanguages: [], skippedCodeqlLanguages: [], findings: [] });
    await expect(runSecurityAudit('/repo', ['README.md'], DEFAULT_SECURITY_AUDIT_CONFIG))
      .resolves.toEqual({ status: 'passed', codeqlLanguages: [], skippedCodeqlLanguages: [], findings: [] });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('fails closed when CodeQL cannot be found on an absolute PATH entry', async () => {
    fsMock.access.mockRejectedValue(new Error('ENOENT'));

    const audit = await runSecurityAudit('/repo', ['src/a.ts']);

    expect(audit).toMatchObject({ status: 'unavailable', codeqlLanguages: ['javascript'] });
    expect(audit.findings[0]?.ruleId).toBe('openswarm/security-codeql-unavailable');
  });

  it('finds CodeQL at OPENSWARM_CODEQL_PATH or /opt/codeql even when PATH is empty', async () => {
    vi.stubEnv('PATH', '');
    vi.stubEnv('OPENSWARM_CODEQL_PATH', '/custom/codeql');
    fsMock.access.mockImplementation(async (target: string) => {
      if (target === '/custom/codeql') return;
      throw new Error('ENOENT');
    });
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });
    fsMock.mkdtemp.mockResolvedValue('/snapshot');
    fsMock.lstat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false });
    fsMock.cp.mockResolvedValue(undefined);
    fsMock.mkdir.mockResolvedValue(undefined);
    fsMock.rm.mockResolvedValue(undefined);
    fsMock.readFile.mockResolvedValue(JSON.stringify({ version: '2.1.0', runs: [{ results: [] }] }));

    const audit = await runSecurityAudit('/repo', ['src/a.ts']);

    expect(audit.status).not.toBe('unavailable');
    expect(execFileMock.mock.calls[0]?.[0]).toBe('/custom/codeql');
  });

  it('reports a query-pack preparation failure and cleans its isolated snapshot', async () => {
    execFileMock.mockRejectedValueOnce(Object.assign(new Error('pack failed'), { code: 1, stderr: 'network unavailable' }));

    const audit = await runSecurityAudit('/repo', ['src/a.ts']);

    expect(audit).toMatchObject({ status: 'failed', codeqlLanguages: ['javascript'] });
    expect(audit.findings[0]?.ruleId).toBe('openswarm/security-codeql-query-pack');
    expect(fsMock.rm).toHaveBeenCalledWith('/snapshot', { recursive: true, force: true });
  });

  it('parses SARIF findings from a no-build database run', async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify({
      version: '2.1.0',
      runs: [{ results: [{
        ruleId: 'js/file-access-to-http',
        message: { text: 'file content reaches an outbound request' },
        locations: [{ physicalLocation: {
          artifactLocation: { uri: 'src/a.ts' }, region: { startLine: 12 },
        } }],
      }] }],
    }));

    const audit = await runSecurityAudit('/repo', ['src/a.ts']);

    expect(audit).toMatchObject({
      status: 'findings',
      codeqlLanguages: ['javascript'],
      findings: [{ ruleId: 'codeql/js/file-access-to-http', filePath: 'src/a.ts', line: 12 }],
    });
    expect(execFileMock.mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining([
      ['pack', 'download', '--', 'codeql/javascript-queries'],
      expect.arrayContaining(['database', 'create']),
      expect.arrayContaining(['database', 'analyze']),
    ]));
  });

  it('preserves contained file URI locations and rejects locations outside the snapshot', async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify({
      version: '2.1.0',
      runs: [{ results: [
        {
          ruleId: 'js/xss-through-dom',
          message: { text: 'contained location' },
          locations: [{ physicalLocation: {
            artifactLocation: { uri: 'file:///snapshot/web/main.js' },
            region: { startLine: 85 },
          } }],
        },
        {
          ruleId: 'js/path-injection',
          message: { text: 'external location' },
          locations: [{ physicalLocation: {
            artifactLocation: { uri: 'file:///etc/passwd' },
            region: { startLine: 1 },
          } }],
        },
      ] }],
    }));

    const audit = await runSecurityAudit('/repo', ['web/main.js']);

    expect(audit.findings).toEqual([
      expect.objectContaining({ filePath: 'web/main.js', line: 85 }),
      expect.objectContaining({ filePath: undefined, line: 1 }),
    ]);
  });

  it('records an exact unsupported none-build response as an explicit coverage skip', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('unsupported build mode'), {
        code: 2,
        stderr: 'Swift does not support the none build mode. Please try using one of the following build modes instead: autobuild, manual.',
      }));

    const audit = await runSecurityAudit('/repo', ['host/App.swift']);

    expect(audit).toMatchObject({
      status: 'partial',
      codeqlLanguages: ['swift'],
      skippedCodeqlLanguages: ['swift'],
      findings: [],
    });
    expect(audit.detail).toContain('build-mode=none: swift');
  });

  it('keeps unrelated database creation failures fail-closed', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('database failed'), {
        code: 1,
        stderr: 'extractor crashed while importing source',
      }));

    const audit = await runSecurityAudit('/repo', ['host/App.swift']);

    expect(audit).toMatchObject({
      status: 'failed',
      skippedCodeqlLanguages: [],
      findings: [{ ruleId: 'openswarm/security-codeql-swift-database' }],
    });
  });

  it('keeps partial coverage visible when another language also has findings', async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify({
      version: '2.1.0',
      runs: [{ results: [{
        ruleId: 'js/xss-through-dom',
        message: { text: 'untrusted data reaches a DOM sink' },
      }] }],
    }));
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('unsupported build mode'), {
        code: 2,
        stderr: 'Swift does not support the none build mode. Please try using one of the following build modes instead: autobuild, manual.',
      }));

    const audit = await runSecurityAudit('/repo', ['web/main.js', 'host/App.swift']);

    expect(audit).toMatchObject({
      status: 'partial',
      codeqlLanguages: ['javascript', 'swift'],
      skippedCodeqlLanguages: ['swift'],
      findings: [{ ruleId: 'codeql/js/xss-through-dom' }],
    });
  });

  it('fails closed when SARIF cannot be parsed', async () => {
    fsMock.readFile.mockResolvedValue('{not json');

    const audit = await runSecurityAudit('/repo', ['src/a.ts']);

    expect(audit).toMatchObject({ status: 'failed' });
    expect(audit.findings[0]?.ruleId).toBe('openswarm/security-codeql-javascript-sarif');
  });

  it('refuses a symbolic-link source before CodeQL can inspect it', async () => {
    fsMock.lstat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => true });

    const audit = await runSecurityAudit('/repo', ['src/a.ts']);

    expect(audit).toMatchObject({ status: 'failed' });
    expect(audit.findings[0]?.message).toContain('refuses non-regular source');
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('listTrackedSecurityFiles', () => {
  it("uses Git's NUL-delimited tracked-and-untracked listing", async () => {
    execFileMock.mockResolvedValue({ stdout: 'src/a.ts\u0000new/b.py\u0000README.md\u0000', stderr: '' });

    await expect(listTrackedSecurityFiles('/repo')).resolves.toEqual(['new/b.py', 'src/a.ts']);
    expect(execFileMock).toHaveBeenCalledWith(
      '/tools/git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });
});

// The audit runs per task, twice (baseline + post-work), so without a cap its
// cost scaled with `maxConcurrentTasks`. Measured on the daemon at 6: two
// overlapping runs held 6.5 GB beside the daemon's own 3.41 GB, the container
// sat pinned at its 4-CPU cap with `memory.peak` at 13.76 of 16 GiB, and the
// single JS thread stalled up to 40s. (AGT-4062)
/** parseSarif requires version 2.1.0 — an omitted version ends the audit in `failed`. */
const EMPTY_SARIF = JSON.stringify({ version: '2.1.0', runs: [{ results: [] }] });

/** A wake-up that never comes should fail the test, not hang the suite. */
function withinTick<T>(promise: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`never resolved: ${what}`)), 100)),
  ]);
}

describe('ConcurrencyGate', () => {
  it('lets callers through up to the limit and makes the next one wait', async () => {
    const gate = new ConcurrencyGate(2);
    await gate.acquire();
    await gate.acquire();
    expect(gate.activeCount).toBe(2);

    let third = false;
    const pending = gate.acquire().then(() => { third = true; });
    await Promise.resolve();
    expect(third).toBe(false);
    expect(gate.waitingCount).toBe(1);

    gate.release();
    await withinTick(pending, 'release did not wake the queued caller');
    expect(third).toBe(true);
  });

  it('serves queued callers in arrival order', async () => {
    const gate = new ConcurrencyGate(1);
    await gate.acquire();
    const order: string[] = [];
    const first = gate.acquire().then(() => { order.push('queued-first'); });
    const second = gate.acquire().then(() => { order.push('queued-second'); });

    gate.release();
    await withinTick(first, 'first queued caller');
    expect(order).toEqual(['queued-first']);
    expect(gate.activeCount).toBe(1);

    gate.release();
    await withinTick(second, 'second queued caller');
    expect(order).toEqual(['queued-first', 'queued-second']);
  });

  it('never lets release drive the active count below zero', () => {
    const gate = new ConcurrencyGate(1);
    gate.release();
    gate.release();
    expect(gate.activeCount).toBe(0);
  });

  it('frees the slot on reset so one leaked hold cannot hang the rest of a file', async () => {
    const gate = new ConcurrencyGate(1);
    await gate.acquire();
    gate.reset();
    await withinTick(gate.acquire(), 'reset did not free the slot');
    expect(gate.activeCount).toBe(1);
  });
});

describe('resolveCodeqlConcurrency', () => {
  // Read once at module load. A bad value must not fail the daemon's start, so
  // anything unusable falls back to the cap the measurement supports.
  it.each([
    ['3', 3],
    ['1', 1],
    ['8', 8],
    [undefined, 1],
    ['', 1],
    ['nonsense', 1],
    ['0', 1],
    ['-2', 1],
    ['9', 1],
    ['2.5', 1],
  ])('resolves %s to %i', (raw, expected) => {
    expect(resolveCodeqlConcurrency(raw as string | undefined)).toBe(expected);
  });
});

describe('runSecurityAudit resource bounds (AGT-4062)', () => {
  it('runs one audit at a time no matter how many callers arrive', { timeout: 3_000 }, async () => {
    // Three concurrent callers, default config. Only the holder may reach
    // CodeQL; the rest must be parked before spawning anything.
    let releaseFirst: (() => void) | undefined;
    const firstCallStarted = new Promise<void>((started) => {
      execFileMock.mockImplementation(() => new Promise((resolve) => {
        started();
        releaseFirst = () => resolve({ stdout: '', stderr: '' });
      }));
    });

    const audits = [
      runSecurityAudit('/repo', ['src/a.ts']),
      runSecurityAudit('/repo', ['src/b.ts']),
      runSecurityAudit('/repo', ['src/c.ts']),
    ];
    await firstCallStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));

    // One `pack download`, from the single audit holding the gate.
    expect(execFileMock).toHaveBeenCalledTimes(1);

    // Let everything drain so the shared gate is not left held for later tests.
    execFileMock.mockImplementation(async () => ({ stdout: '', stderr: '' }));
    releaseFirst?.();
    fsMock.readFile.mockResolvedValue(EMPTY_SARIF);
    await Promise.all(audits);
  });

  it('caps the memory each CodeQL invocation may take', async () => {
    fsMock.readFile.mockResolvedValue(EMPTY_SARIF);
    await runSecurityAudit('/repo', ['src/a.ts']);

    const codeql = execFileMock.mock.calls
      .map((call) => call[1] as string[])
      .filter((args) => args[0] === 'database');
    expect(codeql.length).toBeGreaterThanOrEqual(2); // create + analyze
    for (const args of codeql) {
      expect(args).toContain(`--ram=${DEFAULT_SECURITY_AUDIT_CONFIG.maxRamMb}`);
    }
  });

  it('bounds concurrency per process, not per configured task parallelism', async () => {
    // The bug was exactly this coupling: audit cost tracked maxConcurrentTasks
    // while the container budget stayed fixed. Four callers, one process cap.
    let inFlight = 0;
    let peak = 0;
    execFileMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return { stdout: '', stderr: '' };
    });
    fsMock.readFile.mockResolvedValue(EMPTY_SARIF);

    await Promise.all(['a', 'b', 'c', 'd'].map((n) => runSecurityAudit('/repo', [`src/${n}.ts`])));
    expect(peak).toBe(1);
  });
});

describe('the gate survives a failing snapshot cleanup (AGT-4062)', () => {
  it('returns the slot even when cleanup throws', { timeout: 3_000 }, async () => {
    // `rm` runs with force:true, which swallows ENOENT but not EACCES/EPERM/
    // EBUSY. Before the gate a failed cleanup only leaked a temp directory;
    // with a limit of 1 it would strand the slot and deadlock every later
    // audit in this process.
    fsMock.readFile.mockResolvedValue(EMPTY_SARIF);
    fsMock.rm.mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

    await expect(runSecurityAudit('/repo', ['src/a.ts'])).rejects.toThrow('EACCES');
    expect(codeqlGate.activeCount).toBe(0);

    // The next audit must still be able to start.
    fsMock.rm.mockResolvedValue(undefined);
    await expect(runSecurityAudit('/repo', ['src/b.ts'])).resolves.toMatchObject({ status: 'passed' });
  });
});
